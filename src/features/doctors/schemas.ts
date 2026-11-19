/**
 * Doctors Unit (u2-doctors), data model layer: the zod schemas for contract C5's inputs.
 *
 * - `DoctorId`: the doctor's id, equal to their Cognito username (FR1.4, BR1.1).
 * - `NewDoctor`: the add body, all five fields, no other key (BR1.1-BR1.6).
 * - `DoctorChanges`: the edit body, any of the four editable fields, at least one (BR1.2-BR1.6).
 * - `ListQuery`: the list query string, `all` is "true" or "false" (BR1.7, NFR3.1).
 *
 * Every object schema is strict, so an unknown key (for example `active`) is refused with 400.
 * Grades and modalities come from the skeleton's `src/shared/tables.ts` so they match contract C1.
 */
import { z } from "zod";
import { GRADES, MODALITIES } from "../../shared/tables.js";

export const DoctorId = z.string().regex(/^[a-z0-9._-]{1,64}$/, {
  message: "id must be 1-64 lowercase letters, digits, '.', '_' or '-'",
});

const Name = z.string().trim().min(1).max(100);

const Grade = z.enum(GRADES);

const Modalities = z
  .array(z.enum(MODALITIES))
  .min(1)
  .refine((list) => new Set(list).size === list.length, {
    message: "a modality is listed twice",
  });

const MaxHoursPerWeek = z.number().int().min(1).max(168);

export const NewDoctor = z.strictObject({
  id: DoctorId,
  name: Name,
  grade: Grade,
  modalities: Modalities,
  maxHoursPerWeek: MaxHoursPerWeek,
});

export const DoctorChanges = z
  .strictObject({
    name: Name.optional(),
    grade: Grade.optional(),
    modalities: Modalities.optional(),
    maxHoursPerWeek: MaxHoursPerWeek.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "send at least one of name, grade, modalities, maxHoursPerWeek",
  });

export const ListQuery = z.strictObject({
  all: z.enum(["true", "false"]).optional(),
});

export type NewDoctor = z.infer<typeof NewDoctor>;
export type DoctorChanges = z.infer<typeof DoctorChanges>;
export type ListQuery = z.infer<typeof ListQuery>;
