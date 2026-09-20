#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { WealthNavigatorStack } from '../lib/wealth-navigator-stack.js';

/**
 * CDK entrypoint.
 *
 * The stage comes from context so the same definition deploys dev, staging and
 * prod with different retention and removal policies:
 *
 *   npx cdk deploy -c stage=prod
 */
const app = new App();

const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const claudeModel = (app.node.tryGetContext('claudeModel') as string | undefined) ?? 'claude-opus-5';
const enableBedrock = app.node.tryGetContext('enableBedrock') !== 'false';

new WealthNavigatorStack(app, `WealthNavigator-${stage}`, {
  stage,
  claudeModel,
  enableBedrock,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Bedrock model availability is regional - check your region before
    // deploying, and override with AWS_REGION if Claude is not enabled there.
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
  description: `AI Wealth Navigator (${stage}) - agentic financial wellness platform`,
});

app.synth();
