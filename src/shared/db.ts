/**
 * Table helpers (TableAccess): the only database code feature Units call.
 *
 *   getItem(table, key)                      -> the item, or undefined
 *   putItem(table, item, { ifNotExists })    -> writes the whole item; with ifNotExists an
 *                                               existing item throws ConflictError
 *   deleteItem(table, key)                   -> removes the item (no error when it is absent)
 *   query(table, { pk, skBetween?, skBeginsWith?, index? })
 *                                            -> every matching item, ordered by the sort key
 *
 * Two modes, chosen on every call by DB_MODE: `memory` (tests and `npm start`) keeps the tables
 * in process; anything else uses the DynamoDB DocumentClient with the Lambda's IAM role.
 * Both modes pass the same contract test suite (test/shared/db.contract.ts).
 * DynamoDB errors are wrapped as "<table> <operation> failed: <message>" with the cause kept.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ConflictError } from "./errors.js";
import { log } from "./log.js";
import { INDEX_KEYS, type IndexName, type Key } from "./tables.js";

export type Item = Record<string, unknown>;

export type PutOptions = { ifNotExists?: boolean };

export type QuerySpec = {
  pk: string;
  /** Inclusive range on the sort key: [from, to]. */
  skBetween?: [string, string];
  skBeginsWith?: string;
  index?: IndexName;
};

/** Items over this size log a warning (DynamoDB refuses items over 400 KB). */
export const ITEM_SIZE_WARNING_BYTES = 300 * 1024;

const isMemoryMode = () => process.env.DB_MODE === "memory";

// ---------------------------------------------------------------------------------------------
// Validation shared by both modes
// ---------------------------------------------------------------------------------------------

function assertKey(table: string, operation: string, key: Partial<Key>): asserts key is Key {
  if (typeof key.pk !== "string" || key.pk === "" || typeof key.sk !== "string" || key.sk === "") {
    throw new Error(`${table} ${operation} failed: pk and sk must be non-empty strings`);
  }
}

function assertQuery(table: string, spec: QuerySpec): void {
  if (typeof spec.pk !== "string" || spec.pk === "") {
    throw new Error(`${table} query failed: pk must be a non-empty string`);
  }
  if (spec.skBetween && spec.skBeginsWith !== undefined) {
    throw new Error(`${table} query failed: use skBetween or skBeginsWith, not both`);
  }
  if (spec.index && !(spec.index in INDEX_KEYS)) {
    throw new Error(`${table} query failed: unknown index ${spec.index}`);
  }
}

function warnIfLarge(table: string, item: Item): void {
  const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
  if (bytes > ITEM_SIZE_WARNING_BYTES) {
    log("warn", "large item", { table, pk: item.pk, sk: item.sk, bytes });
  }
}

function keyAttributes(index: IndexName | undefined): { pk: string; sk: string } {
  return index ? INDEX_KEYS[index] : { pk: "pk", sk: "sk" };
}

// ---------------------------------------------------------------------------------------------
// In-memory mode
// ---------------------------------------------------------------------------------------------

const memoryTables = new Map<string, Map<string, Item>>();

const memoryId = (key: Key) => `${key.pk}\u0000${key.sk}`;

function memoryTable(table: string): Map<string, Item> {
  let rows = memoryTables.get(table);
  if (!rows) {
    rows = new Map();
    memoryTables.set(table, rows);
  }
  return rows;
}

/** Empties every in-memory table. For tests (test/setup.ts calls it before each test). */
export function resetMemoryTables(): void {
  memoryTables.clear();
}

function matchesSortKey(value: unknown, spec: QuerySpec): boolean {
  if (typeof value !== "string") return false;
  if (spec.skBetween) return value >= spec.skBetween[0] && value <= spec.skBetween[1];
  if (spec.skBeginsWith !== undefined) return value.startsWith(spec.skBeginsWith);
  return true;
}

