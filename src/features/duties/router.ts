/**
 * Duties router (u3-duties): contract C6 `/api/duties`, mounted under /api by src/app.ts after
 * the shared sign-in and the 100 kB JSON body parser.
 *
 *   POST /duties              coordinator  201 Duty           400, 403
 *   GET  /duties?from&to[&includeCancelled]
 *                             any role     200 Duty[]         400
 *   POST /duties/:id/cancel   coordinator  200 Duty           403, 404, 409
 *
 * Order on every route (security-design.md): the role check first (BR4.1, BR4.2), then the zod
 * checks (BR1.1-BR1.6, BR2.1, BR2.2, BR2.7; NFR3.1-NFR3.3), then the service. A ZodError or one
 * of the shared error types reaches the shared error middleware, which replies with the C4
 * ErrorBody (BR4.5). This router never reads tokens or test headers itself (NFR2.2).
 */
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../shared/auth.js";
import { NotFoundError } from "../../shared/errors.js";
import { DUTY_TYPES, MODALITIES } from "../../shared/tables.js";
import { cancelDuty, createDuty, listDuties } from "./service.js";

/** The create body: exactly these five fields; anything else, `id` and `cancelled` too, is 400. */
export const CreateDutySchema = z.strictObject({
  date: z.iso.date(),
  type: z.enum(DUTY_TYPES),
  modality: z.enum(MODALITIES),
  doctorsNeeded: z.number().int().min(1).max(3),
  needsConsultant: z.boolean(),
});

/** The list query: exactly `from`, `to` and an optional `includeCancelled`; `from` <= `to`. */
export const ListDutiesQuerySchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    includeCancelled: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .refine((range) => range.from <= range.to, {
    message: "from must not be after to",
    path: ["from"],
  });

/** A cancel path id: 1-100 letters, digits or hyphens (random UUIDs and seeded ids both fit). */
export const DutyIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);

export const router = Router();

router.post("/duties", requireRole("coordinator"), async (req, res) => {
  const body = CreateDutySchema.parse(req.body);
  res.status(201).json(await createDuty(body));
});

router.get("/duties", async (req, res) => {
  const range = ListDutiesQuerySchema.parse(req.query);
  res.status(200).json(await listDuties(range, req.user.role));
});

router.post("/duties/:id/cancel", requireRole("coordinator"), async (req, res) => {
  const id = DutyIdSchema.safeParse(req.params.id);
  // An id no duty could have is answered like an unknown id, never with a 500 (NFR3.3).
  if (!id.success) throw new NotFoundError("No duty with this id");
  res.status(200).json(await cancelDuty(id.data));
});
