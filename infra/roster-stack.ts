/**
 * The whole RosterApp stack (walking skeleton; infrastructure-specification.md). Feature Units
 * never edit this file. One stack, one environment, in the deploy profile's account and Region.
 *
 *   CloudFront --(default)--> private S3 bucket (OAC) holding web/ + generated config.json
 *              --(/api/*)---> API Gateway HTTP API --(JWT authorizer, $default route)--> Lambda
 *   Lambda (Express via serverless-http) --(IAM grantReadWriteData)--> five DynamoDB tables (C1)
 *   Cognito user pool, groups coordinator and doctor, prefix domain roster-<account>
 *
 * Workshop limits (technical-environment.md section 4): no physical names except the Cognito
 * domain prefix; every resource is removed by `cdk destroy`; NodejsFunction bundles with local
 * esbuild (no Docker); the Lambda never gets AUTH_TEST_BYPASS; no Lambda function URL; the bucket
 * is never public; every /api/* request passes the JWT authorizer.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { AttributeType, BillingMode, ProjectionType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import {
  INDEX_KEYS,
  TABLE_ENV,
  TABLE_INDEXES,
  TABLE_NAMES,
  type TableName,
} from "../src/shared/tables.js";
import { DEFAULT_TIME_ZONE } from "../src/shared/time.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The Content-Security-Policy for the page; `cognitoOrigin` is the managed login origin. */
export function pageCsp(cognitoOrigin: string): string {
  return [
    "default-src 'self'",
    `connect-src 'self' ${cognitoOrigin}`,
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action 'self' ${cognitoOrigin}`,
  ].join("; ");
}

export class RosterStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const tables = this.createTables();
    const api = this.createApi(tables);
    const auth = this.createSignIn();

    // The HTTP API checks every route ($default included) with the Cognito JWT authorizer.
    // Access tokens carry client_id, which API Gateway matches against the audience.
    const httpApi = new HttpApi(this, "HttpApi", {
      description:
        "RosterApp API: every route goes to the Express Lambda through the JWT authorizer",
      defaultIntegration: new HttpLambdaIntegration("ApiIntegration", api.fn),
      defaultAuthorizer: new HttpJwtAuthorizer("CognitoJwt", auth.userPool.userPoolProviderUrl, {
        jwtAudience: [auth.client.userPoolClientId],
      }),
    });

    const site = this.createSite(httpApi, auth.cognitoOrigin);

    // The app client's callback and logout URL is the site; the page reads them from config.json.
    const cfnClient = auth.client.node.defaultChild as cognito.CfnUserPoolClient;
    cfnClient.callbackUrLs = [site.siteUrl];
    cfnClient.logoutUrLs = [site.siteUrl];

    new BucketDeployment(this, "PageDeployment", {
      sources: [
        Source.asset(path.join(ROOT, "web")),
        Source.jsonData("config.json", {
          authDomain: auth.cognitoOrigin,
          clientId: auth.client.userPoolClientId,
          redirectUri: site.siteUrl,
          logoutUri: site.siteUrl,
        }),
      ],
      destinationBucket: site.bucket,
      distribution: site.distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "SiteUrl", { value: site.siteUrl });
    new CfnOutput(this, "UserPoolId", { value: auth.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: auth.client.userPoolClientId });
    new CfnOutput(this, "ApiLogGroupName", { value: api.logGroup.logGroupName });
    for (const name of TABLE_NAMES) {
      new CfnOutput(this, `Table${pascal(name)}`, { value: tables[name].tableName });
    }
  }

  /** The five tables of contract C1: string pk/sk, on demand, with exactly their indexes. */
  private createTables(): Record<TableName, Table> {
    const tables = {} as Record<TableName, Table>;
    for (const name of TABLE_NAMES) {
      const table = new Table(this, `${pascal(name)}Table`, {
        partitionKey: { name: "pk", type: AttributeType.STRING },
        sortKey: { name: "sk", type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      for (const indexName of TABLE_INDEXES[name]) {
        const keys = INDEX_KEYS[indexName];
        table.addGlobalSecondaryIndex({
          indexName,
          partitionKey: { name: keys.pk, type: AttributeType.STRING },
          sortKey: { name: keys.sk, type: AttributeType.STRING },
          projectionType: ProjectionType.ALL,
        });
      }
      tables[name] = table;
    }
    return tables;
  }

  /** The one Lambda running the whole Express app, with read/write on the five tables only. */
  private createApi(tables: Record<TableName, Table>) {
    const logGroup = new LogGroup(this, "ApiLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const environment: Record<string, string> = { ROSTER_TIME_ZONE: DEFAULT_TIME_ZONE };
    for (const name of TABLE_NAMES) environment[TABLE_ENV[name]] = tables[name].tableName;

    const fn = new NodejsFunction(this, "Api", {
      description: "RosterApp Express API (serverless-http)",
      entry: path.join(ROOT, "src", "lambda.ts"),
      handler: "handler",
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, "package-lock.json"),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      // 20 s: the roster stops a slow run at a 15 s soft cut-off and needs time left to answer 409.
      timeout: Duration.seconds(20),
      logGroup,
      environment,
      bundling: {
        format: OutputFormat.CJS,
        target: "node22",
        minify: true,
        sourceMap: false,
        forceDockerBundling: false,
        // Bundle the DynamoDB clients too, so the deployed SDK is the version the tests use.
        externalModules: [],
      },
    });
    for (const name of TABLE_NAMES) tables[name].grantReadWriteData(fn);
    return { fn, logGroup };
  }

  /** Cognito: no self sign-up, username sign-in, two groups, a public PKCE app client. */
  private createSignIn() {
    const userPool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const groupName of ["coordinator", "doctor"]) {
      new cognito.UserPoolGroup(this, `${pascal(groupName)}Group`, { userPool, groupName });
    }
    // Placeholder callback: replaced with the site URL once the distribution exists.
    const client = userPool.addClient("WebClient", {
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: ["https://localhost/"],
        logoutUrls: ["https://localhost/"],
      },
    });
    const domainPrefix = `roster-${this.account}`;
    userPool.addDomain("LoginDomain", {
      cognitoDomain: { domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    // The newer managed login shows an error page without a branding for the client.
    new cognito.CfnManagedLoginBranding(this, "LoginBranding", {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    const cognitoOrigin = `https://${domainPrefix}.auth.${this.region}.amazoncognito.com`;
    return { userPool, client, cognitoOrigin };
  }

  /** Private bucket and CloudFront: the page by default, /api/* to the HTTP API uncached. */
  private createSite(httpApi: HttpApi, cognitoOrigin: string) {
    const bucket = new Bucket(this, "PageBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const pageCachePolicy = new cloudfront.CachePolicy(this, "PageCachePolicy", {
      comment: "RosterApp page: short cache, invalidated on every deploy",
      defaultTtl: Duration.minutes(5),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const pageHeaders = new cloudfront.ResponseHeadersPolicy(this, "PageHeaders", {
      comment: "RosterApp page security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: pageCsp(cognitoOrigin), override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(31_536_000),
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
          override: true,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      },
    });
    const distribution = new cloudfront.Distribution(this, "Site", {
      comment: "RosterApp page and API",
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: pageCachePolicy,
        responseHeadersPolicy: pageHeaders,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    });
    const siteUrl = `https://${distribution.distributionDomainName}/`;
    return { bucket, distribution, siteUrl };
  }
}
