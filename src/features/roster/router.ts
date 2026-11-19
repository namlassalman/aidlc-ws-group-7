// Placeholder router for the roster Unit (u6-roster, contract C9). Mounted under /api by
// src/app.ts. The roster Unit adds its routes here, e.g. router.post("/roster/generate", ...),
// and subscribes to "leave.approved" (src/shared/events.ts) when its module loads.
import { Router } from "express";

export const router = Router();
