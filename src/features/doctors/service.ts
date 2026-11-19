/**
 * Doctors Unit (u2-doctors), service layer: the doctor lifecycle behind contract C5.
 *
 * - `addDoctor`: stores a new doctor with `active: true`, once per id (BR2.1); 409 names the id.
 * - `editDoctor`: changes only the fields sent; id and `active` never change (BR2.2).
 * - `setActive`: deactivate (BR2.3) or activate (BR2.4); a repeat writes and logs nothing.
 * - `listDoctors`: active doctors for everyone, every doctor for a coordinator asking `all`
 *   (BR3.2, BR3.3), in id order (BR4.1).
 *
 * Lifecycle changes log `doctor.added`, `doctor.deactivated` or `doctor.activated` with the
 * doctor id and the caller id only (NFR6.6, NFR6.7). Inputs are already validated by the router.
 */
import type { Role } from "../../shared/auth.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import type { Doctor } from "../../shared/tables.js";
import {
  findDoctor,
  insertDoctor,
  listDoctors as listAllDoctors,
  saveDoctor,
} from "./repository.js";
import type { DoctorChanges, NewDoctor } from "./schemas.js";

async function findOrThrow(id: string): Promise<Doctor> {
  const doctor = await findDoctor(id);
  if (!doctor) throw new NotFoundError(`No doctor with id "${id}"`);
  return doctor;
}

/** Adds a doctor; throws ConflictError naming the id when it is taken, active or not. */
export async function addDoctor(input: NewDoctor, by: string): Promise<Doctor> {
  const doctor: Doctor = { ...input, active: true };
  try {
    await insertDoctor(doctor);
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new ConflictError(`A doctor with id "${doctor.id}" already exists`, [], {
        cause: error,
      });
    }
    throw error;
  }
  log("info", "doctor.added", { doctorId: doctor.id, by });
  return doctor;
}

/** Applies the sent fields to an existing doctor; throws NotFoundError for an unknown id. */
export async function editDoctor(id: string, changes: DoctorChanges): Promise<Doctor> {
  const current = await findOrThrow(id);
  const updated: Doctor = { ...current };
  if (changes.name !== undefined) updated.name = changes.name;
  if (changes.grade !== undefined) updated.grade = changes.grade;
  if (changes.modalities !== undefined) updated.modalities = changes.modalities;
  if (changes.maxHoursPerWeek !== undefined) updated.maxHoursPerWeek = changes.maxHoursPerWeek;
  await saveDoctor(updated);
  return updated;
}

/** Sets the active flag; a doctor already in that state is returned unchanged. */
export async function setActive(id: string, active: boolean, by: string): Promise<Doctor> {
  const current = await findOrThrow(id);
  if (current.active === active) return current;
  const updated: Doctor = { ...current, active };
  await saveDoctor(updated);
  log("info", active ? "doctor.activated" : "doctor.deactivated", { doctorId: id, by });
  return updated;
}

/** Active doctors, or every doctor when a coordinator asks for `all`; in id order. */
export async function listDoctors(options: { all: boolean; role: Role }): Promise<Doctor[]> {
  if (options.all && options.role !== "coordinator") {
    throw new ForbiddenError("Listing inactive doctors needs the coordinator role");
  }
  const doctors = await listAllDoctors();
  return options.all ? doctors : doctors.filter((doctor) => doctor.active);
}
