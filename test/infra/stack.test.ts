// CDK assertion tests for the RosterApp stack. Synthesised in-process: NodejsFunction bundles
// with the local esbuild (no Docker), and nothing is deployed or read from AWS.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { RosterStack } from "../../infra/roster-stack.js";

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  DeletionPolicy?: string;
};

const ACCOUNT = "123456789012";
const REGION = "us-west-2";
const COGNITO_ORIGIN = `https://roster-${ACCOUNT}.auth.${REGION}.amazoncognito.com`;
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST_HEADER = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

let template: Template;
let resources: Record<string, Resource>;

const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
const onlyOne = (type: string) => {
  const found = ofType(type);
  expect(found, type).toHaveLength(1);
  return found[0];
};

beforeAll(() => {
  const app = new App();
  const stack = new RosterStack(app, "RosterApp", { env: { account: ACCOUNT, region: REGION } });
  template = Template.fromStack(stack);
  resources = template.toJSON().Resources as Record<string, Resource>;
}, 120_000);

describe("API Gateway and the JWT authorizer", () => {
  it("puts the JWT authorizer on every route, $default included, with no ANY /{proxy+} route", () => {
    const routes = ofType("AWS::ApiGatewayV2::Route");
    expect(routes.length).toBeGreaterThan(0);
    const [authorizerId] = onlyOne("AWS::ApiGatewayV2::Authorizer");
    for (const [, route] of routes) {
      expect(route.Properties).toMatchObject({
        AuthorizationType: "JWT",
        AuthorizerId: { Ref: authorizerId },
      });
    }
    const keys = routes.map(([, r]) => r.Properties?.RouteKey);
    expect(keys).toContain("$default");
    expect(keys).not.toContain("ANY /{proxy+}");
  });

  it("checks Cognito access tokens from this user pool for this app client", () => {
    const [poolId] = onlyOne("AWS::Cognito::UserPool");
    const [clientId] = onlyOne("AWS::Cognito::UserPoolClient");
    const [, authorizer] = onlyOne("AWS::ApiGatewayV2::Authorizer");
    expect(authorizer.Properties).toMatchObject({
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      // ProviderURL is https://cognito-idp.<region>.amazonaws.com/<user pool id>.
      JwtConfiguration: {
        Audience: [{ Ref: clientId }],
        Issuer: { "Fn::GetAtt": [poolId, "ProviderURL"] },
      },
    });
  });

  it("has no Lambda function URL", () => {
    template.resourceCountIs("AWS::Lambda::Url", 0);
  });
});

describe("Lambda", () => {
  const apiFunction = () => {
    const found = ofType("AWS::Lambda::Function").filter(
      ([, r]) => r.Properties?.Runtime === "nodejs22.x",
    );
    expect(found).toHaveLength(1);
    return found[0][1].Properties as Record<string, unknown> & {
      Environment: { Variables: Record<string, unknown> };
    };
  };

  it("runs Node.js 22 on arm64 with 1024 MB and 15 s, with the table names and time zone", () => {
    const props = apiFunction();
    expect(props).toMatchObject({
      Architectures: ["arm64"],
      MemorySize: 1024,
      Timeout: 15,
      Handler: "index.handler",
    });
    expect(Object.keys(props.Environment.Variables).sort()).toEqual([
      "ROSTER_TIME_ZONE",
      "TABLE_DOCTORS",
      "TABLE_DUTIES",
      "TABLE_LEAVE",
      "TABLE_ROSTERS",
      "TABLE_RULES",
    ]);
    expect(props.Environment.Variables.ROSTER_TIME_ZONE).toBe("Asia/Singapore");
  });

  it("never gives any function AUTH_TEST_BYPASS", () => {
    for (const [, fn] of ofType("AWS::Lambda::Function")) {
      expect(JSON.stringify(fn.Properties ?? {})).not.toContain("AUTH_TEST_BYPASS");
    }
  });

  it("logs to a one-week log group that is removed with the stack", () => {
    const [, logGroup] = onlyOne("AWS::Logs::LogGroup");
    expect(logGroup.Properties).toMatchObject({ RetentionInDays: 7 });
    expect(logGroup.DeletionPolicy).toBe("Delete");
    template.hasOutput("ApiLogGroupName", {});
  });
});

