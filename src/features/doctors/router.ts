/**
 * Doctors Unit (u2-doctors), API layer: the `/api/doctors` routes of contract C5, plus
 * `POST /doctors/:id/activate`. Mounted under /api by src/app.ts (paths here are below /api).
 *
 *   GET  /doctors                  any role; `?all=true` coordinator only (BR3.2, BR3.3)  200
 *   POST /doctors                  coordinator; NewDoctor body (BR1.1-BR1.6)              201
 *   PUT  /doctors/:id              coordinator; DoctorChanges body                        200
 *   POST /doctors/:id/deactivate   coordinator                                            200
 *   POST /doctors/:id/activate     coordinator                                            200
 *
 * Order of checks: role (403, BR3.1), then validation (400), then existence or uniqueness
 * (404, 409). Role guards are attached per route, never with router.use, because every feature
 * router shares the /api router. A path id that fails `DoctorId` is 404, like an unknown id
 * (NFR3.2). Errors are thrown; Express 5 forwards async errors to the skeleton's error middleware.
 */
import { Router } from "express";
import { requireRole } from "../../shared/auth.js";
import { NotFoundError } from "../../shared/errors.js";
import { DoctorChanges, DoctorId, ListQuery, NewDoctor } from "./schemas.js";
import { addDoctor, editDoctor, listDoctors, setActive } from "./service.js";

/** The path id, checked before any table read; a malformed id is answered like an unknown one. */
function pathId(raw: unknown): string {
  const parsed = DoctorId.safeParse(raw);
  if (!parsed.success) throw new NotFoundError("No doctor with this id");
  return parsed.data;
}

export const router = Router();

router.get("/doctors", async (req, res) => {
  const query = ListQuery.parse(req.query);
  res.json(await listDoctors({ all: query.all === "true", role: req.user.role }));
});

router.post("/doctors", requireRole("coordinator"), async (req, res) => {
  const input = NewDoctor.parse(req.body);
  res.status(201).json(await addDoctor(input, req.user.id));
});

router.put("/doctors/:id", requireRole("coordinator"), async (req, res) => {
  const id = pathId(req.params.id);
  const changes = DoctorChanges.parse(req.body);
  res.json(await editDoctor(id, changes));
});

router.post("/doctors/:id/deactivate", requireRole("coordinator"), async (req, res) => {
  res.json(await setActive(pathId(req.params.id), false, req.user.id));
});

router.post("/doctors/:id/activate", requireRole("coordinator"), async (req, res) => {
  res.json(await setActive(pathId(req.params.id), true, req.user.id));
});
