/**
 * Duties repository (u3-duties): the duties table, through the skeleton's table helpers only.
 *
 * Contract C1: each duty is stored with `pk: "DUTY"`, `sk: <id>` and the `byDate` index keys
 * `gsi1pk: "DUTY"`, `gsi1sk: "<date>#<08|13|18>#<id>"`, all built by the skeleton's `dutyItem`.
 * Rules: BR1.7 and BR1.9 (store once, with the C1 keys), BR2.3 (inclusive range on the duty's
 * own date, one index query), BR3.3 (cancel keeps every other field and key), BR4.4 (callers
 * only ever see the seven Duty fields). Storage errors are not caught here (NFR4.4).
 */
import { getItem, putItem, query, type Item } from "../../shared/db.js";
import { NotFoundError } from "../../shared/errors.js";
import { TABLES, dutiesBetween, dutyItem, dutyKey, type Duty } from "../../shared/tables.js";

/** Keeps only the seven Duty fields of a stored item, never the storage keys (BR4.4). */
export function toDuty(item: Item): Duty {
  const { id, date, type, modality, doctorsNeeded, needsConsultant, cancelled } = item as Duty;
  return { id, date, type, modality, doctorsNeeded, needsConsultant, cancelled };
}

/** Stores a new duty with its C1 keys; throws ConflictError if a duty already has its id. */
export async function saveDuty(duty: Duty): Promise<void> {
  await putItem(TABLES.duties, dutyItem(duty), { ifNotExists: true });
}

/** The duty with this id, or undefined. */
export async function getDuty(id: string): Promise<Duty | undefined> {
  const item = await getItem(TABLES.duties, dutyKey(id));
  return item ? toDuty(item) : undefined;
}

/**
 * Duties whose own date is from `from` to `to`, both included, in index order: date, then start
 * hour, then id (BR2.3, BR2.4). One query on the `byDate` index (NFR1.1).
 */
export async function findDutiesBetween(from: string, to: string): Promise<Duty[]> {
  const items = await query(TABLES.duties, dutiesBetween(from, to));
  return items.map(toDuty);
}

/**
 * Writes the duty back with `cancelled: true` and the same keys (BR3.3), and returns it.
 * A caller that has just read the duty passes it as `current`, so cancel stays one read and one
 * write (NFR1.2); otherwise the duty is read here, and a missing id throws NotFoundError.
 */
export async function markCancelled(id: string, current?: Duty): Promise<Duty> {
  const duty = current ?? (await getDuty(id));
  if (!duty) throw new NotFoundError(`No duty with id ${id}`);
  const cancelled: Duty = { ...duty, cancelled: true };
  await putItem(TABLES.duties, dutyItem(cancelled));
  return cancelled;
}
