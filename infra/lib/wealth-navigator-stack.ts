import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export interface WealthNavigatorStackProps extends StackProps {
  /** `dev`, `staging` or `prod`. Drives retention, log level and removal policy. */
  stage: string;
  /** First-party Claude model id. The Bedrock client adds the `anthropic.` prefix. */
  claudeModel?: string;
  /** Set false to deploy with the deterministic engine and no Bedrock permission. */
  enableBedrock?: boolean;
}

/**
 * AI Wealth Navigator - serverless stack.
 *
 *   CloudFront ──┬── S3 (React bundle, private via OAC)
 *                └── /api/* ──► HTTP API ──► Lambda ──┬── DynamoDB
 *                                                     └── Bedrock (Claude)
 *
 * Three decisions worth stating:
 *
 *  1. **One CloudFront distribution serves both the app and the API.** The
 *     browser therefore sees a single origin: no CORS preflight on every call,
 *     no API URL baked into the bundle at build time, and the SSE stream is not
 *     crossing origins.
 *  2. **No API key anywhere.** Claude is reached through Bedrock using the
 *     Lambda execution role, so there is no secret to store, rotate or leak.
 *     Dropping `enableBedrock` removes the permission and the platform falls
 *     back to its deterministic engine rather than failing.
 *  3. **Lambda, not Fargate.** The workload is bursty and request-shaped, the
 *     bundle is a single 230 KB file, and a Monte Carlo run is milliseconds of
 *     CPU. Paying for an idle container would buy nothing.
 */
export class WealthNavigatorStack extends Stack {
  constructor(scope: Construct, id: string, props: WealthNavigatorStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const isProd = stage === 'prod';

    Tags.of(this).add('Application', 'ai-wealth-navigator');
    Tags.of(this).add('Stage', stage);
    Tags.of(this).add('ManagedBy', 'cdk');

    /* ---------------------------------------------------------------------- */
    /* Data                                                                   */
    /* ---------------------------------------------------------------------- */

    /*
     * Single-table design:
     *   pk = PROFILE#<id>, sk = meta          -> the profile
     *   pk = PROFILE#<id>, sk = SESSION#<id>  -> a chat session
     *
     * Sessions share their profile's partition, so listing a user's history is
     * one query and deleting a profile takes its conversations with it.
     */
    const table = new dynamodb.Table(this, 'DataTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      // Traffic is spiky and unpredictable; on-demand avoids both throttling
      // and paying for provisioned capacity nobody is using.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      // Demonstration data should not accumulate forever. The server writes no
      // `ttl` attribute today, so nothing expires until it does - the attribute
      // is declared so that becomes a one-line change.
      timeToLiveAttribute: 'ttl',
    });

