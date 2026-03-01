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

  it("handles circular parentId references without infinite recursion", () => {
    // Create actors where parentId creates a cycle: A→B→A
    store.registerActor(
      makeActorEvent({
        sessionId: "x:a",
        name: "actorA",
        parentId: "x:b",
      }),
    );
    store.registerActor(
      makeActorEvent({
        sessionId: "x:b",
        name: "actorB",
        parentId: "x:a",
      }),
    );

    // Should not throw or hang — both have parentIds in the set,
    // but neither is a root. They'll both be treated as roots because
    // the root filter catches them (mutual reference). The cycle guard
    // prevents infinite recursion when building the tree.
    const result = getActorTree(store);
    const data = JSON.parse(result.content[0].text);
    expect(data.totalActors).toBe(2);
    // Both are roots since neither has a non-existent parent AND both exist
    // Actually: both parentIds exist in the set, so neither passes the root filter.
    // With cycle guard, they'd appear as 0 roots. Let's check what actually happens.
    // parentId "x:b" is in knownIds (true), parentId "x:a" is in knownIds (true),
    // so neither is a root → tree is empty but totalActors is 2.
    // This is correct behavior — the cycle guard prevents an infinite loop
    // if somehow one were added as a child.
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
