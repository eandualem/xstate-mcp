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

  it("filters actors by status", () => {
    store.registerActor(makeActorEvent());
    store.registerActor(
      makeActorEvent({
        sessionId: "x:1",
        name: "stopped-actor",
        snapshot: { status: "stopped", value: "final", context: {} },
      }),
    );
    store.registerActor(
      makeActorEvent({
        sessionId: "x:2",
        name: "done-actor",
        snapshot: { status: "done", value: "complete", context: {} },
      }),
    );

    const activeResult = listActors(store, "active");
    const activeData = JSON.parse(activeResult.content[0].text);
    expect(activeData.totalActors).toBe(1);
    expect(activeData.actors[0].sessionId).toBe("x:0");

    const stoppedResult = listActors(store, "stopped");
    const stoppedData = JSON.parse(stoppedResult.content[0].text);
    expect(stoppedData.totalActors).toBe(1);
    expect(stoppedData.actors[0].sessionId).toBe("x:1");
  });

  it("returns empty when no actors match status filter", () => {
    store.registerActor(makeActorEvent());
    const result = listActors(store, "error");
    const data = JSON.parse(result.content[0].text);
    expect(data.totalActors).toBe(0);
    expect(data.actors).toEqual([]);
  });

  it("returns all actors when no status filter", () => {
    store.registerActor(makeActorEvent());
    store.registerActor(
      makeActorEvent({
        sessionId: "x:1",
        name: "done-actor",
        snapshot: { status: "done", value: "final", context: {} },
      }),
    );

    const result = listActors(store);
    const data = JSON.parse(result.content[0].text);
    expect(data.totalActors).toBe(2);
  });

  it("returns actor summaries", () => {
    store.registerActor(makeActorEvent());
    store.registerActor(
      makeActorEvent({
        sessionId: "x:0:agents",
        name: "agents",
        parentId: "x:0",
      }),
    );

    const result = listActors(store);
    const data = JSON.parse(result.content[0].text);

    expect(data.totalActors).toBe(2);
    expect(data.actors[0]).toEqual({
      sessionId: "x:0",
      localSessionId: "x:0",
      connectionId: null,
      applicationName: null,
      name: "app",
      currentState: "idle",
      status: "active",
      childCount: 1,
    });
  });
});
