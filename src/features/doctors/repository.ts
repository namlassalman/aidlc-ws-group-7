/**
 * Doctors Unit (u2-doctors), repository layer: the doctors table (contract C1), reached only
 * through the skeleton's table helpers in `src/shared/db.ts` (no AWS SDK here).
 *
 * - `insertDoctor` writes only if the id is free; the helper throws `ConflictError` otherwise
 *   (BR2.1, NFR3.3).
 * - `findDoctor`, `listDoctors` return Doctor fields only, never `pk`/`sk` (BR4.1, NFR3.4).
 * - `listDoctors` is one query on `pk "DOCTOR"`, ordered by id (the sort key) (BR4.1, NFR1.1).
 */
import { getItem, putItem, query, type Item } from "../../shared/db.js";
import { TABLES, doctorItem, doctorKey, type Doctor } from "../../shared/tables.js";

/** Copies the six Doctor fields from a stored item, dropping the table keys. */
export function toDoctor(item: Item): Doctor {
  const doctor = item as Doctor;
  return {
    id: doctor.id,
    name: doctor.name,
    grade: doctor.grade,
    modalities: [...doctor.modalities],
    maxHoursPerWeek: doctor.maxHoursPerWeek,
    active: doctor.active,
  };
}

/** Stores a new doctor; throws ConflictError when a doctor with that id already exists. */
export async function insertDoctor(doctor: Doctor): Promise<void> {
  await putItem(TABLES.doctors, doctorItem(doctor), { ifNotExists: true });
}

/** The doctor with this id, or undefined. */
export async function findDoctor(id: string): Promise<Doctor | undefined> {
  const item = await getItem(TABLES.doctors, doctorKey(id));
  return item ? toDoctor(item) : undefined;
}

/** Overwrites an existing doctor with the whole updated record. */
export async function saveDoctor(doctor: Doctor): Promise<void> {
  await putItem(TABLES.doctors, doctorItem(doctor));
}

/** Every doctor, active or not, in id order. */
export async function listDoctors(): Promise<Doctor[]> {
  const items = await query(TABLES.doctors, { pk: "DOCTOR" });
  return items.map(toDoctor);
}
