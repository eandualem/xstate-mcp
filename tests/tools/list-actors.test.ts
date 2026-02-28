import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { listActors } from "../../src/tools/list-actors.js";
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
    id: "evt-1",
    _version: 1,
    ...overrides,
  };
}

describe("list_actors tool", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns empty array when no actors", () => {
    const result = listActors(store);
    const data = JSON.parse(result.content[0].text);
    expect(data.actors).toEqual([]);
    expect(data.totalActors).toBe(0);
  });

  it("returns actor summaries", () => {
    store.registerActor(makeActorEvent());
    store.registerActor(
      makeActorEvent({
        sessionId: "x:0:agents",
        name: "agents",
        parentId: "x:0",
        id: "evt-2",
      }),
    );

    const result = listActors(store);
    const data = JSON.parse(result.content[0].text);

    expect(data.totalActors).toBe(2);
    expect(data.actors[0]).toEqual({
      sessionId: "x:0",
      name: "app",
      currentState: "idle",
      status: "active",
      childCount: 1,
    });
  });
});
