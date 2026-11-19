/**
 * Rules router (u5-rules, contract C8), mounted under /api by src/app.ts.
 *
 *   GET    /rules                 any role: enabled rules; the coordinator gets all (BR2.4)
 *   POST   /rules                 coordinator: create {type, strength, settings, enabled?} -> 201
 *   PUT    /rules/:id             coordinator: edit {strength?, settings?}, at least one (BR1.5)
 *   DELETE /rules/:id             coordinator: delete -> 204 (BR2.3)
 *   POST   /rules/:id/enable      coordinator: switch on, contradiction checked (BR2.1)
 *   POST   /rules/:id/disable     coordinator: switch off (BR2.2)
 *   GET    /rules/check           coordinator: ?doctorId&dutyId -> the can-take answer (BR3.1)
 *
 * requireRole("coordinator") is the first handler on every route but the list (BR2.5, NFR2.3).
 * Bodies and the query are strict zod objects (400 on unknown keys, NFR3.1). The path id must
 * match the BR1.4 id pattern, else 404 like an unknown rule, so a raw path value never reaches
 * the table (NFR3.3). Every error goes to the shared error handler (C4).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireRole } from "../../shared/auth.js";
import { NotFoundError } from "../../shared/errors.js";
import { RuleType, Strength } from "../../shared/rules.js";
import {
  checkCanTake,
  createRule,
  disableRule,
  editRule,
  enableRule,
  listRulesFor,
  removeRule,
} from "./service.js";

const SettingsBody = z.record(z.string(), z.unknown());

const CreateRuleBody = z.strictObject({
  type: RuleType,
  strength: Strength,
  settings: SettingsBody,
  enabled: z.boolean().optional(),
});

const EditRuleBody = z
  .strictObject({ strength: Strength.optional(), settings: SettingsBody.optional() })
  .refine((body) => body.strength !== undefined || body.settings !== undefined, {
    message: "Give strength, settings or both",
  });

const CheckQuery = z.strictObject({
  doctorId: z.string().min(1).max(100),
  dutyId: z.string().min(1).max(100),
});

const RuleId = z
  .string()
  .max(100)
  .regex(/^rule-\d+-[a-z]+(-[a-z]+)*$/);

/** The validated path id; a malformed id is answered like an unknown rule (404). */
function ruleIdOf(req: Request): string {
  const parsed = RuleId.safeParse(req.params.id);
  if (!parsed.success) throw new NotFoundError("Rule not found");
  return parsed.data;
}

const requestIdOf = (res: Response): string => String(res.locals.requestId ?? "");

const coordinatorOnly = requireRole("coordinator");

export const router = Router();

router.get("/rules", async (req, res) => {
  res.json(await listRulesFor(req.user));
});

// Before the /rules/:id routes, so "check" is never read as an id.
router.get("/rules/check", coordinatorOnly, async (req, res) => {
  const { doctorId, dutyId } = CheckQuery.parse(req.query);
  res.json(await checkCanTake(doctorId, dutyId));
});

router.post("/rules", coordinatorOnly, async (req, res) => {
  const body = CreateRuleBody.parse(req.body);
  res.status(201).json(await createRule(body, req.user, requestIdOf(res)));
});

router.put("/rules/:id", coordinatorOnly, async (req, res) => {
  const id = ruleIdOf(req);
  const patch = EditRuleBody.parse(req.body);
  res.json(await editRule(id, patch, req.user, requestIdOf(res)));
});

router.delete("/rules/:id", coordinatorOnly, async (req, res) => {
  await removeRule(ruleIdOf(req), req.user, requestIdOf(res));
  res.status(204).end();
});

router.post("/rules/:id/enable", coordinatorOnly, async (req, res) => {
  res.json(await enableRule(ruleIdOf(req), req.user, requestIdOf(res)));
});

router.post("/rules/:id/disable", coordinatorOnly, async (req, res) => {
  res.json(await disableRule(ruleIdOf(req), req.user, requestIdOf(res)));
});
