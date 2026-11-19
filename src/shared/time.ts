/**
 * DutyCalendar (contract C2): duty times, hours, weeks, months and the 12-hour lock.
 *
 * - Duty times are local times in ROSTER_TIME_ZONE (IANA zone, default Asia/Singapore):
 *   AM 08:00-13:00, PM 13:00-18:00, CALL 18:00 to 08:00 the next day.
 * - Intervals are half-open [start, end): a CALL ending at 08:00 does not overlap an AM at 08:00.
 * - A duty counts on its own date; a CALL counts on the date it starts. Weeks run Monday-Sunday.
 * - A duty is locked when it starts less than 12 hours after `now`, which includes duties that
 *   have already started or ended.
 * - Pure: nothing here reads the clock. "now" is always a parameter. Dates are "YYYY-MM-DD".
 */
import type { Duty, DutyType } from "./tables.js";

export const DEFAULT_TIME_ZONE = "Asia/Singapore";

export const HOURS: Readonly<Record<DutyType, number>> = { AM: 5, PM: 5, CALL: 14 };

/** Local start hour of each duty type, and its length in hours. */
const START_HOUR: Readonly<Record<DutyType, number>> = { AM: 8, PM: 13, CALL: 18 };

export const LOCK_HOURS = 12;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type DutyInterval = {
  /** Epoch milliseconds, included. */
  start: number;
  /** Epoch milliseconds, excluded. */
  end: number;
  hours: number;
  /** The date the duty counts against (its own date; a CALL's start date). */
  countsOn: string;
};

export function timeZone(): string {
  return process.env.ROSTER_TIME_ZONE || DEFAULT_TIME_ZONE;
}

export function hoursOf(type: DutyType): number {
  return HOURS[type];
}

// ---------------------------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------------------------

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses "YYYY-MM-DD" to UTC midnight epoch ms; throws on anything else. */
function dateToUtcMs(date: string): number {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new Error(`Invalid date "${date}": expected YYYY-MM-DD`);
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  if (new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date "${date}": no such calendar day`);
  }
  return ms;
}

const utcMsToDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const addDaysCache = new Map<string, string>();

/** The date `days` days after `date` (negative goes back). */
export function addDays(date: string, days: number): string {
  const cacheKey = `${date}|${days}`;
  let result = addDaysCache.get(cacheKey);
  if (result === undefined) {
    result = utcMsToDate(dateToUtcMs(date) + days * DAY_MS);
    if (addDaysCache.size > 10_000) addDaysCache.clear();
    addDaysCache.set(cacheKey, result);
  }
  return result;
}

const weekCache = new Map<string, string>();

/** The Monday of the week (Monday to Sunday) that `date` falls in. */
export function weekOf(date: string): string {
  let monday = weekCache.get(date);
  if (monday === undefined) {
    const ms = dateToUtcMs(date);
    const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
    monday = utcMsToDate(ms - sinceMonday * DAY_MS);
    if (weekCache.size > 10_000) weekCache.clear();
    weekCache.set(date, monday);
  }
  return monday;
}

export function isMonday(date: string): boolean {
  return weekOf(date) === date;
}

/** "YYYY-MM" of a date. */
export function monthOf(date: string): string {
  dateToUtcMs(date);
  return date.slice(0, 7);
}

export function firstOfMonth(date: string): string {
  return `${monthOf(date)}-01`;
}

export function lastOfMonth(date: string): string {
  const [y, m] = monthOf(date).split("-").map(Number);
  return utcMsToDate(Date.UTC(y, m, 0));
}

/** The Mondays of `weeks` consecutive weeks starting at the Monday `weekStart`. */
export function weeksOf(weekStart: string, weeks: number): string[] {
  if (!isMonday(weekStart)) throw new Error(`weekStart ${weekStart} is not a Monday`);
  return Array.from({ length: weeks }, (_, i) => addDays(weekStart, 7 * i));
}

// ---------------------------------------------------------------------------------------------
// Local time in ROSTER_TIME_ZONE
// ---------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (error) {
      throw new Error(`Invalid ROSTER_TIME_ZONE "${zone}"`, { cause: error });
    }
    formatters.set(zone, f);
  }
  return f;
}

/** The zone's offset from UTC (local minus UTC, in ms) at the instant `utcMs`. */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant of local time `hour`:00 on `date` in `zone`. */
export function zonedTime(date: string, hour: number, zone: string = timeZone()): number {
  const naive = dateToUtcMs(date) + hour * HOUR_MS;
  const firstGuess = naive - zoneOffsetMs(naive, zone);
  return naive - zoneOffsetMs(firstGuess, zone);
}

// ---------------------------------------------------------------------------------------------
// Duty intervals and the lock
// ---------------------------------------------------------------------------------------------

const intervalCache = new Map<string, DutyInterval>();

/** Clears the memoised intervals (for tests that change ROSTER_TIME_ZONE). */
export function clearDutyIntervalCache(): void {
  intervalCache.clear();
}

/**
 * The duty's half-open interval in ROSTER_TIME_ZONE. Memoised per duty id (the key also holds the
 * date, type and zone, so an edited duty or a changed zone is recomputed).
 */
export function dutyInterval(duty: Pick<Duty, "id" | "date" | "type">): DutyInterval {
  const zone = timeZone();
  const cacheKey = `${duty.id}|${duty.date}|${duty.type}|${zone}`;
  const cached = intervalCache.get(cacheKey);
  if (cached) return cached;
  const start = zonedTime(duty.date, START_HOUR[duty.type], zone);
  const end =
    duty.type === "CALL"
      ? zonedTime(addDays(duty.date, 1), START_HOUR.AM, zone)
      : zonedTime(duty.date, START_HOUR[duty.type] + HOURS[duty.type], zone);
  const interval: DutyInterval = { start, end, hours: HOURS[duty.type], countsOn: duty.date };
  if (intervalCache.size > 50_000) intervalCache.clear();
  intervalCache.set(cacheKey, interval);
  return interval;
}

export function overlaps(a: DutyInterval, b: DutyInterval): boolean {
  return a.start < b.end && b.start < a.end;
}

function toEpochMs(now: Date | string | number): number {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  if (!Number.isFinite(ms)) throw new Error(`Invalid "now": ${String(now)}`);
  return ms;
}

/** True when the duty starts less than 12 hours after `now` (already started counts as locked). */
export function isLocked(
  duty: Pick<Duty, "id" | "date" | "type">,
  now: Date | string | number,
): boolean {
  return dutyInterval(duty).start - toEpochMs(now) < LOCK_HOURS * HOUR_MS;
}