    // Lets the API list profiles and look a session up by id without a scan.
    table.addGlobalSecondaryIndex({
      indexName: 'byType',
      partitionKey: { name: 'type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /* ---------------------------------------------------------------------- */
    /* API                                                                    */
    /* ---------------------------------------------------------------------- */

    const apiLogGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const apiFunction = new lambda.Function(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, // ~20% cheaper per ms than x86
      handler: 'lambda.handler',
      // tsup emits a single bundled file, so the asset is the dist directory
      // as-is - no bundling step inside CDK and no node_modules to ship.
      code: lambda.Code.fromAsset(path.join(repoRoot, 'packages', 'server', 'dist')),
      memorySize: 1024, // CPU scales with memory; the Monte Carlo is CPU-bound
      timeout: Duration.seconds(60), // agent runs are multi-step and can stream
      logGroup: apiLogGroup,
      environment: {
        NODE_ENV: 'production',
        TABLE_NAME: table.tableName,
        STAGE: stage,
        CLAUDE_MODEL: props.claudeModel ?? 'claude-opus-5',
        ENABLE_BEDROCK: String(props.enableBedrock ?? true),
        LOG_LEVEL: isProd ? 'info' : 'debug',
        MAX_AGENT_STEPS: '6',
        SIMULATION_PATHS: '2000',
        // Same-origin through CloudFront, so no cross-origin allowance is needed.
        CORS_ORIGINS: '*',
      },
      // A brand-new plan should not be computed twice because the first request
      // timed out on a cold start.
      tracing: lambda.Tracing.ACTIVE,
    });

    table.grantReadWriteData(apiFunction);

    /*
     * Bedrock access.
     *
     * Scoped to Claude foundation models rather than `*`: the function has no
     * business invoking any other model, and an over-broad grant here would be
     * the single largest security smell in the stack.
     */
    if (props.enableBedrock ?? true) {
      apiFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:${this.region}::foundation-model/anthropic.*`,
            // Cross-region inference profiles carry the account id.
            `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
          ],
        }),
      );
    }

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      description: `AI Wealth Navigator API (${stage})`,
      // CloudFront is the only intended caller, but the permissive setting keeps
      // a direct API URL usable for curl and integration tests.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['content-type', 'authorization'],
        maxAge: Duration.days(1),
      },
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration('ApiIntegration', apiFunction, {
        // The whole Express app is behind one proxy route, so payload format 2.0
        // and a single integration is all that is required.
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    /* ---------------------------------------------------------------------- */
    /* Web delivery                                                           */
    /* ---------------------------------------------------------------------- */

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      // Private: CloudFront reaches it through Origin Access Control, so the
      // bucket is never public and there is no website-endpoint to leak.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      versioned: isProd,
    });

    /*
     * Hashed assets are immutable and cached for a year; index.html must never
     * be cached, or a deploy leaves browsers pinned to a stale bundle that
     * references asset names the new deploy has already deleted.
     */
    const immutableAssets = new cloudfront.CachePolicy(this, 'AssetCachePolicy', {
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const noStore = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      minTtl: Duration.seconds(0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `AI Wealth Navigator (${stage})`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: noStore,
        compress: true,
      },
      additionalBehaviors: {
        '/assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: immutableAssets,
          compress: true,
        },
        /*
         * The API on the same origin. Two settings matter here:
         *  - CACHING_DISABLED, because every response is user-specific.
         *  - ALL_VIEWER_EXCEPT_HOST_HEADER, because API Gateway rejects a
         *    forwarded Host header that does not match its own domain.
         */
        '/api/*': {
          origin: new origins.HttpOrigin(
            `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`,
            { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY },
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
      /*
       * The React app is a single-page app with client-side routing, so a hard
       * refresh on /dashboard asks S3 for a key that does not exist. Rewriting
       * 403/404 to index.html hands those paths to the router instead of a
       * CloudFront error page.
       */
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
      ],
      priceClass: isProd
        ? cloudfront.PriceClass.PRICE_CLASS_ALL
        : cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: isProd,
      // `minimumProtocolVersion` is deliberately omitted: it has no effect
      // without a custom certificate, and setting it on the default CloudFront
      // certificate would imply a TLS floor that is not actually enforced.
      // Attach an ACM certificate for a custom domain and set it there.
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(repoRoot, 'packages', 'web', 'dist'))],
      destinationBucket: siteBucket,
      distribution,
      // Only index.html needs invalidating; the asset paths are content-hashed,
      // so a narrow invalidation avoids paying for a wildcard on every deploy.
      distributionPaths: ['/index.html', '/'],
      prune: true,
      memoryLimit: 512,
    });

    /* ---------------------------------------------------------------------- */
    /* Outputs                                                                */
    /* ---------------------------------------------------------------------- */

    new CfnOutput(this, 'AppUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Open this - the app and its API are both served from here',
    });
    new CfnOutput(this, 'ApiUrl', {
      value: `https://${distribution.distributionDomainName}/api`,
      description: 'API base URL (same origin as the app)',
    });
    new CfnOutput(this, 'DirectApiUrl', {
      value: httpApi.url ?? httpApi.apiEndpoint,
      description: 'API Gateway URL, bypassing CloudFront - useful for curl and smoke tests',
    });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'Needed by the CI/CD pipeline to invalidate the cache',
    });
    new CfnOutput(this, 'LambdaFunctionName', { value: apiFunction.functionName });
  }
}
