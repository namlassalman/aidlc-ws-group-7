/**
 * Leave router (u4-leave, contract C7), mounted under /api by src/app.ts.
 *
 *   GET  /leave               any signed-in user; query {from?, to?, status?}      200 list
 *   POST /leave               doctor only (BR1.2); body {startDate, endDate, reason?} 201 request
 *   POST /leave/:id/approve   coordinator only (BR2.1)                              200 {leave, followUps}
 *   POST /leave/:id/reject    coordinator only (BR2.1)                              200 request
 *   POST /leave/:id/cancel    the owner doctor (BR3.1, checked in the service)      200 request
 *
 * Validation (BR1.1, BR4.3, NFR3.1): strict zod schemas, so unknown fields (including a
 * `doctorId` in the body) give 400 through the shared error middleware. Dates are real
 * YYYY-MM-DD calendar dates. The path id is a 1-128 character string; anything else cannot be a
 * request's id and gives 404 without reading the table (approved plan, NFR Design R-01: seed ids
 * such as `leave-chen-li-2026-12-07` are not UUIDs). The caller comes only from `req.user`
 * (NFR2.1-NFR2.3).
 */
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../shared/auth.js";
import { NotFoundError } from "../../shared/errors.js";
import { LEAVE_STATUSES } from "../../shared/tables.js";
import { approveLeave, cancelLeave, listLeave, rejectLeave, requestLeave } from "./service.js";

/** True for a YYYY-MM-DD string that is a real calendar date (so 2026-02-30 is refused). */
function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const DateString = z.string().refine(isRealDate, { message: "Must be a real date (YYYY-MM-DD)" });

export const RequestLeaveBody = z
  .strictObject({
    startDate: DateString,
    endDate: DateString,
    reason: z.string().max(200).optional(),
  })
  .refine((body) => body.startDate <= body.endDate, {
    message: "startDate must not be after endDate",
    path: ["endDate"],
  });

export const ListLeaveQuery = z
  .strictObject({
    from: DateString.optional(),
    to: DateString.optional(),
    status: z.enum(LEAVE_STATUSES).optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "from must not be after to",
    path: ["to"],
  });

const LeaveId = z.string().min(1).max(128);

/** The path id, or 404: an id outside the bound cannot belong to any request. */
function leaveIdFrom(value: unknown): string {
  const parsed = LeaveId.safeParse(value);
  if (!parsed.success) throw new NotFoundError("No such leave request");
  return parsed.data;
}

export const router = Router();

router.get("/leave", async (req, res) => {
  const filter = ListLeaveQuery.parse(req.query);
  res.json(await listLeave(filter, req.user));
});

router.post("/leave", requireRole("doctor"), async (req, res) => {
  const body = RequestLeaveBody.parse(req.body);
  res.status(201).json(await requestLeave(body, req.user));
});

router.post("/leave/:id/approve", requireRole("coordinator"), async (req, res) => {
  res.json(await approveLeave(leaveIdFrom(req.params.id), req.user));
});

router.post("/leave/:id/reject", requireRole("coordinator"), async (req, res) => {
  res.json(await rejectLeave(leaveIdFrom(req.params.id), req.user));
});

router.post("/leave/:id/cancel", async (req, res) => {
  res.json(await cancelLeave(leaveIdFrom(req.params.id), req.user));
});
