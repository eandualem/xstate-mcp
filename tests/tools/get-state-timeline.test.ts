import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { getStateTimeline } from "../../src/tools/get-state-timeline.js";
import type { ActorEvent, SnapshotEvent } from "../../src/types.js";

const logger = new Logger("error");

function makeActorEvent(overrides: Partial<ActorEvent> = {}): ActorEvent {
  return {
    type: "@xstate.actor",
    sessionId: "x:0",
    rootId: "x:0",
    name: "app",
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
    sessionId: "x:0",
    rootId: "x:0",
    snapshot: { status: "active", value: "loading", context: {} },
    event: { type: "LOAD" },
    createdAt: "2026-02-28T12:00:01.000Z",
    ...overrides,
  };
}

describe("get_state_timeline tool", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns error for unknown actor", () => {
    const result = getStateTimeline(store, "unknown");
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("unknown");
  });

  it("returns empty timeline when no transitions", () => {
    store.registerActor(makeActorEvent());
    const result = getStateTimeline(store, "x:0");
    const data = JSON.parse(result.content[0].text);
    expect(data.transitions).toEqual([]);
    expect(data.totalTransitions).toBe(0);
    expect(data.currentState).toBe("idle");
  });

  it("tracks state transitions from snapshot updates", () => {
    store.registerActor(makeActorEvent());

    store.updateSnapshot(
      makeSnapshotEvent({
        snapshot: { status: "active", value: "loading", context: {} },
        event: { type: "LOAD" },
        createdAt: "2026-02-28T12:00:01.000Z",
      }),
    );

    store.updateSnapshot(
      makeSnapshotEvent({
        snapshot: { status: "active", value: "ready", context: {} },
        event: { type: "LOAD_SUCCESS" },
        createdAt: "2026-02-28T12:00:02.000Z",
      }),
    );

    const result = getStateTimeline(store, "x:0");
    const data = JSON.parse(result.content[0].text);

    expect(data.totalTransitions).toBe(2);
    expect(data.transitions).toHaveLength(2);
    expect(data.transitions[0]).toEqual({
      type: "state",
      changes: ["value"],
      fromStatus: "active",
      toStatus: "active",
      fromValue: "idle",
      toValue: "loading",
      event: "LOAD",
      timestamp: "2026-02-28T12:00:01.000Z",
    });
    expect(data.transitions[1]).toEqual({
      type: "state",
      changes: ["value"],
      fromStatus: "active",
      toStatus: "active",
      fromValue: "loading",
      toValue: "ready",
      event: "LOAD_SUCCESS",
      timestamp: "2026-02-28T12:00:02.000Z",
    });
  });

  it("distinguishes context changes when value stays the same", () => {
    store.registerActor(makeActorEvent());

    // Same value, different context — records a context entry
    store.updateSnapshot(
      makeSnapshotEvent({
        snapshot: {
          status: "active",
          value: "idle",
          context: { updated: true },
        },
        event: { type: "CONTEXT_UPDATE" },
      }),
    );

    const result = getStateTimeline(store, "x:0");
    const data = JSON.parse(result.content[0].text);
    expect(data.totalTransitions).toBe(1);
    expect(data.transitions[0].fromValue).toBe("idle");
    expect(data.transitions[0].toValue).toBe("idle");
    expect(data.transitions[0].event).toBe("CONTEXT_UPDATE");
    expect(data.transitions[0].type).toBe("context");
    expect(data.transitions[0].changes).toEqual(["context"]);
  });

  it("respects limit parameter", () => {
    store.registerActor(makeActorEvent());

    for (let i = 0; i < 10; i++) {
      store.updateSnapshot(
        makeSnapshotEvent({
          snapshot: {
            status: "active",
            value: `state_${i}`,
            context: {},
          },
          event: { type: `EVENT_${i}` },
          createdAt: `2026-02-28T12:00:${String(i + 1).padStart(2, "0")}.000Z`,
        }),
      );
    }

    const result = getStateTimeline(store, "x:0", 3);
    const data = JSON.parse(result.content[0].text);
    expect(data.transitions).toHaveLength(3);
    expect(data.totalTransitions).toBe(10);
    // Should be the most recent 3
    expect(data.transitions[0].toValue).toBe("state_7");
    expect(data.transitions[2].toValue).toBe("state_9");
  });
});
