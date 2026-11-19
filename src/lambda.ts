/**
 * The Lambda handler: the whole Express app behind API Gateway HTTP API, through serverless-http.
 * Bundled by NodejsFunction (esbuild, CommonJS) in infra/roster-stack.ts; no top-level await.
 * Importing app.ts loads src/shared/auth.ts, whose guard refuses to start when AUTH_TEST_BYPASS
 * is set inside Lambda. The app (and its DynamoDB client) is built once per container.
 */
import serverless from "serverless-http";
import { buildApp } from "./app.js";

export const handler = serverless(buildApp());
