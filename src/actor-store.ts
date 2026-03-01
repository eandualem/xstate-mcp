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

export type ActorRegisteredCallback = (sessionId: string) => void;
export type SnapshotUpdatedCallback = (sessionId: string) => void;
export type StoreCleared = () => void;

export class ActorStore {
  private actors = new Map<string, ActorRecord>();
  private onRegisterCallbacks: ActorRegisteredCallback[] = [];
  private onSnapshotCallbacks: SnapshotUpdatedCallback[] = [];
  private onClearCallbacks: StoreCleared[] = [];

  constructor(
    private bufferSize: number,
    private logger: Logger,
  ) {}

  onActorRegistered(cb: ActorRegisteredCallback): void {
    this.onRegisterCallbacks.push(cb);
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
      const s = snapshot as Record<string, unknown>;
      currentSnapshot = {
        status: (s.status as string) ?? "active",
        value: s.value ?? null,
        context: s.context ?? null,
        output: s.output,
      };
    }

    const record: ActorRecord = {
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
  }

  updateSnapshot(event: SnapshotEvent): void {
    const actor = this.actors.get(event.sessionId);
    if (!actor) {
      this.logger.warn(`Snapshot for unknown actor: ${event.sessionId}`);
      return;
    }

    if (event.snapshot && typeof event.snapshot === "object") {
      const s = event.snapshot as Record<string, unknown>;
      const previousValue = actor.currentSnapshot?.value ?? null;
      const newValue = s.value ?? actor.currentSnapshot?.value ?? null;

      actor.currentSnapshot = {
        status:
          (s.status as string) ?? actor.currentSnapshot?.status ?? "active",
        value: newValue,
        context: s.context ?? actor.currentSnapshot?.context ?? null,
        output: s.output,
      };

      // Track state transition when value changes
      if (
        newValue !== null &&
        JSON.stringify(previousValue) !== JSON.stringify(newValue)
      ) {
        const eventType = (event.event as Record<string, unknown> | undefined)
          ?.type;
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

    const record: EventRecord = {
      event: (event.event as Record<string, unknown>) ?? { type: "unknown" },
      sourceId: event.sourceId ?? null,
      createdAt: event.createdAt,
    };

    actor.eventHistory.push(record);
    actor.updatedAt = event.createdAt;
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
