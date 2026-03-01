import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../src/actor-store.js";
import { Logger } from "../src/logger.js";
import type { ActorEvent, SnapshotEvent, XStateEvent } from "../src/types.js";

function makeActorEvent(overrides: Partial<ActorEvent> = {}): ActorEvent {
  return {
    type: "@xstate.actor",
    sessionId: "x:0:testMachine",
    rootId: "x:0",
    parentId: "x:0",
    name: "testMachine",
    definition: { id: "test", initial: "idle", states: { idle: {} } },
    snapshot: { status: "active", value: "idle", context: {} },
    createdAt: "2026-02-28T12:00:00.000Z",
    ...overrides,
  };
}

function makeSnapshotEvent(
  overrides: Partial<SnapshotEvent> = {},
): SnapshotEvent {
  return {
    type: "@xstate.snapshot",
    sessionId: "x:0:testMachine",
    rootId: "x:0",
    snapshot: { status: "active", value: "loading", context: { items: [] } },
    event: { type: "LOAD" },
    createdAt: "2026-02-28T12:00:01.000Z",
    ...overrides,
  };
}

function makeXStateEvent(overrides: Partial<XStateEvent> = {}): XStateEvent {
  return {
    type: "@xstate.event",
    sessionId: "x:0:testMachine",
    rootId: "x:0",
    sourceId: "x:0",
    event: { type: "LOAD" },
    createdAt: "2026-02-28T12:00:01.000Z",
    ...overrides,
  };
}

