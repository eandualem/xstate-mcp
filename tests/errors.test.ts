import { describe, it, expect, beforeEach } from "vitest";
import { ActorStore } from "../src/actor-store.js";
import { Logger } from "../src/logger.js";
import { actorNotFoundResult } from "../src/errors.js";

const logger = new Logger("error");

describe("actorNotFoundResult", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  it("returns error with suggestion to connect when store is empty", () => {
    const result = actorNotFoundResult("x:99", store);
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(data.error).toBe("Actor not found: x:99");
    expect(data.actorCount).toBe(0);
    expect(data.suggestion).toContain("No actors are currently registered");
  });

  it("returns error with suggestion to list_actors when store has actors", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = actorNotFoundResult("x:99", store);
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(data.error).toBe("Actor not found: x:99");
    expect(data.actorCount).toBe(1);
    expect(data.suggestion).toContain("list_actors");
  });

  it("includes correct actor count with multiple actors", () => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:0",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:2",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = actorNotFoundResult("x:99", store);
    const data = JSON.parse(result.content[0].text);

    expect(data.actorCount).toBe(3);
    expect(data.suggestion).toContain("3 registered actor(s)");
  });
});
