import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { getActorTree } from "../../src/tools/get-actor-tree.js";
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

describe("get_actor_tree tool", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns empty tree when no actors", () => {
    const result = getActorTree(store);
    const data = JSON.parse(result.content[0].text);
    expect(data.tree).toEqual([]);
    expect(data.totalActors).toBe(0);
  });

  it("builds nested hierarchy from parent-child relationships", () => {
    store.registerActor(
      makeActorEvent({ sessionId: "x:0", name: "app", parentId: undefined }),
    );
    store.registerActor(
      makeActorEvent({
        sessionId: "x:0:agents",
        name: "agents",
        parentId: "x:0",
      }),
    );
    store.registerActor(
      makeActorEvent({
        sessionId: "x:0:sessions",
        name: "sessions",
        parentId: "x:0",
      }),
    );
    store.registerActor(
      makeActorEvent({
        sessionId: "x:0:agents:a1",
        name: "agent-1",
        parentId: "x:0:agents",
      }),
    );

    const result = getActorTree(store);
    const data = JSON.parse(result.content[0].text);

    expect(data.totalActors).toBe(4);
    expect(data.tree).toHaveLength(1);

    const root = data.tree[0];
    expect(root.sessionId).toBe("x:0");
    expect(root.children).toHaveLength(2);

    const agents = root.children.find(
      (c: { name: string }) => c.name === "agents",
    );
    expect(agents.children).toHaveLength(1);
    expect(agents.children[0].name).toBe("agent-1");
  });

  it("treats actors with unknown parentId as roots", () => {
    store.registerActor(
      makeActorEvent({
        sessionId: "x:1",
        name: "orphan",
        parentId: "nonexistent",
      }),
    );

    const result = getActorTree(store);
    const data = JSON.parse(result.content[0].text);

    expect(data.tree).toHaveLength(1);
    expect(data.tree[0].sessionId).toBe("x:1");
  });
});
