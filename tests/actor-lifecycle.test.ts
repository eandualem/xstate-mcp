import { describe, expect, it } from "vitest";
import { ActorStore } from "../src/actor-store.js";
import { Logger } from "../src/logger.js";
import { getActorState } from "../src/tools/get-actor-state.js";

const createdAt = "2026-09-07T12:00:00.000Z";

function setup(snapshot: Record<string, unknown>, capacity = 3) {
  const store = new ActorStore(capacity, new Logger("error"));
  store.registerActor({
    type: "@xstate.actor",
    sessionId: "actor",
    snapshot,
    createdAt,
  });
  return {
    store,
    actor: store.getActor("actor")!,
    update(snapshot: Record<string, unknown>) {
      store.updateSnapshot({
        type: "@xstate.snapshot",
        sessionId: "actor",
        snapshot,
        event: { type: "UPDATE" },
        createdAt,
      });
    },
  };
}

describe("actor lifecycle data", () => {
  it("exposes results from registration, including falsy outputs", () => {
    for (const output of [42, 0, false, "", null]) {
      const { store } = setup({ status: "done", output });
      expect(getActorState(store, "actor").structuredContent).toMatchObject({
        status: "done",
        value: null,
        context: null,
        output,
        error: null,
      });
    }
  });

  it("keeps only supported error details, including native Error properties", () => {
    const error = Object.assign(new TypeError("service failed"), {
      code: "SERVICE_FAILED",
      credentials: "private",
      cause: new Error("internal"),
    });
    const { store, actor } = setup({ status: "error", error });
    expect(actor.currentSnapshot?.error).toEqual({
      name: "TypeError",
      message: "service failed",
      code: "SERVICE_FAILED",
    });
    expect(getActorState(store, "actor").structuredContent).toMatchObject({
      error: actor.currentSnapshot?.error,
      output: null,
    });
  });

  it.each([
    ["rejected", { message: "rejected" }],
    [42, { message: "42" }],
    [false, { message: "false" }],
    [{}, { message: "Error details unavailable" }],
    [{ message: {}, code: {} }, { message: "Error details unavailable" }],
    [
      { message: "failure", code: 503 },
      { message: "failure", code: 503 },
    ],
  ])("handles serialized and non-Error rejections: %j", (error, expected) => {
    const { actor } = setup({ status: "error", error });
    expect(actor.currentSnapshot?.error).toEqual(expected);
  });

  it("bounds error text and omits stack, cause, and arbitrary fields", () => {
    const { actor } = setup({
      status: "error",
      error: {
        name: "N".repeat(1000),
        message: "M".repeat(10000),
        code: "C".repeat(1000),
        stack: "private",
        cause: { secret: "private" },
      },
    });
    expect(actor.currentSnapshot?.error).toEqual({
      name: "N".repeat(256),
      message: "M".repeat(4096),
      code: "C".repeat(256),
    });
  });

  it.each(["done", "error", "stopped"])(
    "records status-only %s changes without a state value",
    (status) => {
      const { actor, update } = setup({ status: "active" });
      update({ status });
      expect(actor.transitionHistory.toArray()).toEqual([
        {
          type: "lifecycle",
          changes: ["status"],
          fromValue: null,
          toValue: null,
          fromStatus: "active",
          toStatus: status,
          event: "UPDATE",
          timestamp: createdAt,
        },
      ]);
    },
  );

  it("clears an explicitly reset context and distinguishes context changes", () => {
    const { actor, update } = setup({
      status: "active",
      value: "idle",
      context: { count: 1 },
    });
    update({ context: null });
    expect(actor.currentSnapshot?.context).toBeNull();
    expect(actor.currentSnapshot?.value).toBe("idle");
    expect(actor.transitionHistory.toArray()[0]).toMatchObject({
      type: "context",
      changes: ["context"],
      fromValue: "idle",
      toValue: "idle",
    });
    update({ value: null });
    expect(actor.currentSnapshot?.value).toBeNull();
    expect(actor.transitionHistory.toArray()[1]).toMatchObject({
      type: "state",
      changes: ["value"],
      toValue: null,
    });
  });

  it("retains simultaneous state, context, status, and result changes", () => {
    const { actor, update } = setup({
      status: "active",
      value: "loading",
      context: {},
    });
    update({
      status: "done",
      value: "ready",
      context: { count: 1 },
      output: 42,
    });
    expect(actor.transitionHistory.toArray()[0]).toMatchObject({
      type: "state",
      changes: ["value", "context", "status", "output"],
      fromStatus: "active",
      toStatus: "done",
      output: 42,
    });
  });

  it("tracks result-only changes, clears stale results, and skips duplicates", () => {
    const { actor, update } = setup({ status: "error", error: "first" });
    update({ status: "error", error: "second" });
    update({ status: "error", error: "second" });
    expect(actor.transitionHistory.size).toBe(1);
    expect(actor.transitionHistory.toArray()[0]).toMatchObject({
      type: "lifecycle",
      changes: ["error"],
      error: { message: "second" },
    });
    update({ status: "done", output: 42 });
    expect(actor.currentSnapshot?.error).toBeUndefined();
    update({ status: "active" });
    expect(actor.currentSnapshot?.output).toBeUndefined();
    expect(actor.currentSnapshot?.error).toBeUndefined();
    expect(actor.transitionHistory.toArray()[2]).toMatchObject({
      changes: ["status", "output"],
    });
  });

  it("bounds mixed timeline entries while retaining their lifetime count", () => {
    const { actor, update } = setup({ status: "active", context: 0 }, 2);
    update({ context: 1 });
    update({ status: "done", output: false });
    update({ status: "stopped" });
    expect(actor.transitionHistory.size).toBe(2);
    expect(actor.transitionHistory.total).toBe(3);
    expect(
      actor.transitionHistory.toArray().map((entry) => entry.toStatus),
    ).toEqual(["done", "stopped"]);
  });
});
