import { z } from "zod";

// --- Configuration ---

export interface Config {
  wsPort: number;
  bufferSize: number;
  logLevel: LogLevel;
  allowedOrigins: string[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

// --- XState Inspection Events (incoming via WebSocket) ---
// Accepts BOTH native XState 5 InspectionEvent format (actorRef/sourceRef objects)
// and @statelyai/inspect serialized format (top-level sessionId/sourceId strings).

const actorRefSchema = z
  .object({ sessionId: z.string().optional(), id: z.string().optional() })
  .passthrough();

const incomingActorEventSchema = z.object({
  type: z.literal("@xstate.actor"),
  // Native format: actorRef object; serialized format: sessionId string
  actorRef: actorRefSchema.optional(),
  sessionId: z.string().optional(),
  rootId: z.string().optional(),
  name: z.string().optional(),
  parentId: z.string().optional(),
  definition: z.unknown().optional(),
  snapshot: z.record(z.unknown()).optional(),
  // Fields present in serialized format but missing in native
  createdAt: z.string().optional(),
  id: z.string().optional(),
  _version: z.union([z.string(), z.number()]).optional(),
});

const incomingSnapshotEventSchema = z.object({
  type: z.literal("@xstate.snapshot"),
  actorRef: actorRefSchema.optional(),
  sessionId: z.string().optional(),
  rootId: z.string().optional(),
  snapshot: z.record(z.unknown()).optional(),
  event: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  id: z.string().optional(),
  _version: z.union([z.string(), z.number()]).optional(),
});

const incomingXstateEventSchema = z.object({
  type: z.literal("@xstate.event"),
  actorRef: actorRefSchema.optional(),
  sessionId: z.string().optional(),
  sourceRef: actorRefSchema.optional(),
  sourceId: z.string().optional(),
  rootId: z.string().optional(),
  event: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  id: z.string().optional(),
  _version: z.union([z.string(), z.number()]).optional(),
});

export const inspectionEventSchema = z.discriminatedUnion("type", [
  incomingActorEventSchema,
  incomingSnapshotEventSchema,
  incomingXstateEventSchema,
]);

export type IncomingEvent = z.infer<typeof inspectionEventSchema>;

// --- Normalized internal types (what ActorStore consumes) ---

export interface ActorEvent {
  type: "@xstate.actor";
  sessionId: string;
  rootId?: string;
  name?: string;
  parentId?: string;
  definition?: unknown;
  snapshot?: Record<string, unknown>;
  createdAt: string;
}

export interface SnapshotEvent {
  type: "@xstate.snapshot";
  sessionId: string;
  rootId?: string;
  snapshot?: Record<string, unknown>;
  event?: Record<string, unknown>;
  createdAt: string;
}

export interface XStateEvent {
  type: "@xstate.event";
  sessionId: string;
  rootId?: string;
  sourceId?: string;
  event?: Record<string, unknown>;
  createdAt: string;
}

export type InspectionEvent = ActorEvent | SnapshotEvent | XStateEvent;

// --- Actor Registry ---

export interface EventRecord {
  event: Record<string, unknown>;
  sourceId: string | null;
  createdAt: string;
}

export interface TransitionRecord {
  fromValue: unknown;
  toValue: unknown;
  event: string;
  timestamp: string;
}

export interface ActorSnapshot {
  status: string;
  value: unknown;
  context: unknown;
  output?: unknown;
}

export interface ActorRecord {
  sessionId: string;
  name: string;
  rootId: string | null;
  parentId: string | null;
  definition: unknown | null;
  currentSnapshot: ActorSnapshot | null;
  eventHistory: RingBuffer<EventRecord>;
  transitionHistory: RingBuffer<TransitionRecord>;
  createdAt: string;
  updatedAt: string;
}

// --- Ring Buffer ---

export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;
  private totalAdded = 0;

  constructor(readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
    this.totalAdded++;
  }

  toArray(): T[] {
    if (this.count === 0) return [];

    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;

    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this.buffer[idx] as T);
    }

    return result;
  }

  getRecent(limit: number): T[] {
    const all = this.toArray();
    if (limit >= all.length) return all;
    return all.slice(all.length - limit);
  }

  get size(): number {
    return this.count;
  }

  get total(): number {
    return this.totalAdded;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
    this.totalAdded = 0;
  }
}
