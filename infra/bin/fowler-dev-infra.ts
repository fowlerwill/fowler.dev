#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FowlerDevStack } from '../lib/fowler-dev-stack';

const app = new cdk.App();
new FowlerDevStack(app, 'FowlerDevStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
