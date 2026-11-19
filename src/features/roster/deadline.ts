/**
 * Deadline (u6-roster): the 15 s soft cut-off of one run (NFR1.3, NFR1.5; performance-design §1).
 *
 * Created when a request or a `leave.approved` event arrives, with a monotonic clock passed in
 * (performance.now() by default; tests pass a fake). `check(stage)` throws RunTooLongError once
 * the limit is reached. Elapsed time only decides whether to stop; it never changes what is
 * placed, so generation stays deterministic (BR3.6, BR3.7, BR7.5, NFR5.1). Used by C9 generate
 * and publish and by the C3 subscriber. The limit is fixed: the 20 s Lambda timeout is the lead's landing
 * condition, not something this Unit changes.
 */
import { RunTooLongError, type DeadlineStage } from "./schemas.js";

export type MonotonicClock = () => number;

/** The soft cut-off: 15 seconds. */
export const CUT_OFF_MS = 15_000;

export const systemClock: MonotonicClock = () => performance.now();

/** The part of a Deadline the pure generator needs. */
export type DeadlineCheck = { check(stage: DeadlineStage): void };

export class Deadline implements DeadlineCheck {
  readonly startedAt: number;
  readonly limitMs = CUT_OFF_MS;

  constructor(private readonly clock: MonotonicClock = systemClock) {
    this.startedAt = clock();
  }

  elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  /** Throws RunTooLongError when the run has reached the cut-off. */
  check(stage: DeadlineStage): void {
    const elapsedMs = this.elapsedMs();
    if (elapsedMs >= this.limitMs) throw new RunTooLongError(undefined, { stage, elapsedMs });
  }
}
