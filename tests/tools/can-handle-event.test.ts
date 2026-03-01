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

  it("checks correct child state for compound state values", () => {
    const panelDef = {
      id: "panel",
      initial: "open",
      states: {
        panel: {
          initial: "open",
          states: {
            open: { on: { CLOSE: "closed" } },
            closed: { on: { OPEN: "open", TOGGLE: "open" } },
          },
        },
      },
    };

    store.registerActor(
      makeActorEvent({
        definition: panelDef,
        snapshot: {
          status: "active",
          value: { panel: "closed" },
          context: {},
        },
      }),
    );

    // TOGGLE is only available in "closed" state, not in "open" (initial)
    const result = canHandleEvent(store, "x:0", "TOGGLE");
    const data = JSON.parse(result.content[0].text);
    expect(data.canHandle).toBe(true);
    expect(data.matchedTransitions).toContain("panel.closed.on.TOGGLE");
  });

  it("falls back to initial when no child value in currentState", () => {
    const machineDef = {
      id: "machine",
      initial: "loading",
      states: {
        loading: {
          initial: "fetching",
          states: {
            fetching: { on: { DONE: "complete" } },
            complete: {},
          },
          on: { CANCEL: "idle" },
        },
        idle: {},
      },
    };

    store.registerActor(
      makeActorEvent({
        definition: machineDef,
        snapshot: { status: "active", value: "loading", context: {} },
      }),
    );

    // When value is a string, falls back to initial ("fetching")
    const result = canHandleEvent(store, "x:0", "DONE");
    const data = JSON.parse(result.content[0].text);
    expect(data.canHandle).toBe(true);
    expect(data.matchedTransitions).toContain("loading.fetching.on.DONE");
  });

  it("handles 3-level deep nesting", () => {
    const deepDef = {
      id: "deep",
      initial: "app",
      states: {
        app: {
          initial: "panel",
          states: {
            panel: {
              initial: "view",
              states: {
                view: {
                  initial: "detail",
                  states: {
                    detail: { on: { EDIT: "editing" } },
                    editing: { on: { SAVE: "detail" } },
                  },
                },
              },
            },
          },
        },
      },
    };

    store.registerActor(
      makeActorEvent({
        definition: deepDef,
        // XState represents this as nested objects: { app: { panel: { view: "editing" } } }
        snapshot: {
          status: "active",
          value: { app: { panel: { view: "editing" } } },
          context: {},
        },
      }),
    );

    const result = canHandleEvent(store, "x:0", "SAVE");
    const data = JSON.parse(result.content[0].text);
    expect(data.canHandle).toBe(true);
    expect(data.matchedTransitions).toContain("app.panel.view.editing.on.SAVE");

    // EDIT should NOT be available in "editing" state
    const result2 = canHandleEvent(store, "x:0", "EDIT");
    const data2 = JSON.parse(result2.content[0].text);
    expect(data2.canHandle).toBe(false);
  });

  it("handles parallel regions with deep nesting", () => {
    const parallelDeepDef = {
      id: "parallelDeep",
      type: "parallel",
      states: {
        nav: {
          initial: "main",
          states: {
            main: {
              initial: "list",
              states: {
                list: { on: { SELECT: "detail" } },
                detail: { on: { BACK: "list" } },
              },
            },
          },
        },
        panel: {
          initial: "open",
          states: {
            open: { on: { CLOSE: "closed" } },
            closed: { on: { OPEN: "open" } },
          },
        },
      },
    };

    store.registerActor(
      makeActorEvent({
        definition: parallelDeepDef,
        // Parallel state with one region nested: { nav: { main: "detail" }, panel: "closed" }
        snapshot: {
          status: "active",
          value: { nav: { main: "detail" }, panel: "closed" },
          context: {},
        },
      }),
    );

    // BACK should be available in nav.main.detail
    const result = canHandleEvent(store, "x:0", "BACK");
    const data = JSON.parse(result.content[0].text);
    expect(data.canHandle).toBe(true);
    expect(data.matchedTransitions).toContain("nav.main.detail.on.BACK");

    // OPEN should be available in panel.closed
    const result2 = canHandleEvent(store, "x:0", "OPEN");
    const data2 = JSON.parse(result2.content[0].text);
    expect(data2.canHandle).toBe(true);
    expect(data2.matchedTransitions).toContain("panel.closed.on.OPEN");

    // SELECT should NOT be available (nav is in "detail", not "list")
    const result3 = canHandleEvent(store, "x:0", "SELECT");
    const data3 = JSON.parse(result3.content[0].text);
    expect(data3.canHandle).toBe(false);
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
