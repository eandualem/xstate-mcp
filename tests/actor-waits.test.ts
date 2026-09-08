import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ActorStore } from "../src/actor-store.js";
import {
  ActorWaits,
  MAX_WAITERS,
  waitOutputSchema,
} from "../src/actor-waits.js";
import { Logger } from "../src/logger.js";
import { actorCursor } from "../src/types.js";
import type { ToolResult } from "../src/errors.js";

const createdAt = "2026-09-07T00:00:00.000Z";

function data(result: ToolResult) {
  expect(JSON.parse(result.content[0].text)).toEqual(
    JSON.parse(JSON.stringify(result.structuredContent)),
  );
  return z.object(waitOutputSchema).parse(result.structuredContent);
}

describe("bounded actor waits", () => {
  let store: ActorStore;
  let waits: ActorWaits;
  const register = (
    snapshot: Record<string, unknown> = {
      status: "active",
      value: "idle",
      context: {},
    },
    sessionId = "actor",
  ) => {
    store.registerActor({
      type: "@xstate.actor",
      sessionId,
      snapshot,
      createdAt,
    });
    return store.getActor(sessionId)!;
  };
  const snapshot = (snapshot: Record<string, unknown>) =>
    store.updateSnapshot({
      type: "@xstate.snapshot",
      sessionId: "actor",
      snapshot,
      createdAt,
    });
  const event = (type: string) =>
    store.addEvent({
      type: "@xstate.event",
      sessionId: "actor",
      event: { type },
      createdAt,
    });

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    store = new ActorStore(2, new Logger("error"));
    waits = new ActorWaits(store);
  });
  afterEach(() => {
    waits.dispose();
    expect(waits.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("matches current state/status with no cursor and treats both predicates as AND", async () => {
    register({ status: "active", value: { editor: "ready", sidebar: "open" } });
    const immediate = data(
      await waits.waitForState({
        sessionId: "actor",
        state: { sidebar: "open", editor: "ready" },
        status: "active",
      }),
    );
    expect(immediate.outcome).toBe("matched");
    expect(immediate.snapshot?.value).toEqual({
      editor: "ready",
      sidebar: "open",
    });
    const pending = waits.waitForState({
      sessionId: "actor",
      state: { editor: "ready", sidebar: "open" },
      status: "done",
    });
    expect(waits.pendingCount).toBe(1);
    snapshot({ status: "done", output: 42 });
    expect(data(await pending)).toMatchObject({
      outcome: "matched",
      snapshot: { status: "done", output: 42 },
    });
  });

  it("requires a newer observed snapshot after a cursor even with equal timestamps", async () => {
    const actor = register();
    const after = actorCursor(actor);
    const pending = waits.waitForState({
      sessionId: "actor",
      state: "idle",
      after,
    });
    event("NO_CHANGE");
    store.updateSnapshot({
      type: "@xstate.snapshot",
      sessionId: "actor",
      createdAt,
    });
    expect(waits.pendingCount).toBe(1);
    snapshot({ status: "active", value: "idle" });
    expect(data(await pending)).toMatchObject({
      outcome: "matched",
      cursor: { snapshot: after.snapshot + 1 },
    });
  });

  it("ignores old events without a cursor and returns the next exact type", async () => {
    register();
    event("READY");
    const pending = waits.waitForEvent({
      sessionId: "actor",
      eventType: "READY",
    });
    event("READY.child");
    expect(waits.pendingCount).toBe(1);
    event("READY");
    expect(data(await pending)).toMatchObject({
      outcome: "matched",
      event: { sequence: 3, event: { type: "READY" }, createdAt },
    });
  });

  it("uses retained history after a cursor and returns a cursor at the matched event", async () => {
    const actor = register();
    const after = actorCursor(actor);
    event("READY");
    event("READY");
    const first = data(
      await waits.waitForEvent({
        sessionId: "actor",
        eventType: "READY",
        after,
      }),
    );
    expect(first).toMatchObject({
      outcome: "matched",
      cursor: { event: 1 },
      event: { sequence: 1 },
    });
    const next = data(
      await waits.waitForEvent({
        sessionId: "actor",
        eventType: "READY",
        after: first.cursor,
      }),
    );
    expect(next).toMatchObject({
      outcome: "matched",
      cursor: { event: 2 },
      event: { sequence: 2 },
    });
  });

  it("reports lost history instead of claiming a retained event was the first match", async () => {
    const actor = register();
    const after = actorCursor(actor);
    event("READY");
    event("OTHER");
    event("READY");
    expect(
      data(
        await waits.waitForEvent({
          sessionId: "actor",
          eventType: "READY",
          after,
        }),
      ),
    ).toMatchObject({ outcome: "history_lost" });
    expect(waits.pendingCount).toBe(0);
  });

  it("does not lose live events as the ring buffer rotates", async () => {
    register();
    const pending = waits.waitForEvent({
      sessionId: "actor",
      eventType: "READY",
    });
    for (let i = 0; i < 20; i++) event("OTHER");
    event("READY");
    expect(data(await pending)).toMatchObject({
      outcome: "matched",
      event: { sequence: 21 },
    });
  });

  it("rejects cursors from old registrations or the future", async () => {
    const actor = register();
    const after = actorCursor(actor);
    for (const cursor of [
      { ...after, snapshot: 2 },
      { ...after, event: 1 },
    ]) {
      expect(
        data(
          await waits.waitForState({
            sessionId: "actor",
            state: "idle",
            after: cursor,
          }),
        ).outcome,
      ).toBe("invalid_cursor");
    }
    register();
    expect(
      data(
        await waits.waitForEvent({
          sessionId: "actor",
          eventType: "READY",
          after,
        }),
      ).outcome,
    ).toBe("invalid_cursor");
  });

  it.each(["state", "event"])(
    "times out %s waits with timing and releases resources",
    async (kind) => {
      register();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const input = {
        sessionId: "actor",
        state: "ready",
        eventType: "READY",
        timeoutMs: 40,
      };
      const pending =
        kind === "state"
          ? waits.waitForState(input, controller.signal)
          : waits.waitForEvent(input, controller.signal);
      vi.advanceTimersByTime(40);
      expect(data(await pending)).toMatchObject({
        outcome: "timeout",
        elapsedMs: 40,
      });
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(waits.pendingCount).toBe(0);
    },
  );

  it("uses timeout zero as a single check without installing a timer", async () => {
    register();
    expect(
      data(
        await waits.waitForState({
          sessionId: "actor",
          state: "idle",
          timeoutMs: 0,
        }),
      ).outcome,
    ).toBe("matched");
    expect(
      data(
        await waits.waitForEvent({
          sessionId: "actor",
          eventType: "READY",
          timeoutMs: 0,
        }),
      ).outcome,
    ).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept an observation after the deadline when the timer is delayed", async () => {
    register();
    const pending = waits.waitForState({
      sessionId: "actor",
      state: "ready",
      timeoutMs: 40,
    });
    const clock = vi.spyOn(performance, "now").mockReturnValue(41);
    snapshot({ value: "ready" });
    expect(data(await pending)).toMatchObject({
      outcome: "timeout",
      elapsedMs: 41,
    });
    clock.mockRestore();
  });

  it.each([-1, 0.5, 30001, Infinity, NaN])(
    "rejects invalid timeout %s before allocating",
    async (timeoutMs) => {
      register();
      for (const result of [
        await waits.waitForState({
          sessionId: "actor",
          state: "ready",
          timeoutMs,
        }),
        await waits.waitForEvent({
          sessionId: "actor",
          eventType: "READY",
          timeoutMs,
        }),
      ]) {
        expect(data(result).outcome).toBe("invalid_input");
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("requires a predicate and returns a structured result for unknown actors", async () => {
    register();
    expect(data(await waits.waitForState({ sessionId: "actor" })).outcome).toBe(
      "invalid_input",
    );
    expect(
      data(await waits.waitForState({ sessionId: "missing", status: "done" }))
        .outcome,
    ).toBe("actor_not_found");
  });

  it("bounds predicate depth, size, and values before observing snapshots", async () => {
    register();
    let deep: unknown = "idle";
    for (let i = 0; i < 33; i++) deep = { child: deep };
    const wide = Object.fromEntries(
      Array.from({ length: 1024 }, (_, i) => [String(i), "idle"]),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.child = cyclic;
    for (const state of [
      deep,
      wide,
      cyclic,
      "s".repeat(1025),
      { child: 1 },
      { child: [] },
    ]) {
      expect(
        data(await waits.waitForState({ sessionId: "actor", state })).outcome,
      ).toBe("invalid_input");
    }
    expect(waits.pendingCount).toBe(0);
  });

  it("bounds pending waits and frees capacity on cancellation", async () => {
    register();
    const controllers = Array.from(
      { length: MAX_WAITERS },
      () => new AbortController(),
    );
    const pending = controllers.map((controller) =>
      waits.waitForEvent(
        { sessionId: "actor", eventType: "READY" },
        controller.signal,
      ),
    );
    expect(waits.pendingCount).toBe(MAX_WAITERS);
    expect(vi.getTimerCount()).toBe(MAX_WAITERS);
    expect(
      data(await waits.waitForState({ sessionId: "actor", state: "ready" }))
        .outcome,
    ).toBe("capacity_exceeded");
    controllers[0].abort();
    expect(data(await pending[0]).outcome).toBe("cancelled");
    const replacement = waits.waitForState({
      sessionId: "actor",
      state: "ready",
    });
    expect(waits.pendingCount).toBe(MAX_WAITERS);
    controllers.forEach((controller) => controller.abort());
    snapshot({ value: "ready" });
    expect(data(await replacement).outcome).toBe("matched");
    await Promise.all(pending);
  });

  it("handles already-cancelled requests and keeps a completed match stable", async () => {
    register();
    const controller = new AbortController();
    const pending = waits.waitForState(
      { sessionId: "actor", state: "ready" },
      controller.signal,
    );
    snapshot({ value: "ready" });
    controller.abort();
    vi.advanceTimersByTime(5000);
    expect(data(await pending).outcome).toBe("matched");
    expect(
      data(
        await waits.waitForState(
          { sessionId: "actor", state: "ready" },
          controller.signal,
        ),
      ).outcome,
    ).toBe("cancelled");
  });

  it.each([
    "actor_removed",
    "disconnected",
    "actor_replaced",
    "cleared",
    "shutdown",
  ] as const)("settles and cleans up on %s", async (outcome) => {
    register();
    const pending = waits.waitForState({ sessionId: "actor", state: "ready" });
    if (outcome === "actor_removed" || outcome === "disconnected")
      store.removeActor("actor", outcome);
    else if (outcome === "actor_replaced") register({ value: "ready" });
    else if (outcome === "cleared") store.clear();
    else waits.dispose();
    expect(data(await pending).outcome).toBe(outcome);
    expect(waits.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not settle waits when another actor disconnects", async () => {
    register();
    register({}, "other");
    const pending = waits.waitForEvent({
      sessionId: "actor",
      eventType: "READY",
    });
    store.removeActor("other", "disconnected");
    expect(waits.pendingCount).toBe(1);
    event("READY");
    expect(data(await pending).outcome).toBe("matched");
  });

  it("disposes its store subscription once and rejects subsequent waits", async () => {
    waits.dispose();
    const unsubscribe = vi.fn(store.subscribe(() => {}));
    const subscribe = vi
      .spyOn(store, "subscribe")
      .mockReturnValueOnce(unsubscribe);
    waits = new ActorWaits(store);
    waits.dispose();
    waits.dispose();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(
      data(await waits.waitForEvent({ sessionId: "actor", eventType: "READY" }))
        .outcome,
    ).toBe("shutdown");
    subscribe.mockRestore();
  });
});
