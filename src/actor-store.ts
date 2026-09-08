import { randomUUID } from "node:crypto";
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
import { safeStringify } from "./safe-stringify.js";
import { readSnapshot } from "./actor-snapshot.js";

export type ActorRegisteredCallback = (sessionId: string) => void;
export type ActorRemovedCallback = (sessionId: string) => void;
export type SnapshotUpdatedCallback = (sessionId: string) => void;
export type StoreCleared = () => void;

export type ActorStoreChange =
  | { type: "registered" | "snapshot" | "event"; actor: ActorRecord }
  | {
      type: "removed";
      actor: ActorRecord;
      reason: "actor_removed" | "disconnected";
    }
  | { type: "cleared" };

export class ActorStore {
  private changeListeners = new Set<(change: ActorStoreChange) => void>();
  private actors = new Map<string, ActorRecord>();
  private onRegisterCallbacks: ActorRegisteredCallback[] = [];
  private onRemovedCallbacks: ActorRemovedCallback[] = [];
  private onSnapshotCallbacks: SnapshotUpdatedCallback[] = [];
  private onClearCallbacks: StoreCleared[] = [];

  constructor(
    private bufferSize: number,
    private logger: Logger,
  ) {}

  subscribe(cb: (change: ActorStoreChange) => void): () => void {
    const listener = (change: ActorStoreChange) => cb(change);
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emit(change: ActorStoreChange): void {
    for (const cb of [...this.changeListeners]) cb(change);
  }

  onActorRegistered(cb: ActorRegisteredCallback): () => void {
    const listener: ActorRegisteredCallback = (sessionId) => cb(sessionId);
    this.onRegisterCallbacks.push(listener);
    return () => {
      this.onRegisterCallbacks = this.onRegisterCallbacks.filter(
        (candidate) => candidate !== listener,
      );
    };
  }

  onActorRemoved(cb: ActorRemovedCallback): () => void {
    const listener: ActorRemovedCallback = (sessionId) => cb(sessionId);
    this.onRemovedCallbacks.push(listener);
    return () => {
      this.onRemovedCallbacks = this.onRemovedCallbacks.filter(
        (candidate) => candidate !== listener,
      );
    };
  }

  onSnapshotUpdated(cb: SnapshotUpdatedCallback): () => void {
    const listener: SnapshotUpdatedCallback = (sessionId) => cb(sessionId);
    this.onSnapshotCallbacks.push(listener);
    return () => {
      this.onSnapshotCallbacks = this.onSnapshotCallbacks.filter(
        (candidate) => candidate !== listener,
      );
    };
  }

  onCleared(cb: StoreCleared): () => void {
    const listener: StoreCleared = () => cb();
    this.onClearCallbacks.push(listener);
    return () => {
      this.onClearCallbacks = this.onClearCallbacks.filter(
        (candidate) => candidate !== listener,
      );
    };
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

    let parsedDefinition: unknown = null;
    if (definition !== undefined && definition !== null) {
      if (typeof definition === "string") {
        try {
          parsedDefinition = JSON.parse(definition);
        } catch {
          this.logger.warn(`Failed to parse definition for actor ${sessionId}`);
          parsedDefinition = definition;
        }
      } else {
        parsedDefinition = definition;
      }
    }

    let currentSnapshot: ActorSnapshot | null = null;
    if (snapshot && typeof snapshot === "object") {
      currentSnapshot = readSnapshot(snapshot);
    }

    const record: ActorRecord = {
      generation: randomUUID(),
      snapshotVersion: currentSnapshot ? 1 : 0,
      connectionId: event.connectionId ?? null,
      localSessionId: event.localSessionId ?? sessionId,
      applicationName: event.applicationName ?? null,
      sessionId,
      name: name ?? sessionId,
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
    this.emit({ type: "registered", actor: record });
  }

  updateSnapshot(event: SnapshotEvent): void {
    const actor = this.actors.get(event.sessionId);
    if (!actor) {
      this.logger.warn(`Snapshot for unknown actor: ${event.sessionId}`);
      return;
    }

    if (event.snapshot && typeof event.snapshot === "object") {
      actor.snapshotVersion++;
      const previous = actor.currentSnapshot;
      const next = readSnapshot(event.snapshot, previous);
      actor.currentSnapshot = next;

      const fields = ["value", "context", "status", "output", "error"] as const;
      const changes = fields.filter(
        (field) =>
          safeStringify(previous?.[field] ?? null) !==
          safeStringify(next[field] ?? null),
      );
      if (changes.length > 0) {
        const eventType = (event.event as Record<string, unknown> | undefined)
          ?.type;
        actor.transitionHistory.push({
          type: changes.includes("value")
            ? "state"
            : changes.some((field) => field !== "context")
              ? "lifecycle"
              : "context",
          changes,
          fromValue: previous?.value ?? null,
          toValue: next.value,
          fromStatus: previous?.status ?? null,
          toStatus: next.status,
          ...(next.output !== undefined ? { output: next.output } : {}),
          ...(next.error !== undefined ? { error: next.error } : {}),
          event: typeof eventType === "string" ? eventType : "unknown",
          timestamp: event.createdAt,
        });
      }
    }

    actor.updatedAt = event.createdAt;
    for (const cb of this.onSnapshotCallbacks) cb(event.sessionId);
    this.emit({ type: "snapshot", actor });
  }

  addEvent(event: XStateEvent): void {
    const actor = this.actors.get(event.sessionId);
    if (!actor) {
      this.logger.warn(`Event for unknown actor: ${event.sessionId}`);
      return;
    }

    const record: EventRecord = {
      sequence: actor.eventHistory.total + 1,
      event: (event.event as Record<string, unknown>) ?? { type: "unknown" },
      sourceId: event.sourceId ?? null,
      createdAt: event.createdAt,
    };

    actor.eventHistory.push(record);
    actor.updatedAt = event.createdAt;
    this.emit({ type: "event", actor });
  }

  removeActor(
    sessionId: string,
    reason: "actor_removed" | "disconnected" = "actor_removed",
  ): boolean {
    const actor = this.actors.get(sessionId);
    const deleted = this.actors.delete(sessionId);
    if (deleted) {
      this.logger.debug(`Removed actor: ${sessionId}`);
      for (const cb of this.onRemovedCallbacks) cb(sessionId);
      if (actor) this.emit({ type: "removed", actor, reason });
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
    this.emit({ type: "cleared" });
  }

  get size(): number {
    return this.actors.size;
  }
}
