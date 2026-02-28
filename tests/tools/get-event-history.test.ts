import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { getEventHistory } from "../../src/tools/get-event-history.js";
import type { ActorEvent, XStateEvent } from "../../src/types.js";

const logger = new Logger("error");

describe("get_event_history tool", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0:test",
      rootId: "x:0",
      name: "test",
      snapshot: { status: "active", value: "idle", context: {} },
      createdAt: "2026-02-28T12:00:00.000Z",
      id: "evt-1",
      _version: 1,
    } as ActorEvent);

    // Add some events
    for (let i = 0; i < 30; i++) {
      store.addEvent({
        type: "@xstate.event",
        sessionId: "x:0:test",
        rootId: "x:0",
        sourceId: "x:0",
        event: { type: `EVENT_${i}` },
        createdAt: `2026-02-28T12:00:${String(i).padStart(2, "0")}.000Z`,
        id: `evt-${i + 2}`,
        _version: 1,
      } as XStateEvent);
    }
  });

  it("returns events with default limit of 20", () => {
    const result = getEventHistory(store, "x:0:test");
    const data = JSON.parse(result.content[0].text);

    expect(data.events).toHaveLength(20);
    expect(data.totalInBuffer).toBe(30);
    expect(data.bufferCapacity).toBe(100);
    expect(data.events[0].event).toEqual({ type: "EVENT_10" });
  });

  it("respects custom limit", () => {
    const result = getEventHistory(store, "x:0:test", 5);
    const data = JSON.parse(result.content[0].text);

    expect(data.events).toHaveLength(5);
    expect(data.events[0].event).toEqual({ type: "EVENT_25" });
  });

  it("returns error for unknown actor", () => {
    const result = getEventHistory(store, "nonexistent");

    expect(result.isError).toBe(true);
  });
});
