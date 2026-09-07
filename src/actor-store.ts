import type {
  ActorRecord,
  ActorSnapshot,
  EventRecord,
  TransitionRecord,
  ActorEvent,
  SnapshotEvent,
  XStateEvent,
} from "./types.js";
import { RingBuffer } from "./types.js";
import type { Logger } from "./logger.js";
import { createRedactor, type RedactionOptions } from "./inspection-policy.js";
import { safeStringify } from "./safe-stringify.js";

export type ActorRegisteredCallback = (sessionId: string) => void;
export type ActorRemovedCallback = (sessionId: string) => void;
export type SnapshotUpdatedCallback = (sessionId: string) => void;
export type StoreCleared = () => void;

export class ActorStore {
  private actors = new Map<string, ActorRecord>();
  private onRegisterCallbacks: ActorRegisteredCallback[] = [];
  private onRemovedCallbacks: ActorRemovedCallback[] = [];
  private onSnapshotCallbacks: SnapshotUpdatedCallback[] = [];
  private onClearCallbacks: StoreCleared[] = [];

  private readonly redact: (value: unknown) => unknown;

  constructor(
    private bufferSize: number,
    private logger: Logger,
    redaction?: RedactionOptions,
  ) {
    this.redact = createRedactor(redaction);
  }

  /** Keep canonical payload names so suffix rules also match transfer and export wrappers. */
  redactField(field: string, value: unknown): unknown {
    const result = this.redact({ [field]: value });
    return result && typeof result === "object"
      ? (result as Record<string, unknown>)[field]
      : "[OMITTED]";
  }

  private redactSnapshot(
    snapshot: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = this.redactField("snapshot", snapshot);
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {
          status: "unknown",
          value: "[OMITTED]",
          context: "[OMITTED]",
          output: "[OMITTED]",
        };
  }

  onActorRegistered(cb: ActorRegisteredCallback): void {
    this.onRegisterCallbacks.push(cb);
  }

  onActorRemoved(cb: ActorRemovedCallback): void {
    this.onRemovedCallbacks.push(cb);
  }

  onSnapshotUpdated(cb: SnapshotUpdatedCallback): void {
    this.onSnapshotCallbacks.push(cb);
  }

  onCleared(cb: StoreCleared): void {
    this.onClearCallbacks.push(cb);
  }

  registerActor(event: ActorEvent): void {
    const {
      sessionId,
      name,
      rootId,
      parentId,
      definition,
      snapshot,
      createdAt,
    } = event;

    const parsedDefinition = this.redactField("definition", definition ?? null);

    let currentSnapshot: ActorSnapshot | null = null;
    if (snapshot && typeof snapshot === "object") {
      const s = this.redactSnapshot(snapshot);
      currentSnapshot = {
        status: (s.status as string) ?? "active",
        value: s.value ?? null,
        context: s.context ?? null,
        output: s.output,
      };
    }

    const record: ActorRecord = {
      sessionId,
      name: this.redactField("name", name ?? sessionId) as string,
      rootId: rootId ?? null,
      parentId: parentId ?? null,
      definition: parsedDefinition,
      currentSnapshot,
      eventHistory: new RingBuffer<EventRecord>(this.bufferSize),
      transitionHistory: new RingBuffer<TransitionRecord>(this.bufferSize),
      createdAt,
      updatedAt: createdAt,
    };

    this.actors.set(sessionId, record);
    this.logger.debug(`Registered actor: ${sessionId} (${record.name})`);
    for (const cb of this.onRegisterCallbacks) cb(sessionId);
  }

  updateSnapshot(event: SnapshotEvent): void {
    const actor = this.actors.get(event.sessionId);
    if (!actor) {
      this.logger.warn(`Snapshot for unknown actor: ${event.sessionId}`);
      return;
    }

    if (event.snapshot && typeof event.snapshot === "object") {
      const s = this.redactSnapshot(event.snapshot);
      const previousValue = actor.currentSnapshot?.value ?? null;
      const previousContext = actor.currentSnapshot?.context ?? null;
      const newValue = s.value ?? actor.currentSnapshot?.value ?? null;
      const newContext = s.context ?? actor.currentSnapshot?.context ?? null;

      actor.currentSnapshot = {
        status:
          (s.status as string) ?? actor.currentSnapshot?.status ?? "active",
        value: newValue,
        context: newContext,
        output: s.output,
      };

      // Track transition when value OR context changes
      const valueChanged =
        safeStringify(previousValue) !== safeStringify(newValue);
      const contextChanged =
        safeStringify(previousContext) !== safeStringify(newContext);
      if (newValue !== null && (valueChanged || contextChanged)) {
        const eventType = (
          this.redactField("event", event.event) as
            | Record<string, unknown>
            | undefined
        )?.type;
        actor.transitionHistory.push({
          fromValue: previousValue,
          toValue: newValue,
          event: typeof eventType === "string" ? eventType : "unknown",
          timestamp: event.createdAt,
        });
      }
    }

    actor.updatedAt = event.createdAt;
    for (const cb of this.onSnapshotCallbacks) cb(event.sessionId);
  }

  addEvent(event: XStateEvent): void {
    const actor = this.actors.get(event.sessionId);
    if (!actor) {
      this.logger.warn(`Event for unknown actor: ${event.sessionId}`);
      return;
    }

    const sanitized = this.redactField("event", event.event);
    const record: EventRecord = {
      event:
        sanitized && typeof sanitized === "object"
          ? (sanitized as Record<string, unknown>)
          : { type: "[OMITTED]" },
      sourceId: event.sourceId ?? null,
      createdAt: event.createdAt,
    };

    actor.eventHistory.push(record);
    actor.updatedAt = event.createdAt;
  }

  removeActor(sessionId: string): boolean {
    const deleted = this.actors.delete(sessionId);
    if (deleted) {
      this.logger.debug(`Removed actor: ${sessionId}`);
      for (const cb of this.onRemovedCallbacks) cb(sessionId);
    }
    return deleted;
  }

  getActor(sessionId: string): ActorRecord | undefined {
    return this.actors.get(sessionId);
  }

  listActors(): ActorRecord[] {
    return Array.from(this.actors.values());
  }

  getChildCount(sessionId: string): number {
    let count = 0;
    for (const actor of this.actors.values()) {
      if (actor.parentId === sessionId) {
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.actors.clear();
    this.logger.info("Actor store cleared");
    for (const cb of this.onClearCallbacks) cb();
  }

  get size(): number {
    return this.actors.size;
  }
}