describe("DynamoDB", () => {
  it("creates the five C1 tables on demand, with their indexes, removed with the stack", () => {
    const tables = ofType("AWS::DynamoDB::Table");
    expect(tables).toHaveLength(5);
    const indexSets: string[][] = [];
    for (const [, table] of tables) {
      expect(table.Properties).toMatchObject({
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      });
      expect(table.Properties?.TableName).toBeUndefined();
      expect(table.DeletionPolicy).toBe("Delete");
      const gsis = (table.Properties?.GlobalSecondaryIndexes ?? []) as {
        IndexName: string;
        Projection: unknown;
      }[];
      for (const gsi of gsis) expect(gsi.Projection).toEqual({ ProjectionType: "ALL" });
      indexSets.push(gsis.map((g) => g.IndexName).sort());
    }
    expect(indexSets.map((s) => s.join(",")).sort()).toEqual([
      "",
      "",
      "",
      "byDate",
      "byDoctor,byStatus",
    ]);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: [
        {
          IndexName: "byDate",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
        },
      ],
    });
  });
});

describe("S3 and CloudFront", () => {
  it("keeps the page bucket private, SSL-only and removed with the stack", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    const policy = JSON.stringify(ofType("AWS::S3::BucketPolicy").map(([, r]) => r.Properties));
    expect(policy).toContain("aws:SecureTransport");
    expect(policy).toContain("cloudfront.amazonaws.com");
    expect(policy).not.toMatch(/"Principal":"\*","Action":"s3:GetObject"/);
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  });

  it("serves index.html at the root and sends /api/* to the API uncached with all methods", () => {
    const [, distribution] = onlyOne("AWS::CloudFront::Distribution");
    const config = distribution.Properties?.DistributionConfig as {
      DefaultRootObject: string;
      DefaultCacheBehavior: Record<string, unknown>;
      CacheBehaviors: Record<string, unknown>[];
    };
    expect(config.DefaultRootObject).toBe("index.html");
    expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(config.CacheBehaviors).toHaveLength(1);
    expect(config.CacheBehaviors[0]).toMatchObject({
      PathPattern: "/api/*",
      AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
      CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
      ViewerProtocolPolicy: "redirect-to-https",
    });
  });

  it("adds a CSP naming the Cognito login origin, plus HSTS, nosniff and the referrer policy", () => {
    const [, headers] = onlyOne("AWS::CloudFront::ResponseHeadersPolicy");
    const security = (
      headers.Properties?.ResponseHeadersPolicyConfig as {
        SecurityHeadersConfig: Record<string, Record<string, unknown>>;
      }
    ).SecurityHeadersConfig;
    const csp = String(security.ContentSecurityPolicy.ContentSecurityPolicy);
    expect(csp).toContain(`connect-src 'self' ${COGNITO_ORIGIN}`);
    expect(csp).toContain(`form-action 'self' ${COGNITO_ORIGIN}`);
    expect(csp).toContain("script-src 'self'");
    expect(security.StrictTransportSecurity).toMatchObject({ AccessControlMaxAgeSec: 31536000 });
    expect(security.ContentTypeOptions).toMatchObject({ Override: true });
    expect(security.ReferrerPolicy).toMatchObject({ ReferrerPolicy: "same-origin" });
  });

  it("deploys web/ and config.json once, invalidating the whole distribution", () => {
    const [, deployment] = onlyOne("Custom::CDKBucketDeployment");
    expect(deployment.Properties).toMatchObject({ DistributionPaths: ["/*"] });
    const [distributionId] = onlyOne("AWS::CloudFront::Distribution");
    const [clientId] = onlyOne("AWS::Cognito::UserPoolClient");
    expect(deployment.Properties?.DistributionId).toEqual({ Ref: distributionId });
    // Two sources: the web/ folder and config.json, whose deploy-time values are the app client
    // id and the distribution's domain (the callback).
    expect(deployment.Properties?.SourceObjectKeys).toHaveLength(2);
    const markers = JSON.stringify(deployment.Properties?.SourceMarkers);
    expect(markers).toContain(`{"Ref":"${clientId}"}`);
    expect(markers).toContain(`["${distributionId}","DomainName"]`);
  });
});

