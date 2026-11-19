/**
 * Duties service (u3-duties): the logic behind contract C6 `/api/duties`.
 *
 * Workflows W1 create, W2 list, W3 cancel (functional-spec.md). Rules: BR1.7 and BR1.8 (a new
 * random id and `cancelled: false` for every create, identical duties allowed), BR2.4-BR2.6
 * (index order; cancelled duties only for a coordinator who asks), BR3.1-BR3.4 (404 unknown,
 * 409 already cancelled, otherwise cancelled and returned whole). Input is already validated by
 * the router. Storage errors are not caught: they reach the shared error handler (NFR4.4).
 */
import { randomUUID } from "node:crypto";
import type { Role } from "../../shared/auth.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { Duty } from "../../shared/tables.js";
import { findDutiesBetween, getDuty, markCancelled, saveDuty } from "./repository.js";

/** The five fields a coordinator sends to create a duty. */
export type NewDuty = Omit<Duty, "id" | "cancelled">;

/** A validated list request (DutyRange). */
export type DutyRange = { from: string; to: string; includeCancelled?: boolean };

/** W1: creates an open duty with a new random id and returns it (BR1.7, BR1.8). */
export async function createDuty(input: NewDuty): Promise<Duty> {
  const duty: Duty = { ...input, id: randomUUID(), cancelled: false };
  await saveDuty(duty);
  return duty;
}

/**
 * W2: the duties in the range, ordered by date, start time and id (BR2.4). Cancelled duties are
 * left out unless the caller is a coordinator who asked for them (BR2.5, BR2.6).
 */
export async function listDuties(range: DutyRange, role: Role): Promise<Duty[]> {
  const duties = await findDutiesBetween(range.from, range.to);
  const showCancelled = range.includeCancelled === true && role === "coordinator";
  return showCancelled ? duties : duties.filter((duty) => !duty.cancelled);
}

/** W3: cancels an open duty and returns it with `cancelled: true` (BR3.1-BR3.4). */
export async function cancelDuty(id: string): Promise<Duty> {
  const duty = await getDuty(id);
  if (!duty) throw new NotFoundError(`No duty with id ${id}`);
  if (duty.cancelled) throw new ConflictError(`Duty ${id} is already cancelled`);
  return markCancelled(id, duty);
}