describe("ActorStore", () => {
  let store: ActorStore;
  const logger = new Logger("error");

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  describe("registerActor", () => {
    it("registers an actor and retrieves it by sessionId", () => {
      store.registerActor(makeActorEvent());

      const actor = store.getActor("x:0:testMachine");
      expect(actor).toBeDefined();
      expect(actor!.sessionId).toBe("x:0:testMachine");
      expect(actor!.name).toBe("testMachine");
      expect(actor!.parentId).toBe("x:0");
      expect(actor!.rootId).toBe("x:0");
    });

    it("parses object definitions directly", () => {
      store.registerActor(
        makeActorEvent({
          definition: { id: "machine", states: { a: {} } },
        }),
      );

      const actor = store.getActor("x:0:testMachine");
      expect(actor!.definition).toEqual({ id: "machine", states: { a: {} } });
    });

    it("parses string definitions via JSON.parse", () => {
      store.registerActor(
        makeActorEvent({
          definition: JSON.stringify({ id: "machine", states: { a: {} } }),
        }),
      );

      const actor = store.getActor("x:0:testMachine");
      expect(actor!.definition).toEqual({ id: "machine", states: { a: {} } });
    });

    it("stores initial snapshot", () => {
      store.registerActor(makeActorEvent());

      const actor = store.getActor("x:0:testMachine");
      expect(actor!.currentSnapshot).toEqual({
        status: "active",
        value: "idle",
        context: {},
        output: undefined,
      });
    });

    it("handles missing optional fields", () => {
      store.registerActor(
        makeActorEvent({
          name: undefined,
          parentId: undefined,
          definition: undefined,
          snapshot: undefined,
        }),
      );

      const actor = store.getActor("x:0:testMachine");
      expect(actor!.name).toBe("x:0:testMachine");
      expect(actor!.parentId).toBeNull();
      expect(actor!.definition).toBeNull();
      expect(actor!.currentSnapshot).toBeNull();
    });
  });

  describe("updateSnapshot", () => {
    it("updates the current snapshot", () => {
      store.registerActor(makeActorEvent());
      store.updateSnapshot(makeSnapshotEvent());

      const actor = store.getActor("x:0:testMachine");
      expect(actor!.currentSnapshot!.value).toBe("loading");
      expect(actor!.currentSnapshot!.context).toEqual({ items: [] });
    });

    it("ignores snapshot for unknown actor", () => {
      store.updateSnapshot(makeSnapshotEvent({ sessionId: "unknown" }));
      expect(store.size).toBe(0);
    });

    it("updates updatedAt timestamp", () => {
      store.registerActor(makeActorEvent());
      store.updateSnapshot(
        makeSnapshotEvent({
          createdAt: "2026-02-28T13:00:00.000Z",
        }),
      );

      const actor = store.getActor("x:0:testMachine");
      expect(actor!.updatedAt).toBe("2026-02-28T13:00:00.000Z");
    });
  });

  describe("addEvent", () => {
    it("adds event to history", () => {
      store.registerActor(makeActorEvent());
      store.addEvent(makeXStateEvent());

      const actor = store.getActor("x:0:testMachine");
      const events = actor!.eventHistory.toArray();
      expect(events).toHaveLength(1);
      expect(events[0].event).toEqual({ type: "LOAD" });
    });

    it("ignores event for unknown actor", () => {
      store.addEvent(makeXStateEvent({ sessionId: "unknown" }));
      expect(store.size).toBe(0);
    });
  });

  describe("ring buffer behavior", () => {
    it("evicts oldest events when buffer is full", () => {
      const smallStore = new ActorStore(5, logger);
      smallStore.registerActor(makeActorEvent());

      for (let i = 0; i < 10; i++) {
        smallStore.addEvent(
          makeXStateEvent({
            event: { type: `EVENT_${i}` },
            createdAt: `2026-02-28T12:00:${String(i).padStart(2, "0")}.000Z`,
          }),
        );
      }

      const actor = smallStore.getActor("x:0:testMachine");
      const events = actor!.eventHistory.toArray();
      expect(events).toHaveLength(5);
      expect(events[0].event).toEqual({ type: "EVENT_5" });
      expect(events[4].event).toEqual({ type: "EVENT_9" });
    });

    it("tracks total events added", () => {
      const smallStore = new ActorStore(5, logger);
      smallStore.registerActor(makeActorEvent());

      for (let i = 0; i < 10; i++) {
        smallStore.addEvent(makeXStateEvent());
      }

      const actor = smallStore.getActor("x:0:testMachine");
      expect(actor!.eventHistory.size).toBe(5);
      expect(actor!.eventHistory.total).toBe(10);
    });

    it("getRecent returns only the requested number of events", () => {
      store.registerActor(makeActorEvent());

      for (let i = 0; i < 50; i++) {
        store.addEvent(
          makeXStateEvent({
            event: { type: `EVENT_${i}` },
          }),
        );
      }

      const actor = store.getActor("x:0:testMachine");
      const recent = actor!.eventHistory.getRecent(10);
      expect(recent).toHaveLength(10);
      expect(recent[0].event).toEqual({ type: "EVENT_40" });
      expect(recent[9].event).toEqual({ type: "EVENT_49" });
    });
  });

  describe("transition tracking", () => {
    it("records transition when value changes", () => {
      store.registerActor(makeActorEvent());

      store.updateSnapshot(
        makeSnapshotEvent({
          snapshot: { status: "active", value: "loading", context: {} },
          event: { type: "LOAD" },
        }),
      );

      const actor = store.getActor("x:0:testMachine");
      const transitions = actor!.transitionHistory.toArray();
      expect(transitions).toHaveLength(1);
      expect(transitions[0].fromValue).toBe("idle");
      expect(transitions[0].toValue).toBe("loading");
      expect(transitions[0].event).toBe("LOAD");
    });

    it("records transition when context changes but value stays the same", () => {
      store.registerActor(makeActorEvent());

      // First snapshot establishes value="idle", context={}
      // Now send a snapshot where value is still "idle" but context changed
      store.updateSnapshot(
        makeSnapshotEvent({
          snapshot: {
            status: "active",
            value: "idle",
            context: { count: 1 },
          },
          event: { type: "INCREMENT" },
          createdAt: "2026-02-28T12:00:01.000Z",
        }),
      );

      const actor = store.getActor("x:0:testMachine");
      const transitions = actor!.transitionHistory.toArray();
      expect(transitions).toHaveLength(1);
      expect(transitions[0].fromValue).toBe("idle");
      expect(transitions[0].toValue).toBe("idle");
      expect(transitions[0].event).toBe("INCREMENT");
    });

    it("does not record transition when neither value nor context changes", () => {
      store.registerActor(makeActorEvent());

      // Send snapshot with same value and context as initial
      store.updateSnapshot(
        makeSnapshotEvent({
          snapshot: { status: "active", value: "idle", context: {} },
          event: { type: "NOOP" },
        }),
      );

      const actor = store.getActor("x:0:testMachine");
      expect(actor!.transitionHistory.toArray()).toHaveLength(0);
    });
  });

  describe("removeActor", () => {
    it("removes an actor by sessionId", () => {
      store.registerActor(makeActorEvent());
      expect(store.size).toBe(1);

      const result = store.removeActor("x:0:testMachine");
      expect(result).toBe(true);
      expect(store.size).toBe(0);
      expect(store.getActor("x:0:testMachine")).toBeUndefined();
    });

    it("returns false for non-existent actor", () => {
      const result = store.removeActor("nonexistent");
      expect(result).toBe(false);
    });

    it("does not affect other actors", () => {
      store.registerActor(makeActorEvent({ sessionId: "x:0", name: "app" }));
      store.registerActor(makeActorEvent({ sessionId: "x:1", name: "agents" }));

      store.removeActor("x:0");
      expect(store.size).toBe(1);
      expect(store.getActor("x:1")).toBeDefined();
    });
  });

  describe("listActors", () => {
    it("returns empty array when no actors", () => {
      expect(store.listActors()).toEqual([]);
    });

    it("returns all registered actors", () => {
      store.registerActor(makeActorEvent({ sessionId: "x:0", name: "app" }));
      store.registerActor(
        makeActorEvent({ sessionId: "x:0:agents", name: "agents" }),
      );

      const actors = store.listActors();
      expect(actors).toHaveLength(2);
    });
  });

  describe("getChildCount", () => {
    it("counts children of an actor", () => {
      store.registerActor(
        makeActorEvent({
          sessionId: "x:0",
          name: "app",
          parentId: undefined,
        }),
      );
      store.registerActor(
        makeActorEvent({
          sessionId: "x:0:agents",
          name: "agents",
          parentId: "x:0",
        }),
      );
      store.registerActor(
        makeActorEvent({
          sessionId: "x:0:sessions",
          name: "sessions",
          parentId: "x:0",
        }),
      );

      expect(store.getChildCount("x:0")).toBe(2);
      expect(store.getChildCount("x:0:agents")).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all actors", () => {
      store.registerActor(makeActorEvent());
      expect(store.size).toBe(1);

      store.clear();
      expect(store.size).toBe(0);
      expect(store.getActor("x:0:testMachine")).toBeUndefined();
    });
  });
});