describe("Cognito", () => {
  it("has no self sign-up, the two groups and a public code-flow client", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    const groups = ofType("AWS::Cognito::UserPoolGroup")
      .map(([, g]) => g.Properties?.GroupName)
      .sort();
    expect(groups).toEqual(["coordinator", "doctor"]);
    const [, client] = onlyOne("AWS::Cognito::UserPoolClient");
    expect(client.Properties).toMatchObject({
      AllowedOAuthFlows: ["code"],
      GenerateSecret: false,
      AllowedOAuthFlowsUserPoolClient: true,
    });
    expect(JSON.stringify(client.Properties?.CallbackURLs)).toContain("DomainName");
    expect(JSON.stringify(client.Properties)).not.toContain("localhost");
  });

  it("uses the prefix domain roster-<account> with the newer managed login and its branding", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: `roster-${ACCOUNT}`,
      ManagedLoginVersion: 2,
    });
    template.hasResourceProperties("AWS::Cognito::ManagedLoginBranding", {
      UseCognitoProvidedValues: true,
    });
  });
});

describe("the stack as a whole", () => {
  it("sets no physical names (bucket, table, function, role, log group)", () => {
    const named = ["BucketName", "TableName", "FunctionName", "RoleName", "LogGroupName"];
    // A physical name is a literal string; references to generated names (Ref, GetAtt) are fine.
    for (const [id, resource] of Object.entries(resources)) {
      for (const key of named)
        expect(typeof resource.Properties?.[key], `${id}.${key}`).not.toBe("string");
    }
  });

  it("has the outputs the scripts read", () => {
    const outputs = Object.keys(template.toJSON().Outputs ?? {});
    for (const name of [
      "SiteUrl",
      "UserPoolId",
      "UserPoolClientId",
      "ApiLogGroupName",
      "TableDoctors",
      "TableDuties",
      "TableLeave",
      "TableRules",
      "TableRosters",
    ]) {
      expect(outputs).toContain(name);
    }
  });

  it("has no dependency cycle between resources", () => {
    const ids = new Set(Object.keys(resources));
    const edges = new Map<string, Set<string>>();
    const collect = (value: unknown, into: Set<string>) => {
      if (Array.isArray(value)) value.forEach((v) => collect(v, into));
      else if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        if (typeof obj.Ref === "string" && ids.has(obj.Ref)) into.add(obj.Ref);
        const getAtt = obj["Fn::GetAtt"];
        if (Array.isArray(getAtt) && ids.has(String(getAtt[0]))) into.add(String(getAtt[0]));
        Object.values(obj).forEach((v) => collect(v, into));
      }
    };
    for (const [id, resource] of Object.entries(resources)) {
      const deps = new Set<string>([resource.DependsOn ?? []].flat());
      collect(resource.Properties, deps);
      edges.set(id, deps);
    }
    const state = new Map<string, "visiting" | "done">();
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === "done") return;
      if (state.get(id) === "visiting")
        throw new Error(`Dependency cycle: ${[...trail, id].join(" -> ")}`);
      state.set(id, "visiting");
      for (const dep of edges.get(id) ?? []) visit(dep, [...trail, id]);
      state.set(id, "done");
    };
    expect(() => ids.forEach((id) => visit(id, []))).not.toThrow();
  });
});
