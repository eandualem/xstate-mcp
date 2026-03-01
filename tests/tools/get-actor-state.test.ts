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

  it("returns error for unknown sessionId", () => {
    const result = getActorState(store, "nonexistent");
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(data.error).toContain("nonexistent");
  });
});
