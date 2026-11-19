/**
 * Leave service (u4-leave): the business rules of requesting, deciding, cancelling and listing
 * leave (functional-spec WF1-WF5, rules BR1.1-BR4.4).
 *
 * - requestLeave (WF1): doctors only, for themselves (BR1.2); an active doctor record (BR1.3);
 *   no overlap with the doctor's own pending or approved leave, inclusive (BR1.4); created
 *   pending with a generated id and a trimmed reason or null (BR1.5); no date check against
 *   today (BR1.6).
 * - approveLeave / rejectLeave (WF2, WF3): coordinator only (BR2.1); pending only (BR2.2);
 *   records status, time and decider (BR2.3). Approval publishes `leave.approved` only after
 *   the save, with the payload built from the saved request, and returns the subscribers'
 *   results as `followUps`; a failed follow-up never undoes the approval (BR2.4, C3).
 *   Rejection publishes nothing (BR2.5).
 * - cancelLeave (WF4): owner doctor only, checked before the status (BR3.1); pending only
 *   (BR3.2); kept, marked cancelled (BR3.3).
 * - listLeave (WF5): coordinator sees all (BR4.1); a doctor sees every approved request plus
 *   their own (BR4.2); inclusive range and status filters, ordered by start date then id
 *   (BR4.3, NFR5.1).
 *
 * No try/catch: only the shared error classes are thrown and every error reaches the shared
 * error middleware (NFR3.2, NFR6.1). Logs carry the allow-listed fields only (NFR2.6).
 */
import { randomUUID } from "node:crypto";
import type { AuthUser } from "../../shared/auth.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { publish, type PublishResult } from "../../shared/events.js";
import { log } from "../../shared/log.js";
import type { LeaveRequest, LeaveStatus } from "../../shared/tables.js";
import {
  allLeave,
  approvedLeave,
  getDoctor,
  getLeave,
  leaveOfDoctorId,
  saveLeave,
  saveNewLeave,
} from "./repository.js";

export type RequestLeaveInput = { startDate: string; endDate: string; reason?: string };

export type ListLeaveFilter = { from?: string; to?: string; status?: LeaveStatus };

export type ApproveResult = { leave: LeaveRequest; followUps: PublishResult[] };

/** The statuses that block an overlapping new request (BR1.4). */
const BLOCKING_STATUSES: readonly LeaveStatus[] = ["pending", "approved"];

const currentTime = () => new Date().toISOString();

/** True when the two inclusive date ranges share at least one day. */
function overlaps(
  a: Pick<LeaveRequest, "startDate" | "endDate">,
  b: Pick<LeaveRequest, "startDate" | "endDate">,
): boolean {
  return a.startDate <= b.endDate && a.endDate >= b.startDate;
}

async function assertActiveDoctor(id: string): Promise<void> {
  const doctor = await getDoctor(id);
  if (!doctor || !doctor.active) throw new ForbiddenError(`no active doctor record for ${id}`);
}

async function assertNoOverlap(doctorId: string, range: RequestLeaveInput): Promise<void> {
  const own = await leaveOfDoctorId(doctorId);
  const clash = own.find((l) => BLOCKING_STATUSES.includes(l.status) && overlaps(l, range));
  if (clash) {
    throw new ConflictError(
      `overlaps ${clash.status} leave ${clash.id} (${clash.startDate} to ${clash.endDate})`,
    );
  }
}

/** WF1: a doctor requests leave for themselves. */
export async function requestLeave(
  input: RequestLeaveInput,
  user: AuthUser,
  now: string = currentTime(),
  newId: () => string = randomUUID,
): Promise<LeaveRequest> {
  if (user.role !== "doctor") throw new ForbiddenError("Only a doctor can request leave");
  await assertActiveDoctor(user.id);
  await assertNoOverlap(user.id, input);
  const reason = input.reason?.trim() ?? "";
  const leave: LeaveRequest = {
    id: newId(),
    doctorId: user.id,
    startDate: input.startDate,
    endDate: input.endDate,
    reason: reason === "" ? null : reason,
    status: "pending",
    createdAt: now,
    decidedAt: null,
    decidedBy: null,
  };
  await saveNewLeave(leave);
  return leave;
}

