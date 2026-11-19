// DynamoDB mode of the table helpers, offline: aws-sdk-client-mock stubs the DocumentClient with a
// small fake that interprets the commands db.ts builds, so the shared contract suite runs here too.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DeleteCommandInput,
  type GetCommandInput,
  type PutCommandInput,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { getItem, putItem, query } from "../../src/shared/db.js";
import { ConflictError } from "../../src/shared/errors.js";
import { runDbContract } from "./db.contract.js";

type Row = Record<string, unknown>;

const ddb = mockClient(DynamoDBDocumentClient);
const tables = new Map<string, Map<string, Row>>();
const PAGE_SIZE = 2;

const rowId = (key: Row) => `${String(key.pk)}\u0000${String(key.sk)}`;

function table(name: string | undefined): Map<string, Row> {
  const key = name ?? "";
  if (!tables.has(key)) tables.set(key, new Map());
  return tables.get(key)!;
}

function compare(a: unknown, b: unknown): number {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Evaluates the two KeyConditionExpression shapes db.ts produces. */
function fakeQuery(input: QueryCommandInput) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = (input.ExpressionAttributeValues ?? {}) as Record<string, string>;
  const expression = input.KeyConditionExpression ?? "";
  const pkAttr = names["#pk"];
  const skAttr = names["#sk"];
  let rows = [...table(input.TableName).values()].filter((row) => row[pkAttr] === values[":pk"]);
  if (expression.includes("BETWEEN")) {
    rows = rows.filter((row) => {
      const sk = String(row[skAttr]);
      return sk >= values[":skFrom"] && sk <= values[":skTo"];
    });
  } else if (expression.includes("begins_with")) {
    rows = rows.filter((row) => String(row[skAttr]).startsWith(values[":skPrefix"]));
  }
  const sortAttr = skAttr ?? (input.IndexName ? "gsi1sk" : "sk");
  rows.sort(
    (a, b) => compare(a[sortAttr], b[sortAttr]) || compare(a.pk, b.pk) || compare(a.sk, b.sk),
  );
  const start = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.offset) : 0;
  const page = rows.slice(start, start + PAGE_SIZE).map((row) => structuredClone(row));
  const next = start + PAGE_SIZE < rows.length ? { offset: start + PAGE_SIZE } : undefined;
  return { Items: page, LastEvaluatedKey: next };
}

function installFake(): void {
  ddb.reset();
  ddb.on(GetCommand).callsFake((input: GetCommandInput) => {
    const row = table(input.TableName).get(rowId(input.Key as Row));
    return { Item: row ? structuredClone(row) : undefined };
  });
  ddb.on(PutCommand).callsFake((input: PutCommandInput) => {
    const rows = table(input.TableName);
    const id = rowId(input.Item as Row);
    if (input.ConditionExpression === "attribute_not_exists(pk)" && rows.has(id)) {
      throw new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      });
    }
    rows.set(id, structuredClone(input.Item as Row));
    return {};
  });
  ddb.on(DeleteCommand).callsFake((input: DeleteCommandInput) => {
    table(input.TableName).delete(rowId(input.Key as Row));
    return {};
  });
  ddb.on(QueryCommand).callsFake(fakeQuery);
}

beforeAll(() => {
  process.env.AWS_REGION ??= "us-west-2";
});

beforeEach(() => {
  process.env.DB_MODE = "dynamodb";
  tables.clear();
  installFake();
});

afterAll(() => {
  process.env.DB_MODE = "memory";
  ddb.restore();
});

runDbContract("dynamodb, mocked");

describe("DynamoDB mode specifics", () => {
  it("sends attribute_not_exists(pk) for ifNotExists and maps the condition failure to ConflictError", async () => {
    await putItem("doctors", { pk: "DOCTOR", sk: "asha.rao" }, { ifNotExists: true });
    const put = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(put.ConditionExpression).toBe("attribute_not_exists(pk)");
    const error = await putItem(
      "doctors",
      { pk: "DOCTOR", sk: "asha.rao" },
      { ifNotExists: true },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).cause).toBeInstanceOf(ConditionalCheckFailedException);
  });

  it("sends no condition on a plain put", async () => {
    await putItem("doctors", { pk: "DOCTOR", sk: "x" });
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.ConditionExpression).toBeUndefined();
  });

  it("builds an index query with BETWEEN and follows every page", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) {
      await putItem("duties", {
        pk: "DUTY",
        sk: id,
        gsi1pk: "DUTY",
        gsi1sk: `2026-12-07#08#${id}`,
      });
    }
    const rows = await query("duties", {
      index: "byDate",
      pk: "DUTY",
      skBetween: ["2026-12-07", "2026-12-07#~"],
    });
    expect(rows.map((r) => r.sk)).toEqual(["a", "b", "c", "d", "e"]);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(3);
    expect(calls[0].args[0].input).toMatchObject({
      TableName: "duties",
      IndexName: "byDate",
      KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :skFrom AND :skTo",
      ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
    });
  });

  it("wraps other SDK errors with the table and operation named and keeps the cause", async () => {
    const cause = new Error("Requested resource not found");
    ddb.on(GetCommand).rejects(cause);
    const error = await getItem("doctors", { pk: "DOCTOR", sk: "x" }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("doctors getItem failed: Requested resource not found");
    expect((error as Error).cause).toBe(cause);
    expect(error).not.toBeInstanceOf(ConflictError);
  });
});
