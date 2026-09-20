#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { WealthNavigatorStack } from '../lib/wealth-navigator-stack.js';
import { GithubDeployRoleStack } from '../lib/github-deploy-role-stack.js';

/**
 * CDK entrypoint.
 *
 * The stage comes from context so the same definition deploys dev, staging and
 * prod with different retention and removal policies:
 *
 *   npx cdk deploy WealthNavigator-prod -c stage=prod
 *
 * Two stacks live here, so a stack name is required on deploy. The application
 * stack is deployed on every release; the deploy-role stack is a one-off per
 * account and is never touched by the pipeline (it is what grants the pipeline
 * its access in the first place).
 */
const app = new App();

const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const claudeModel = (app.node.tryGetContext('claudeModel') as string | undefined) ?? 'claude-opus-5';
const enableBedrock = app.node.tryGetContext('enableBedrock') !== 'false';

/*
 * `owner/repo` for the OIDC trust policy. The placeholder synthesizes so CI can
 * validate the stack, but it trusts a repository that does not exist - deploying
 * it without passing the real value would create a role nothing can assume.
 */
const githubRepo = (app.node.tryGetContext('githubRepo') as string | undefined) ?? 'OWNER/REPO';
const existingOidcProviderArn = app.node.tryGetContext('oidcProviderArn') as string | undefined;

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

new GithubDeployRoleStack(app, `WealthNavigatorDeployRole-${stage}`, {
  githubRepo,
  stage,
  existingOidcProviderArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
  description: `GitHub Actions OIDC deploy role for AI Wealth Navigator (${stage})`,
});

app.synth();
