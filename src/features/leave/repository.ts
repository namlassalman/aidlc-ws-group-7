/**
 * Leave repository (u4-leave): the leave table and a read of the doctors table, through the
 * skeleton's table helpers only (C1). No AWS SDK, no other feature's code.
 *
 * - Every write goes through `leaveItem`, which rewrites the index keys from the request's
 *   current fields, so the `byStatus` "approved" partition holds exactly the approved requests
 *   (BR4.4).
 * - `saveNewLeave` writes with "must not already exist" (BR1.5): a second write with the same id
 *   throws the shared ConflictError.
 * - Every read strips the key attributes (`pk`, `sk`, `gsi*`) and returns a plain LeaveRequest.
 * - `getDoctor` reads only the doctor's id and active flag (BR1.3).
 */
import { getItem, putItem, query, type Item } from "../../shared/db.js";
import {
  TABLES,
  doctorKey,
  leaveItem,
  leaveKey,
  leaveOfDoctor,
  type LeaveRequest,
} from "../../shared/tables.js";

/** The doctor fields this Unit needs from the doctors table. */
export type DoctorRecord = { id: string; active: boolean };

/** The partition of the leave table that holds every request (C1). */
const ALL_LEAVE_PK = "LEAVE";

function toLeave(item: Item): LeaveRequest {
  const { id, doctorId, startDate, endDate, reason, status, createdAt, decidedAt, decidedBy } =
    item as unknown as LeaveRequest;
  return { id, doctorId, startDate, endDate, reason, status, createdAt, decidedAt, decidedBy };
}

export async function getLeave(id: string): Promise<LeaveRequest | undefined> {
  const item = await getItem(TABLES.leave, leaveKey(id));
  return item ? toLeave(item) : undefined;
}

/** Writes a new request; throws ConflictError when the id already exists. */
export async function saveNewLeave(leave: LeaveRequest): Promise<void> {
  await putItem(TABLES.leave, leaveItem(leave), { ifNotExists: true });
}

/** Overwrites a request with its current fields and index keys. */
export async function saveLeave(leave: LeaveRequest): Promise<void> {
  await putItem(TABLES.leave, leaveItem(leave));
}

/** Every request of one doctor, in any status (byDoctor index). */
export async function leaveOfDoctorId(doctorId: string): Promise<LeaveRequest[]> {
  const items = await query(TABLES.leave, leaveOfDoctor(doctorId));
  return items.map(toLeave);
}

/** Every approved request (byStatus index, `approved` partition). */
export async function approvedLeave(): Promise<LeaveRequest[]> {
  const items = await query(TABLES.leave, { index: "byStatus", pk: "approved" });
  return items.map(toLeave);
}

/** Every request in every status (the table's LEAVE partition). */
export async function allLeave(): Promise<LeaveRequest[]> {
  const items = await query(TABLES.leave, { pk: ALL_LEAVE_PK });
  return items.map(toLeave);
}

/** The doctor's id and active flag, or undefined when there is no doctor record. */
export async function getDoctor(id: string): Promise<DoctorRecord | undefined> {
  const item = await getItem(TABLES.doctors, doctorKey(id));
  if (!item) return undefined;
  return { id: String(item.id), active: item.active === true };
}
