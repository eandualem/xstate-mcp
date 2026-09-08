import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { createActor, createMachine, fromPromise } from "xstate";
import { createInspectionServer } from "../src/inspection-server.js";
import type { RedactionOptions } from "../src/inspection-policy.js";
import { nativeInspectionForwarder } from "./fixtures/native-inspection.js";

const OUTPUT_SECRET = "private-lifecycle-output";
const ERROR_SECRET = "private-lifecycle-error-message";

async function setup(redaction: RedactionOptions) {
  const bridge = createInspectionServer({
    wsPort: 0,
    logLevel: "error",
    redaction,
  });
  const client = new Client({ name: "policy-lifecycle", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await bridge.close();
  });
  await Promise.all([
    bridge.start(serverTransport),
    client.connect(clientTransport),
  ]);
  await client.listTools();
  const address = bridge.address;
  if (!address || typeof address === "string") throw new Error("Missing port");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(ws, "open");
  onTestFinished(() => ws.terminate());
  const observed: unknown[] = [];
  const unsubscribe = bridge.store.subscribe((change) => {
    if (change.type === "cleared") return;
    observed.push({
      snapshot: change.actor.currentSnapshot,
      events: change.actor.eventHistory.toArray(),
      timeline: change.actor.transitionHistory.toArray(),
    });
  });
  onTestFinished(unsubscribe);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0].text)).toEqual(result.structuredContent);
    return result;
  };
  return { bridge, client, call, observed, ...nativeInspectionForwarder(ws) };
}

describe("redacted lifecycle evidence across managed server and verification waits", () => {
  it("evaluates state predicates against sanitized evidence", async () => {
    const { bridge, call, inspect, flush } = await setup({
      paths: [["snapshot", "value"]],
    });
    const actor = createActor(
      createMachine({
        initial: "private-state",
        states: { "private-state": {} },
      }),
      { inspect },
    );
    onTestFinished(() => {
      actor.stop();
    });
    actor.start();
    await flush();
    const sessionId = bridge.store
      .listActors()
      .find((record) => record.localSessionId === actor.sessionId)!.sessionId;
    const raw = await call("wait_for_state", {
      sessionId,
      state: "private-state",
      timeoutMs: 0,
    });
    expect(raw.structuredContent).toMatchObject({ outcome: "timeout" });
    const sanitized = await call("wait_for_state", {
      sessionId,
      state: "[REDACTED]",
      timeoutMs: 0,
    });
    expect(sanitized.structuredContent).toMatchObject({
      outcome: "matched",
      snapshot: { value: "[REDACTED]", status: "active" },
    });
    expect(JSON.stringify(sanitized)).not.toContain("private-state");
    expect(actor.getSnapshot().value).toBe("private-state");
  });

  it.each(["done", "error"] as const)(
    "retains sanitized %s evidence before observers and every MCP read surface",
    async (status) => {
      const { bridge, client, call, observed, inspect, flush, sent } =
        await setup({
          keys: ["sourceId"],
          paths: [
            ["error", "message"],
            ["event", "data", "message"],
          ],
        });
      let resolve!: (output: unknown) => void;
      let reject!: (error: Error) => void;
      const work = new Promise<unknown>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const actor = createActor(
        fromPromise(() => work),
        { inspect },
      );
      actor.subscribe({ error() {} });
      onTestFinished(() => {
        actor.stop();
      });
      actor.start();
      await flush();
      const discovery = await call("list_actors", {});
      const actors = (
        discovery.structuredContent as {
          actors: { sessionId: string; localSessionId: string }[];
        }
      ).actors;
      const sessionId = actors.find(
        (record) => record.localSessionId === actor.sessionId,
      )!.sessionId;
      expect(sessionId).not.toBe(actor.sessionId);
      const before = await call("get_actor_state", { sessionId });
      const cursor = (
        before.structuredContent as { cursor: Record<string, unknown> }
      ).cursor;
      const waitingState = call("wait_for_state", {
        sessionId,
        after: cursor,
        status,
        timeoutMs: 1000,
      });
      const waitingEvent = call("wait_for_event", {
        sessionId,
        after: cursor,
        eventType:
          status === "done"
            ? "xstate.promise.resolve"
            : "xstate.promise.reject",
        timeoutMs: 1000,
      });
      if (status === "done") resolve({ answer: 42, token: OUTPUT_SECRET });
      else
        reject(
          Object.assign(new TypeError(ERROR_SECRET), {
            code: "SERVICE_FAILED",
          }),
        );
      const stateWait = await waitingState;
      const eventWait = await waitingEvent;
      for (const result of [stateWait, eventWait]) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          outcome: "matched",
          sessionId,
        });
      }
      expect(eventWait.structuredContent).toMatchObject({
        event: { sourceId: "[REDACTED]" },
      });
      expect(stateWait.structuredContent).toMatchObject({
        cursor: { generation: cursor.generation },
        snapshot:
          status === "done"
            ? { status, output: { answer: 42, token: "[REDACTED]" } }
            : {
                status,
                error: {
                  name: "TypeError",
                  message: "[REDACTED]",
                  code: "SERVICE_FAILED",
                },
              },
      });
      expect(
        (stateWait.structuredContent as { cursor: { snapshot: number } }).cursor
          .snapshot,
      ).toBeGreaterThan(cursor.snapshot as number);
      expect(
        (eventWait.structuredContent as { cursor: { event: number } }).cursor
          .event,
      ).toBeGreaterThan(cursor.event as number);
      await flush();
      const state = await call("get_actor_state", { sessionId });
      const snapshotResource = await client.readResource({
        uri: `xstate://actor/${sessionId}/snapshot`,
      });
      const resourceContent = snapshotResource.contents[0];
      if (!("text" in resourceContent))
        throw new Error("Expected text resource");
      expect(JSON.parse(resourceContent.text)).toEqual(state.structuredContent);
      const results: unknown[] = [
        stateWait,
        eventWait,
        state,
        snapshotResource,
        observed,
      ];
      for (const name of [
        "list_actors",
        "get_actor_tree",
        "get_event_history",
        "get_state_timeline",
      ]) {
        const result = await call(name, { sessionId, eventType: "NEXT" });
        expect(result.isError, name).not.toBe(true);
        results.push(result);
      }
      results.push(await client.readResource({ uri: "xstate://actors" }));
      results.push(
        await client.readResource({
          uri: `xstate://actor/${sessionId}/definition`,
        }),
      );
      results.push(await client.listResources());
      for (const name of [
        "debug_actor",
        "explain_machine",
        "trace_event_flow",
      ]) {
        const result = await client.getPrompt({
          name,
          arguments: { sessionId },
        });
        expect(JSON.stringify(result)).toContain("[REDACTED]");
        results.push(result);
      }
      const record = bridge.store.getActor(sessionId)!;
      expect(record.transitionHistory.toArray().at(-1)).toMatchObject({
        type: "lifecycle",
        fromStatus: "active",
        toStatus: status,
        changes: status === "done" ? ["status", "output"] : ["status", "error"],
      });
      for (const result of results) {
        const text = JSON.stringify(result);
        expect(text).not.toContain(OUTPUT_SECRET);
        expect(text).not.toContain(ERROR_SECRET);
      }
      expect(JSON.stringify(sent)).toContain(
        status === "done" ? OUTPUT_SECRET : ERROR_SECRET,
      );
      expect(JSON.stringify(actor.getSnapshot())).toContain(
        status === "done" ? OUTPUT_SECRET : "SERVICE_FAILED",
      );
    },
  );
});
