/**
 * CDK app: one stack, RosterApp, in the account and Region of the CLI profile
 * (`npx cdk deploy --profile deploy`). No Region is fixed here. Never run `cdk bootstrap`:
 * the workshop account is already bootstrapped.
 */
import { App } from "aws-cdk-lib";
import { RosterStack } from "./roster-stack.js";

const app = new App();

new RosterStack(app, "RosterApp", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: "Radiology roster workshop app (walking skeleton and feature Units)",
});
