import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActorStore } from "../src/actor-store.js";
import { Logger } from "../src/logger.js";

const logger = new Logger("error");

describe("ActorStore callbacks", () => {
  let store: ActorStore;

  beforeEach(() => {
    store = new ActorStore(100, logger);
  });

  describe("onActorRegistered", () => {
    it("fires callback when an actor is registered", () => {
      const cb = vi.fn();
      store.onActorRegistered(cb);

      store.registerActor({
        type: "@xstate.actor",
        sessionId: "x:0",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith("x:0");
    });

    it("fires multiple callbacks in order", () => {
      const calls: string[] = [];
      store.onActorRegistered(() => calls.push("first"));
      store.onActorRegistered(() => calls.push("second"));

      store.registerActor({
        type: "@xstate.actor",
        sessionId: "x:0",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      expect(calls).toEqual(["first", "second"]);
    });

    it("fires for each actor registration", () => {
      const cb = vi.fn();
      store.onActorRegistered(cb);

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

      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenNthCalledWith(1, "x:0");
      expect(cb).toHaveBeenNthCalledWith(2, "x:1");
    });
  });

  describe("onSnapshotUpdated", () => {
    it("fires callback when a snapshot is updated", () => {
      const cb = vi.fn();
      store.onSnapshotUpdated(cb);

      store.registerActor({
        type: "@xstate.actor",
        sessionId: "x:0",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      store.updateSnapshot({
        type: "@xstate.snapshot",
        sessionId: "x:0",
        snapshot: { status: "active", value: "idle" },
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith("x:0");
    });

    it("does not fire when actor is unknown", () => {
      const cb = vi.fn();
      store.onSnapshotUpdated(cb);

      store.updateSnapshot({
        type: "@xstate.snapshot",
        sessionId: "unknown",
        snapshot: { status: "active", value: "idle" },
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("onCleared", () => {
    it("fires callback when store is cleared", () => {
      const cb = vi.fn();
      store.onCleared(cb);

      store.registerActor({
        type: "@xstate.actor",
        sessionId: "x:0",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      store.clear();

      expect(cb).toHaveBeenCalledOnce();
    });

    it("fires even when store is already empty", () => {
      const cb = vi.fn();
      store.onCleared(cb);

      store.clear();

      expect(cb).toHaveBeenCalledOnce();
    });
  });
});
