import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { canHandleEvent } from "../../src/tools/can-handle-event.js";
import type { ActorEvent } from "../../src/types.js";

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

const trafficLightDef = {
  id: "trafficLight",
  initial: "green",
  states: {
    green: { on: { TIMER: "yellow" } },
    yellow: { on: { TIMER: "red" } },
    red: { on: { TIMER: "green", EMERGENCY: "green" } },
  },
  on: { RESET: ".green" },
};

describe("can_handle_event tool", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns error for unknown actor", () => {
    const result = canHandleEvent(store, "unknown", "TIMER");
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("unknown");
  });

  it("returns canHandle:false when no definition", () => {
    store.registerActor(makeActorEvent({ definition: undefined }));
    const result = canHandleEvent(store, "x:0", "TIMER");
    const data = JSON.parse(result.content[0].text);
    expect(data.canHandle).toBe(false);
    expect(data.note).toContain("No machine definition");
  });

  it("finds matching transition in current state", () => {
    store.registerActor(
      makeActorEvent({
        definition: trafficLightDef,
        snapshot: { status: "active", value: "green", context: {} },
      }),
    );

    const result = canHandleEvent(store, "x:0", "TIMER");
    const data = JSON.parse(result.content[0].text);
    expect(data.canHandle).toBe(true);
    expect(data.matchedTransitions).toContain("green.on.TIMER");
  });

  it("finds root-level transitions", () => {
    store.registerActor(
      makeActorEvent({
        definition: trafficLightDef,
        snapshot: { status: "active", value: "red", context: {} },
      }),
    );

    const result = canHandleEvent(store, "x:0", "RESET");
    const data = JSON.parse(result.content[0].text);
    expect(data.canHandle).toBe(true);
    expect(data.matchedTransitions).toContain("(root).on.RESET");
  });

  it("returns canHandle:false for event not handled in current state", () => {
    store.registerActor(
      makeActorEvent({
        definition: trafficLightDef,
        snapshot: { status: "active", value: "green", context: {} },
      }),
    );

    const result = canHandleEvent(store, "x:0", "EMERGENCY");
    const data = JSON.parse(result.content[0].text);
    expect(data.canHandle).toBe(false);
    expect(data.matchedTransitions).toEqual([]);
  });
});
