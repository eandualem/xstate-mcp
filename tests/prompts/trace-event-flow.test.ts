import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { traceEventFlow } from "../../src/prompts/trace-event-flow.js";

const logger = new Logger("error");

describe("trace_event_flow prompt", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns error message for unknown actor", () => {
    const result = traceEventFlow(store, "unknown");
    const text = result.messages[0].content.text;

    expect(text).toContain("not found");
    expect(text).toContain("list_actors");
  });

  it("includes trace tasks for valid actor", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "flowMachine",
      snapshot: { status: "active", value: "idle" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = traceEventFlow(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("flowMachine");
    expect(text).toContain("Chronological walkthrough");
    expect(text).toContain("Events without transitions");
    expect(text).toContain("Timing patterns");
    expect(text).toContain("Current state reasoning");
    expect(result.messages[0].role).toBe("user");
  });

  it("includes transitions when present", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "flowMachine",
      snapshot: { status: "active", value: "idle" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // Trigger a state transition via snapshot update
    store.updateSnapshot({
      type: "@xstate.snapshot",
      sessionId: "x:0",
      snapshot: { status: "active", value: "loading" },
      event: { type: "LOAD" },
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const result = traceEventFlow(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("State Transitions");
    expect(text).toContain("idle");
    expect(text).toContain("loading");
  });

  it("includes events when present", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "flowMachine",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    store.addEvent({
      type: "@xstate.event",
      sessionId: "x:0",
      event: { type: "CLICK" },
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    store.addEvent({
      type: "@xstate.event",
      sessionId: "x:0",
      event: { type: "SUBMIT" },
      createdAt: "2026-01-01T00:00:02.000Z",
    });

    const result = traceEventFlow(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("Events (chronological)");
    expect(text).toContain("CLICK");
    expect(text).toContain("SUBMIT");
  });

  it("shows empty messages when no events or transitions", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      name: "flowMachine",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = traceEventFlow(store, "x:0");
    const text = result.messages[0].content.text;

    expect(text).toContain("No state transitions recorded yet");
    expect(text).toContain("No events recorded yet");
  });
});
