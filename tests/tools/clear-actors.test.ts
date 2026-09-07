import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { ClientRegistry } from "../../src/client-registry.js";
import { Logger } from "../../src/logger.js";
import { clearActors } from "../../src/tools/clear-actors.js";
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

describe("clear_actors tool", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns 0 when store is empty", () => {
    const result = clearActors(store);
    const data = JSON.parse(result.content[0].text);
    expect(data.cleared).toBe(0);
  });

  it("clears all actors and returns count", () => {
    store.registerActor(makeActorEvent());
    store.registerActor(makeActorEvent({ sessionId: "x:1", name: "other" }));

    const result = clearActors(store);
    const data = JSON.parse(result.content[0].text);
    expect(data.cleared).toBe(2);
    expect(store.size).toBe(0);
  });

  it("clears ClientRegistry when provided", () => {
    const registry = new ClientRegistry(1000, logger, {
      writePolicy: { readOnly: false, allow: [{ actor: "*", events: ["*"] }] },
    });
    const ws = {
      readyState: 1,
      OPEN: 1,
      send: vi.fn((_msg: string, cb?: (err?: Error) => void) => {
        if (cb) cb();
      }),
    };
    registry.registerSession(ws as never, "x:0");
    store.registerActor(makeActorEvent());

    clearActors(store, registry);

    expect(store.size).toBe(0);
    expect(registry.getConnectedSessionCount()).toBe(0);
    expect(registry.getConnectedClientCount()).toBe(1);
  });
});
