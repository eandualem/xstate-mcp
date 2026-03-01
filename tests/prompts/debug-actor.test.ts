import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { debugActor } from "../../src/prompts/debug-actor.js";

const logger = new Logger("error");

describe("debug_actor prompt", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns error message for unknown actor", () => {
    const result = debugActor(store, "unknown");
    const text = result.messages[0].content.text;

    expect(text).toContain("not found");
    expect(text).toContain("list_actors");
  });

  it("includes actor state and analysis tasks for valid actor", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "testMachine",
      snapshot: { status: "active", value: "idle", context: { count: 0 } },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = debugActor(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("testMachine");
    expect(text).toContain("x:0");
    expect(text).toContain("idle");
    expect(text).toContain("State consistency");
    expect(text).toContain("Missed transitions");
    expect(text).toContain("Context validity");
    expect(result.messages[0].role).toBe("user");
  });

  it("includes machine definition when available", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "testMachine",
      definition: JSON.stringify({
        id: "test",
        initial: "idle",
        states: { idle: {}, active: {} },
      }),
      snapshot: { status: "active", value: "idle" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = debugActor(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("Machine Definition");
    expect(text).toContain("idle");
    expect(text).toContain("active");
  });

  it("includes event history when events exist", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "testMachine",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    store.addEvent({
      type: "@xstate.event",
      sessionId: "x:0",
      event: { type: "CLICK" },
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const result = debugActor(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("Recent Events");
    expect(text).toContain("CLICK");
  });
});
