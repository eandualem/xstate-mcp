import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { explainMachine } from "../../src/prompts/explain-machine.js";

const logger = new Logger("error");

describe("explain_machine prompt", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns error message for unknown actor", () => {
    const result = explainMachine(store, "unknown");
    const text = result.messages[0].content.text;

    expect(text).toContain("not found");
    expect(text).toContain("list_actors");
  });

  it("includes explanation tasks for valid actor", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "formMachine",
      definition: JSON.stringify({
        id: "form",
        initial: "editing",
        states: { editing: {}, submitting: {}, success: {} },
      }),
      snapshot: { status: "active", value: "editing" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = explainMachine(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("formMachine");
    expect(text).toContain("Purpose");
    expect(text).toContain("States");
    expect(text).toContain("Transitions");
    expect(text).toContain("Guards");
    expect(text).toContain("Current position");
    expect(text).toContain("editing");
    expect(result.messages[0].role).toBe("user");
  });

  it("handles actor without machine definition", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "promiseMachine",
      snapshot: { status: "active", value: null },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = explainMachine(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("No machine definition available");
    expect(text).toContain("promiseMachine");
  });

  it("includes context when available", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "testMachine",
      snapshot: {
        status: "active",
        value: "idle",
        context: { items: [1, 2, 3] },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = explainMachine(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("Current Context");
    expect(text).toContain("items");
    expect(text).toContain("1,");
  });
});
