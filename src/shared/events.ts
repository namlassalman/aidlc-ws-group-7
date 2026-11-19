/**
 * DomainEvents (contract C3): in-process events between feature Units, with no imports between
 * their code. Only `leave.approved` exists in this release (u4-leave publishes, u6-roster subscribes).
 *
 * - `subscribe(name, handler, subscriber?)` registers a handler, usually at module load.
 * - `await publish(name, payload)` runs every handler in registration order, awaiting each one.
 *   A handler that throws is caught, logged as a warning and reported with ok=false; it is never
 *   rethrown, so the publisher still succeeds and returns the results as `followUps`.
 */
import { log } from "./log.js";

export type LeaveApprovedPayload = {
  leaveId: string;
  doctorId: string;
  startDate: string;
  endDate: string;
  approvedBy: string;
  /** ISO date-time of the approval. */
  at: string;
};

export type EventPayloads = { "leave.approved": LeaveApprovedPayload };
export type EventName = keyof EventPayloads;
export const EVENT_NAMES: readonly EventName[] = ["leave.approved"];

export type EventHandler<N extends EventName> = (
  payload: EventPayloads[N],
) => unknown | Promise<unknown>;

export type PublishResult = { subscriber: string; ok: boolean; message?: string };

type Subscription = { subscriber: string; handler: (payload: unknown) => unknown };

const subscriptions = new Map<EventName, Subscription[]>();

export function subscribe<N extends EventName>(
  name: N,
  handler: EventHandler<N>,
  subscriber?: string,
): () => void {
  if (!EVENT_NAMES.includes(name)) throw new Error(`Unknown event "${String(name)}"`);
  const list = subscriptions.get(name) ?? [];
  const entry: Subscription = {
    subscriber: subscriber ?? (handler.name || `subscriber-${list.length + 1}`),
    handler: handler as (payload: unknown) => unknown,
  };
  list.push(entry);
  subscriptions.set(name, list);
  return () => {
    const current = subscriptions.get(name) ?? [];
    subscriptions.set(
      name,
      current.filter((s) => s !== entry),
    );
  };
}

export async function publish<N extends EventName>(
  name: N,
  payload: EventPayloads[N],
): Promise<PublishResult[]> {
  const results: PublishResult[] = [];
  for (const { subscriber, handler } of [...(subscriptions.get(name) ?? [])]) {
    try {
      await handler(payload);
      results.push({ subscriber, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("warn", "subscriber failed", { event: name, subscriber, message });
      results.push({ subscriber, ok: false, message });
    }
  }
  return results;
}

/** Removes every subscription. For tests only. */
export function clearSubscriptions(): void {
  subscriptions.clear();
}
