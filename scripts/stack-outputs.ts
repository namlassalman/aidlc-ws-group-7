/**
 * Reads the RosterApp stack outputs (SiteUrl, UserPoolId, Table*, ...) from CloudFormation.
 * Credentials come from the profile in AWS_PROFILE (e.g. `deploy`) and the Region from
 * AWS_REGION, through the SDK's default chain. Used by scripts/seed.ts and scripts/smoke.ts.
 */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

export const STACK_NAME = "RosterApp";

export type StackOutputs = Record<string, string>;

export async function readStackOutputs(stackName = STACK_NAME): Promise<StackOutputs> {
  if (!process.env.AWS_REGION) {
    throw new Error(
      "AWS_REGION is not set: set it to the Region the stack is deployed in (us-west-2 or us-east-1)",
    );
  }
  const client = new CloudFormationClient({ region: process.env.AWS_REGION });
  let stacks;
  try {
    ({ Stacks: stacks } = await client.send(new DescribeStacksCommand({ StackName: stackName })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read stack ${stackName} in ${process.env.AWS_REGION} with profile ${process.env.AWS_PROFILE ?? "(default)"}: ${message}`,
      { cause: error },
    );
  }
  const outputs: StackOutputs = {};
  for (const output of stacks?.[0]?.Outputs ?? []) {
    if (output.OutputKey && output.OutputValue) outputs[output.OutputKey] = output.OutputValue;
  }
  return outputs;
}

/** The named output, or an error naming it (e.g. the stack was deployed from an older commit). */
export function requireOutput(outputs: StackOutputs, key: string): string {
  const value = outputs[key];
  if (!value) throw new Error(`Stack output ${key} is missing: redeploy the stack from main`);
  return value;
}
