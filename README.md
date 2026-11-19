# Radiology Roster

A small web application that replaces a radiology department's duty-roster
spreadsheet. The roster coordinator keeps the list of doctors, sets up the
duties that need cover, decides leave requests and sets the rules the roster
must follow; the application then generates the roster for a four-week period,
which the coordinator reviews and publishes. Doctors request leave and see
their own duties. See [`vision.md`](vision.md) for the full description.

Built by group 7 at an AI-DLC workshop. This repository is a snapshot of the
group's landed `main` with all six Units (skeleton, doctors, duties, leave, rules and roster); the
team's split of the work is in [`unit_split.md`](unit_split.md).

## Stack

TypeScript on Node.js 22. API: Express 5 in one AWS Lambda behind API Gateway
HTTP API. Data: DynamoDB, one table per feature. Sign-in: Amazon Cognito
(`coordinator` and `doctor` groups). Page: plain HTML and JavaScript on S3 +
CloudFront. Infrastructure: AWS CDK v2, one stack named `RosterApp`. Tests:
Vitest with Supertest on in-memory tables.

## Run it locally

No AWS account is needed to run or test locally.

```bash
npm install
npm start        # local server on 127.0.0.1:3000, in-memory tables
npm test         # every test, no AWS needed
```

Locally there is no Cognito; identify yourself with headers (accepted only
when `AUTH_TEST_BYPASS=1`, never on the deployed Lambda):

```bash
curl -H 'X-User-Id: coord1' -H 'X-User-Role: coordinator' http://127.0.0.1:3000/api/doctors
```

## Commands

| Command | What it does |
|---|---|
| `npm start` | Local server on `127.0.0.1:3000` (set `PORT` to change) |
| `npm test` | Vitest and Supertest on the in-memory tables |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run seed` | Loads the example data into the deployed tables |
| `npm run smoke` | Checks the deployed page loads and `/api/*` without a token gets 401 |
| `npx cdk deploy` | Deploys the `RosterApp` stack |

## Layout

| Path | Contents |
|---|---|
| `src/app.ts`, `src/server.ts`, `src/lambda.ts` | The Express app, the local server and the Lambda handler |
| `src/shared/` | Auth and error middleware, table definitions and helpers (DynamoDB and in-memory), rule checker |
| `src/features/<feature>/` | Each feature's router (validation, role checks), service and repository |
| `web/` | The roster page |
| `infra/` | The CDK stack |
| `scripts/` | Seed and smoke scripts |
| `test/` | Tests, one folder per feature plus shared and infra tests |