function compareStrings(a: unknown, b: unknown): number {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function memoryQuery(table: string, spec: QuerySpec): Item[] {
  const attrs = keyAttributes(spec.index);
  const rows = [...memoryTable(table).values()].filter(
    (item) => item[attrs.pk] === spec.pk && matchesSortKey(item[attrs.sk], spec),
  );
  rows.sort(
    (a, b) =>
      compareStrings(a[attrs.sk], b[attrs.sk]) ||
      compareStrings(a.pk, b.pk) ||
      compareStrings(a.sk, b.sk),
  );
  return rows.map((item) => structuredClone(item));
}

// ---------------------------------------------------------------------------------------------
// DynamoDB mode
// ---------------------------------------------------------------------------------------------

let documentClient: DynamoDBDocumentClient | undefined;

/** One client per container, created on first use (outside the request path after warm-up). */
function client(): DynamoDBDocumentClient {
  documentClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return documentClient;
}

function wrap(table: string, operation: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${table} ${operation} failed: ${message}`, { cause: error });
}

function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function buildQueryInput(table: string, spec: QuerySpec): QueryCommandInput {
  const attrs = keyAttributes(spec.index);
  const names: Record<string, string> = { "#pk": attrs.pk };
  const values: Record<string, unknown> = { ":pk": spec.pk };
  let condition = "#pk = :pk";
  if (spec.skBetween) {
    names["#sk"] = attrs.sk;
    values[":skFrom"] = spec.skBetween[0];
    values[":skTo"] = spec.skBetween[1];
    condition += " AND #sk BETWEEN :skFrom AND :skTo";
  } else if (spec.skBeginsWith !== undefined) {
    names["#sk"] = attrs.sk;
    values[":skPrefix"] = spec.skBeginsWith;
    condition += " AND begins_with(#sk, :skPrefix)";
  }
  return {
    TableName: table,
    IndexName: spec.index,
    KeyConditionExpression: condition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

async function dynamoQuery(table: string, spec: QuerySpec): Promise<Item[]> {
  const input = buildQueryInput(table, spec);
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client().send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...((page.Items ?? []) as Item[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

// ---------------------------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------------------------

export async function getItem<T extends Item = Item>(
  table: string,
  key: Key,
): Promise<T | undefined> {
  assertKey(table, "getItem", key);
  if (isMemoryMode()) {
    const item = memoryTable(table).get(memoryId(key));
    return item ? (structuredClone(item) as T) : undefined;
  }
  try {
    const result = await client().send(
      new GetCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk } }),
    );
    return result.Item as T | undefined;
  } catch (error) {
    throw wrap(table, "getItem", error);
  }
}

export async function putItem(table: string, item: Item, options: PutOptions = {}): Promise<void> {
  const key: Partial<Key> = {
    pk: item.pk as string | undefined,
    sk: item.sk as string | undefined,
  };
  assertKey(table, "putItem", key);
  warnIfLarge(table, item);
  if (isMemoryMode()) {
    const rows = memoryTable(table);
    const id = memoryId(key);
    if (options.ifNotExists && rows.has(id)) {
      throw new ConflictError(`${table}: an item with this key already exists`);
    }
    rows.set(id, structuredClone(item));
    return;
  }
  try {
    await client().send(
      new PutCommand({
        TableName: table,
        Item: item,
        ...(options.ifNotExists ? { ConditionExpression: "attribute_not_exists(pk)" } : {}),
      }),
    );
  } catch (error) {
    if (options.ifNotExists && isConditionFailure(error)) {
      throw new ConflictError(`${table}: an item with this key already exists`, [], {
        cause: error,
      });
    }
    throw wrap(table, "putItem", error);
  }
}

export async function deleteItem(table: string, key: Key): Promise<void> {
  assertKey(table, "deleteItem", key);
  if (isMemoryMode()) {
    memoryTable(table).delete(memoryId(key));
    return;
  }
  try {
    await client().send(new DeleteCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk } }));
  } catch (error) {
    throw wrap(table, "deleteItem", error);
  }
}

export async function query<T extends Item = Item>(table: string, spec: QuerySpec): Promise<T[]> {
  assertQuery(table, spec);
  if (isMemoryMode()) return memoryQuery(table, spec) as T[];
  try {
    return (await dynamoQuery(table, spec)) as T[];
  } catch (error) {
    throw wrap(table, "query", error);
  }
}
