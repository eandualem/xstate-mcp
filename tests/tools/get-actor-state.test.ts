import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { getActorState } from "../../src/tools/get-actor-state.js";

const logger = new Logger("error");

describe("get_actor_state tool", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0:agents",
      rootId: "x:0",
      parentId: "x:0",
      name: "agentsMachine",
      snapshot: {
        status: "active",
        value: "idle",
        context: { entities: [], selectedId: null },
      },
      createdAt: "2026-02-28T12:00:00.000Z",
    });
  });

  it("returns full snapshot for valid sessionId", () => {
    const result = getActorState(store, "x:0:agents");
    const data = JSON.parse(result.content[0].text);

    expect(data.sessionId).toBe("x:0:agents");
    expect(data.name).toBe("agentsMachine");
    expect(data.status).toBe("active");
    expect(data.value).toBe("idle");
    expect(data.context).toEqual({ entities: [], selectedId: null });
    expect(data.parentId).toBe("x:0");
  });

  it("excludes context when excludeContext is true", () => {
    const result = getActorState(store, "x:0:agents", {
      excludeContext: true,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.context).toBe("[excluded]");
    expect(data.value).toBe("idle"); // other fields unaffected
  });

  it("truncates context when contextMaxChars is set", () => {
    // Register actor with large context
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0:big",
      rootId: "x:0",
      name: "bigActor",
      snapshot: {
        status: "active",
        value: "idle",
        context: { data: "a".repeat(500) },
      },
      createdAt: "2026-02-28T12:00:00.000Z",
    });

    const result = getActorState(store, "x:0:big", {
      contextMaxChars: 20,
    });
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.context).toBe("string");
    expect(data.context.length).toBeLessThan(100);
    expect(data.context).toContain("[truncated, full size:");
  });

  it("does not truncate small context", () => {
    const result = getActorState(store, "x:0:agents", {
      contextMaxChars: 10000,
    });
    const data = JSON.parse(result.content[0].text);
    // Context fits within limit — returned as-is (parsed back to object)
    expect(data.context).toEqual({ entities: [], selectedId: null });
  });

  it("excludeContext takes precedence over contextMaxChars", () => {
    const result = getActorState(store, "x:0:agents", {
      excludeContext: true,
      contextMaxChars: 10,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.context).toBe("[excluded]");
  });

  it("returns error for unknown sessionId", () => {
    const result = getActorState(store, "nonexistent");
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(data.error).toContain("nonexistent");
  });
});
