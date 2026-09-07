import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ActorStore, ActorStoreChange } from "./actor-store.js";
import {
  actorCursor,
  actorCursorSchema,
  type ActorRecord,
  type EventRecord,
} from "./types.js";
import { safeStringify } from "./safe-stringify.js";
import type { ToolResult } from "./errors.js";

export const MAX_WAITERS = 100;
export const MAX_WAIT_TIMEOUT_MS = 30000;

// Keep exact-match predicates small enough for synchronous inspection callbacks.
function boundedStateValue(value: unknown): boolean {
  const pending = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++nodes > 1024 || entry.depth > 32) return false;
    if (typeof entry.value === "string") {
      if (entry.value.length > 1024) return false;
    } else {
      if (
        !entry.value ||
        typeof entry.value !== "object" ||
        Array.isArray(entry.value)
      )
        return false;
      const keys = Object.keys(entry.value);
      if (keys.length + nodes + pending.length > 1024) return false;
      for (const key of keys) {
        if (key.length > 1024) return false;
        pending.push({
          value: (entry.value as Record<string, unknown>)[key],
          depth: entry.depth + 1,
        });
      }
    }
  }
  return true;
}

const commonInput = {
  sessionId: z.string().min(1),
  after: actorCursorSchema
    .optional()
    .describe(
      "Observation cursor from get_actor_state or get_event_history; match only newer evidence.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_TIMEOUT_MS)
    .default(5000)
    .describe(
      "Wait duration in milliseconds, 0–30000. Zero checks once without waiting.",
    ),
};

export const waitForStateInputSchema = {
  ...commonInput,
  state: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .refine(
      boundedStateValue,
      "State value exceeds predicate bounds or contains non-state values",
    )
    .optional()
    .describe(
      "Exact state value: strings/nested objects, at most 32 levels and 1024 nodes; keys/strings at most 1024 characters. No guards are evaluated.",
    ),
  status: z.enum(["active", "done", "error", "stopped"]).optional(),
};
export const waitForEventInputSchema = {
  ...commonInput,
  eventType: z
    .string()
    .min(1)
    .describe(
      "Exact event type. Without after, only events observed after this call can match.",
    ),
};

const stateInput = z
  .object(waitForStateInputSchema)
  .refine(
    (input) => input.state !== undefined || input.status !== undefined,
    "Provide state, status, or both",
  );
const eventInput = z.object(waitForEventInputSchema);
type StateInput = z.infer<typeof stateInput>;
type EventInput = z.infer<typeof eventInput>;
type WaitInput = StateInput | EventInput;

const outcomeSchema = z.enum([
  "matched",
  "timeout",
  "disconnected",
  "actor_removed",
  "actor_replaced",
  "cleared",
  "cancelled",
  "shutdown",
  "actor_not_found",
  "invalid_cursor",
  "history_lost",
  "capacity_exceeded",
  "invalid_input",
]);
type Outcome = z.infer<typeof outcomeSchema>;

export const waitOutputSchema = {
  sessionId: z.string(),
  outcome: outcomeSchema,
  startedAt: z.string(),
  completedAt: z.string(),
  elapsedMs: z.number().nonnegative(),
  cursor: actorCursorSchema.optional(),
  snapshot: z
    .object({
      status: z.string(),
      value: z.unknown(),
      context: z.unknown(),
      output: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
  event: z
    .object({
      sequence: z.number().int().positive().safe(),
      event: z.record(z.string(), z.unknown()),
      sourceId: z.string().nullable(),
      createdAt: z.string(),
    })
    .optional(),
};

type Match =
  | {
      outcome: "matched";
      snapshot?: ActorRecord["currentSnapshot"];
      event?: EventRecord;
    }
  | { outcome: "history_lost" };
interface PendingWait {
  actor: ActorRecord;
  check(): void;
  finish(outcome: Outcome): void;
}

/** One store subscription, at most 100 request timers/abort listeners, no polling. */
export class ActorWaits {
  private pending = new Set<PendingWait>();
  private unsubscribe: () => void;
  private closed = false;

  constructor(private store: ActorStore) {
    this.unsubscribe = store.subscribe((change) => this.onChange(change));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  waitForState(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const parsed = stateInput.safeParse(input);
    return this.wait(parsed.success ? parsed.data : null, signal);
  }

  waitForEvent(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const parsed = eventInput.safeParse(input);
    return this.wait(parsed.success ? parsed.data : null, signal);
  }

  private wait(
    input: WaitInput | null,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const actor = input ? this.store.getActor(input.sessionId) : undefined;
    const result = (outcome: Outcome, match?: Match): ToolResult => {
      const structuredContent = {
        sessionId: input?.sessionId ?? "",
        outcome,
        startedAt,
        completedAt: new Date().toISOString(),
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        ...(actor
          ? {
              cursor: {
                ...actorCursor(actor),
                ...(match?.outcome === "matched" && match.event
                  ? { event: match.event.sequence }
                  : {}),
              },
            }
          : {}),
        ...(match?.outcome === "matched" && match.snapshot
          ? { snapshot: match.snapshot }
          : {}),
        ...(match?.outcome === "matched" && match.event
          ? { event: match.event }
          : {}),
      };
      return {
        content: [{ type: "text", text: safeStringify(structuredContent, 2) }],
        structuredContent,
        isError: outcome !== "matched",
      };
    };
    if (!input) return Promise.resolve(result("invalid_input"));
    if (this.closed) return Promise.resolve(result("shutdown"));
    if (signal?.aborted) return Promise.resolve(result("cancelled"));
    if (!actor) return Promise.resolve(result("actor_not_found"));
    if (
      input.after &&
      (input.after.generation !== actor.generation ||
        input.after.snapshot > actor.snapshotVersion ||
        input.after.event > actor.eventHistory.total)
    ) {
      return Promise.resolve(result("invalid_cursor"));
    }

    let afterEvent = input.after?.event ?? actor.eventHistory.total;
    const evaluate = (): Match | null => {
      if ("eventType" in input) {
        if (afterEvent < actor.eventHistory.total - actor.eventHistory.size)
          return { outcome: "history_lost" };
        const event = actor.eventHistory
          .toArray()
          .find(
            (entry) =>
              entry.sequence > afterEvent &&
              entry.event.type === input.eventType,
          );
        afterEvent = actor.eventHistory.total;
        return event ? { outcome: "matched", event } : null;
      }
      const snapshot = actor.currentSnapshot;
      if (!snapshot || actor.snapshotVersion <= (input.after?.snapshot ?? -1))
        return null;
      if (input.status !== undefined && snapshot.status !== input.status)
        return null;
      if (
        input.state !== undefined &&
        !isDeepStrictEqual(snapshot.value, input.state)
      )
        return null;
      return { outcome: "matched", snapshot };
    };
    const immediate = evaluate();
    if (immediate) return Promise.resolve(result(immediate.outcome, immediate));
    if (input.timeoutMs === 0) return Promise.resolve(result("timeout"));
    if (this.pending.size >= MAX_WAITERS)
      return Promise.resolve(result("capacity_exceeded"));

    const deadline = started + input.timeoutMs;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return Promise.resolve(result("timeout"));
    return new Promise((resolve) => {
      const finish = (outcome: Outcome, match?: Match) => {
        if (!this.pending.delete(waiter)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result(outcome, match));
      };
      const onAbort = () => finish("cancelled");
      const waiter: PendingWait = {
        actor,
        finish,
        check: () => {
          // A busy event loop may deliver inspection before an overdue timer.
          if (performance.now() >= deadline) {
            finish("timeout");
            return;
          }
          const match = evaluate();
          if (match) finish(match.outcome, match);
        },
      };
      const timer = setTimeout(() => finish("timeout"), remainingMs);
      this.pending.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private onChange(change: ActorStoreChange): void {
    for (const waiter of [...this.pending]) {
      if (change.type === "cleared") waiter.finish("cleared");
      else if (change.actor.sessionId === waiter.actor.sessionId) {
        if (change.actor !== waiter.actor) waiter.finish("actor_replaced");
        else if (change.type === "removed") waiter.finish(change.reason);
        else waiter.check();
      }
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const waiter of [...this.pending]) waiter.finish("shutdown");
  }
}
