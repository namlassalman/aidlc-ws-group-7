/**
 * `npm run seed`: writes the vision.md example data (four doctors, the six duties of the week
 * of 2026-12-07, Dr Li's approved leave and the three rules) into the deployed tables, through
 * the DynamoDB mode of src/shared/db.ts, keyed as in contract C1.
 *
 * Fixed ids and plain overwrites, so running it twice leaves the same data. A failed write stops
 * with exit code 1, naming the table and the item.
 *
 *   AWS_PROFILE=deploy AWS_REGION=us-west-2 npm run seed
 */
import { putItem } from "../src/shared/db.js";
import {
  TABLES,
  TABLE_ENV,
  TABLE_NAMES,
  doctorItem,
  dutyItem,
  leaveItem,
  ruleItem,
  type TableName,
} from "../src/shared/tables.js";
import { EXAMPLE_DOCTORS, EXAMPLE_DUTIES, EXAMPLE_LEAVE, EXAMPLE_RULES } from "./example-data.js";
import { readStackOutputs, requireOutput } from "./stack-outputs.js";

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

async function write(table: TableName, id: string, item: Record<string, unknown>): Promise<void> {
  try {
    await putItem(TABLES[table], item);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Seed failed writing ${id} to the ${table} table: ${message}`, {
      cause: error,
    });
  }
}

async function main(): Promise<void> {
  const outputs = await readStackOutputs();
  process.env.DB_MODE = "dynamodb";
  for (const name of TABLE_NAMES)
    process.env[TABLE_ENV[name]] = requireOutput(outputs, `Table${pascal(name)}`);

  for (const doctor of EXAMPLE_DOCTORS) await write("doctors", doctor.id, doctorItem(doctor));
  for (const duty of EXAMPLE_DUTIES) await write("duties", duty.id, dutyItem(duty));
  for (const leave of EXAMPLE_LEAVE) await write("leave", leave.id, leaveItem(leave));
  for (const rule of EXAMPLE_RULES) await write("rules", rule.id, ruleItem(rule));

  console.log(
    `Seeded ${EXAMPLE_DOCTORS.length} doctors, ${EXAMPLE_DUTIES.length} duties, ` +
      `${EXAMPLE_LEAVE.length} leave request and ${EXAMPLE_RULES.length} rules.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
