import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { getMachineDefinition } from "../../src/tools/get-machine-definition.js";

const logger = new Logger("error");

describe("get_machine_definition tool", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns machine definition when available", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0:agents",
      rootId: "x:0",
      name: "agentsMachine",
      definition: {
        id: "agents",
        initial: "idle",
        states: {
          idle: { on: { "sys.refresh": "loading" } },
          loading: {},
        },
      },
      snapshot: { status: "active", value: "idle", context: {} },
      createdAt: "2026-02-28T12:00:00.000Z",
    });

    const result = getMachineDefinition(store, "x:0:agents");
    const data = JSON.parse(result.content[0].text);

    expect(data.sessionId).toBe("x:0:agents");
    expect(data.name).toBe("agentsMachine");
    expect(data.definition.id).toBe("agents");
    expect(data.definition.states.idle.on["sys.refresh"]).toBe("loading");
  });

  it("returns null definition with note when not available", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0:test",
      rootId: "x:0",
      name: "test",
      snapshot: { status: "active", value: "idle", context: {} },
      createdAt: "2026-02-28T12:00:00.000Z",
    });

    const result = getMachineDefinition(store, "x:0:test");
    const data = JSON.parse(result.content[0].text);

    expect(data.definition).toBeNull();
    expect(data.note).toBeDefined();
  });

  it("returns error for unknown actor", () => {
    const result = getMachineDefinition(store, "nonexistent");

    expect(result.isError).toBe(true);
  });
});