async function pendingLeaveToDecide(id: string, user: AuthUser): Promise<LeaveRequest> {
  if (user.role !== "coordinator") {
    throw new ForbiddenError("Only the coordinator can decide leave");
  }
  const leave = await getLeave(id);
  if (!leave) throw new NotFoundError(`No leave request ${id}`);
  if (leave.status !== "pending") {
    throw new ConflictError(`Leave request ${id} is already ${leave.status}`);
  }
  return leave;
}

async function decide(
  leave: LeaveRequest,
  status: LeaveStatus,
  user: AuthUser,
  now: string,
): Promise<LeaveRequest> {
  const decided: LeaveRequest = { ...leave, status, decidedAt: now, decidedBy: user.id };
  await saveLeave(decided);
  return decided;
}

/** WF2: the coordinator approves a pending request, then `leave.approved` is published. */
export async function approveLeave(
  id: string,
  user: AuthUser,
  now: string = currentTime(),
): Promise<ApproveResult> {
  const pending = await pendingLeaveToDecide(id, user);
  const leave = await decide(pending, "approved", user, now);
  const followUps = await publish("leave.approved", {
    leaveId: leave.id,
    doctorId: leave.doctorId,
    startDate: leave.startDate,
    endDate: leave.endDate,
    approvedBy: leave.decidedBy ?? user.id,
    at: leave.decidedAt ?? now,
  });
  log("info", "leave approved", {
    leaveId: leave.id,
    followUps: followUps.length,
    failedFollowUps: followUps.filter((f) => !f.ok).length,
  });
  return { leave, followUps };
}

/** WF3: the coordinator rejects a pending request. Nothing is published. */
export async function rejectLeave(
  id: string,
  user: AuthUser,
  now: string = currentTime(),
): Promise<LeaveRequest> {
  const pending = await pendingLeaveToDecide(id, user);
  return decide(pending, "rejected", user, now);
}

/** WF4: the doctor who made a pending request cancels it. Ownership is checked before status. */
export async function cancelLeave(
  id: string,
  user: AuthUser,
  now: string = currentTime(),
): Promise<LeaveRequest> {
  const leave = await getLeave(id);
  if (!leave) throw new NotFoundError(`No leave request ${id}`);
  if (user.role !== "doctor" || user.id !== leave.doctorId) {
    throw new ForbiddenError("Only the doctor who made a leave request can cancel it");
  }
  if (leave.status !== "pending") {
    throw new ConflictError(`Leave request ${id} is already ${leave.status}`);
  }
  return decide(leave, "cancelled", user, now);
}

/** The requests the caller may see: all for the coordinator, approved plus own for a doctor. */
async function visibleLeave(user: AuthUser): Promise<LeaveRequest[]> {
  if (user.role === "coordinator") return allLeave();
  const [approved, own] = await Promise.all([approvedLeave(), leaveOfDoctorId(user.id)]);
  const byId = new Map<string, LeaveRequest>();
  for (const leave of [...approved, ...own]) byId.set(leave.id, leave);
  return [...byId.values()];
}

function matchesFilter(leave: LeaveRequest, filter: ListLeaveFilter): boolean {
  if (filter.from !== undefined && leave.endDate < filter.from) return false;
  if (filter.to !== undefined && leave.startDate > filter.to) return false;
  if (filter.status !== undefined && leave.status !== filter.status) return false;
  return true;
}

function byStartThenId(a: LeaveRequest, b: LeaveRequest): number {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** WF5: the leave the caller may see, filtered and ordered by start date, then id. */
export async function listLeave(filter: ListLeaveFilter, user: AuthUser): Promise<LeaveRequest[]> {
  const visible = await visibleLeave(user);
  return visible.filter((leave) => matchesFilter(leave, filter)).sort(byStartThenId);
}
