import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GithubDeployRoleStackProps extends StackProps {
  /** `owner/repo`, e.g. `piyushp69/ai-wealth-navigator`. */
  githubRepo: string;
  /** Stage this role is allowed to deploy. One role per stage keeps blast radius small. */
  stage: string;
  /**
   * Branches allowed to assume the role. A deploy can only be triggered from
   * one of these refs or from the matching GitHub Environment.
   */
  allowedBranches?: string[];
  /**
   * ARN of an existing GitHub OIDC provider. An AWS account may only have one
   * provider per issuer URL, so a second account-wide provider fails to create.
   * Pass this when the account already has one; leave unset to create it.
   */
  existingOidcProviderArn?: string;
  /** CDK bootstrap qualifier. Only change this if the account was bootstrapped with a custom one. */
  bootstrapQualifier?: string;
}

/**
 * The IAM role GitHub Actions assumes to deploy, defined as code.
 *
 * Two things make this least-privilege rather than the AdministratorAccess role
 * most pipelines end up with:
 *
 *  1. **Trust is pinned to one repository, one stage and named branches.** The
 *     `sub` condition means a workflow in any other repo - or on a fork, or on
 *     an arbitrary branch of this repo - cannot mint credentials, even though
 *     the OIDC issuer is public. Without the `sub` condition an OIDC trust
 *     policy is effectively open to all of GitHub, which is the single most
 *     common way this pattern is got wrong.
 *  2. **The role itself can do almost nothing.** It carries no CloudFormation,
 *     S3, Lambda or DynamoDB permission at all. All it may do is assume the CDK
 *     bootstrap roles, which are already scoped by the bootstrap stack, and read
 *     the bootstrap version parameter. The deploy therefore runs with exactly
 *     the permissions `cdk bootstrap` provisioned - no more - and revoking a
 *     pipeline's access is one role deletion rather than a policy audit.
 *
 * Deployed separately from the application stack and only once per account:
 *
 *   npx cdk deploy WealthNavigatorDeployRole-<stage> \
 *     -c githubRepo=<owner>/<repo> -c stage=<stage>
 */
export class GithubDeployRoleStack extends Stack {
  public readonly roleArn: string;

  constructor(scope: Construct, id: string, props: GithubDeployRoleStackProps) {
    super(scope, id, props);

    const {
      githubRepo,
      stage,
      allowedBranches = ['main'],
      existingOidcProviderArn,
      bootstrapQualifier = 'hnb659fds',
    } = props;

    const provider = existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidcProvider',
          existingOidcProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
          url: 'https://token.actions.githubusercontent.com',
          // The only audience GitHub's official credentials action requests.
          clientIds: ['sts.amazonaws.com'],
        });

    /*
     * Every `sub` GitHub can present that we are willing to trust. `ref:` covers
     * a push-triggered deploy on a named branch; `environment:` covers a manual
     * `workflow_dispatch` that runs against the stage's GitHub Environment,
     * which is where a required-reviewer gate would sit.
     */
    const allowedSubjects = [
      ...allowedBranches.map((branch) => `repo:${githubRepo}:ref:refs/heads/${branch}`),
      `repo:${githubRepo}:environment:${stage}`,
    ];

    const role = new iam.Role(this, 'DeployRole', {
      roleName: `wealth-navigator-deploy-${stage}`,
      description: `GitHub Actions deploy role for ${githubRepo} (${stage}) - assumes the CDK bootstrap roles only`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': allowedSubjects,
        },
      }),
    });

    /*
     * The CDK bootstrap roles. `cdk deploy` assumes these; it does not use the
     * calling identity's own permissions for anything but the assume itself.
     */
    const bootstrapRoles = [
      'deploy-role',
      'file-publishing-role',
      'lookup-role',
      'image-publishing-role',
    ].map(
      (name) =>
        `arn:${this.partition}:iam::${this.account}:role/cdk-${bootstrapQualifier}-${name}-${this.account}-${this.region}`,
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: bootstrapRoles,
      }),
    );

    // `cdk deploy` reads the bootstrap version before it does anything else; a
    // denial here produces a confusing "has the environment been bootstrapped?"
    // error rather than an access-denied one.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadBootstrapVersion',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/${bootstrapQualifier}/version`,
        ],
      }),
    );

    this.roleArn = role.roleArn;

    new CfnOutput(this, 'DeployRoleArn', {
      value: role.roleArn,
      description: 'Set this as the AWS_DEPLOY_ROLE_ARN repository secret in GitHub',
    });
    new CfnOutput(this, 'TrustedSubjects', {
      value: allowedSubjects.join(' , '),
      description: 'The only GitHub OIDC subjects this role will trust',
    });
  }
}
