import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished } from "vitest";
import { ActorStore } from "../src/actor-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import { Logger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createWsServer } from "../src/ws-server.js";

interface Command {
  requestId: string;
  sessionId: string;
  event: { type: string };
}
interface AppMessage {
  ready?: boolean;
  rootId?: string;
  id?: number;
  command?: Command;
  commands?: Command[];
}

async function setup(withRegistry = true) {
  const logger = new Logger("error");
  const store = new ActorStore(50, logger);
  const registry = new ClientRegistry(3000, logger, {
    writePolicy: {
      readOnly: false,
      allow: [{ actor: "*", events: ["RUN", "WORK"] }],
    },
  });
  const server = createMcpServer(store, registry, logger);
  const client = new Client({ name: "session-isolation-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const wss = createWsServer({
    port: 0,
    store,
    clientRegistry: withRegistry ? registry : undefined,
    logger,
  });
  await once(wss, "listening");
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const port = address.port;
  const processes = new Set<ChildProcess>();
  onTestFinished(async () => {
    for (const child of processes) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    registry.clear();
    await client.close();
    await server.close();
  });
  async function app(name: string) {
    const connected = once(wss, "connection");
    const child = fork(
      fileURLToPath(
        new URL("./fixtures/session-application.ts", import.meta.url),
      ),
      [
        `ws://127.0.0.1:${port}?applicationName=${encodeURIComponent(name)}`,
        name,
      ],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    processes.add(child);
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    const queued: AppMessage[] = [];
    const pending = new Set<{
      match: (m: AppMessage) => boolean;
      resolve: (m: AppMessage) => void;
      reject: (e: Error) => void;
    }>();
    child.on("message", (message: AppMessage) => {
      const waiter = [...pending].find((p) => p.match(message));
      if (waiter) {
        pending.delete(waiter);
        waiter.resolve(message);
      } else queued.push(message);
    });
    child.on("exit", () => {
      for (const p of pending)
        p.reject(new Error(`Application exited: ${stderr}`));
      pending.clear();
    });
    function take(match: (m: AppMessage) => boolean): Promise<AppMessage> {
      const index = queued.findIndex(match);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) =>
        pending.add({ match, resolve, reject }),
      );
    }
    let id = 0;
    const ready = await take((m) => !!m.ready);
    const [serverSocket] = await connected;
    return {
      localRootId: ready.rootId!,
      async request(op: string, fields: Record<string, unknown> = {}) {
        const requestId = ++id;
        const result = take((m) => m.id === requestId);
        child.send({ id: requestId, op, ...fields });
        return result;
      },
      async command() {
        return (await take((m) => !!m.command)).command!;
      },
      async close() {
        // Observe server cleanup as well as process exit before returning.
        const closed = once(serverSocket, "close");
        const exited = once(child, "exit");
        child.kill();
        await Promise.all([exited, closed]);
      },
    };
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0].text;
    if (result.structuredContent)
      expect(result.structuredContent).toEqual(JSON.parse(text));
    return { isError: result.isError === true, data: JSON.parse(text) };
  }
  const root = (name: string) =>
    store
      .listActors()
      .find((a) => a.applicationName === name && a.parentId === null)!;
  return { app, call, client, store, registry, root };
}

describe("application session isolation via real XState and MCP", () => {
  it("keeps identical local actor IDs from separate JavaScript runtimes discoverable", async () => {
    const { app, call } = await setup();
    const a = await app("tab A");
    const b = await app("tab B");
    expect(a.localRootId).toBe("x:0");
    expect(b.localRootId).toBe("x:0");
    const { data } = await call("list_actors");
    expect(data.totalActors).toBe(4);
    expect(
      new Set(data.actors.map((a: { sessionId: string }) => a.sessionId)).size,
    ).toBe(4);
  });

  it("ignores an acknowledgement from another socket even with the exact request ID", async () => {
    const { app, call, store } = await setup();
    const owner = await app("owner");
    const ownerId = store
      .listActors()
      .find((a) => a.parentId === null)!.sessionId;
    const stranger = await app("stranger");
    await owner.request("register");
    await owner.request("hold");
    let settled = false;
    const result = call("send_event", {
      target: ownerId,
      event: { type: "RUN" },
    }).then((r) => {
      settled = true;
      return r;
    });
    const command = await owner.command();
    await owner.request("emit", {
      frames: [
        null,
        [],
        {
          type: "xstate-mcp.send.response",
          requestId: command.requestId,
          success: "true",
        },
        {
          type: "xstate-mcp.send.response",
          requestId: command.requestId,
          success: true,
          error: {},
        },
      ],
    });
    await call("list_actors");
    expect(settled).toBe(false);
    await stranger.request("emit", {
      frames: [
        {
          type: "xstate-mcp.send.response",
          requestId: command.requestId,
          success: true,
        },
      ],
    });
    await call("list_actors"); // MCP round trip after the WebSocket ping/pong barrier.
    expect(settled).toBe(false);
    await owner.request("emit", {
      frames: [
        {
          type: "xstate-mcp.send.response",
          requestId: command.requestId,
          success: false,
          error: "owner response",
        },
      ],
    });
    expect((await result).data).toMatchObject({
      success: false,
      error: "Application rejected event (details withheld)",
    });
  });
});

describe("scoped tools, resources, and connection lifecycle", () => {
  it("selects each application and addresses its hierarchy through every actor tool and resource", async () => {
    const { app, call, client, root, store } = await setup();
    const a = await app("tab A");
    const b = await app("tab B");
    const rootA = root("tab A"),
      rootB = root("tab B");
    const childA = store
      .listActors()
      .find((a) => a.parentId === rootA.sessionId)!;
    const childB = store
      .listActors()
      .find((a) => a.parentId === rootB.sessionId)!;
    for (const actor of [rootA, rootB, childA, childB]) {
      expect(actor.rootId).toBe(
        actor.connectionId === rootA.connectionId
          ? rootA.sessionId
          : rootB.sessionId,
      );
      expect(actor.sessionId).toMatch(/^[a-zA-Z0-9_.-]+$/);
      const state = (
        await call("get_actor_state", { sessionId: actor.sessionId })
      ).data;
      expect(state).toMatchObject({
        connectionId: actor.connectionId,
        localSessionId: actor.localSessionId,
        applicationName: actor.applicationName,
        value: "idle",
        parentId: actor.parentId,
      });
      const definition = await call("get_machine_definition", {
        sessionId: actor.sessionId,
      });
      expect(definition.data.sessionId).toBe(actor.sessionId);
      expect(definition.data.definition).toHaveProperty("states.idle");
      for (const kind of ["snapshot", "definition"]) {
        const resource = await client.readResource({
          uri: `xstate://actor/${actor.sessionId}/${kind}`,
        });
        const content = resource.contents[0];
        if (!("text" in content)) throw new Error("Expected JSON resource");
        expect(JSON.parse(content.text)).toMatchObject({
          sessionId: actor.sessionId,
          connectionId: actor.connectionId,
          localSessionId: actor.localSessionId,
        });
      }
    }
    for (const selected of [rootA, rootB]) {
      const list = (
        await call("list_actors", {
          connectionId: selected.connectionId,
          status: "active",
        })
      ).data;
      expect(list.totalActors).toBe(2);
      expect(
        list.actors.every(
          (a: { connectionId: string }) =>
            a.connectionId === selected.connectionId,
        ),
      ).toBe(true);
      const tree = (
        await call("get_actor_tree", { connectionId: selected.connectionId })
      ).data;
      expect(tree.tree).toHaveLength(1);
      expect(tree.tree[0]).toMatchObject({
        sessionId: selected.sessionId,
      });
      expect(tree.tree[0].children).toHaveLength(1);
      expect(tree.tree[0].children[0].connectionId).toBe(selected.connectionId);
    }
    expect((await call("get_actor_tree")).data.tree).toHaveLength(2);
    expect(
      (await call("list_actors", { connectionId: "missing" })).data.totalActors,
    ).toBe(0);
    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(9);
    const completion = await client.complete({
      ref: { type: "ref/resource", uri: "xstate://actor/{sessionId}/snapshot" },
      argument: { name: "sessionId", value: "worker" },
    });
    expect(new Set(completion.completion.values)).toEqual(
      new Set([childA.sessionId, childB.sessionId]),
    );
    const actorsResource = await client.readResource({
      uri: "xstate://actors",
    });
    const actorsContent = actorsResource.contents[0];
    if (!("text" in actorsContent)) throw new Error("Expected text");
    expect(JSON.parse(actorsContent.text)).toHaveLength(4);

    const ambiguous = await call("send_event", {
      target: "worker",
      event: { type: "WORK" },
    });
    expect(ambiguous.isError).toBe(true);
    expect(
      ambiguous.data.matches
        .map((a: { connectionId: string }) => a.connectionId)
        .sort(),
    ).toEqual([rootA.connectionId, rootB.connectionId].sort());
    expect((await a.request("flush")).commands).toHaveLength(0);
    expect((await b.request("flush")).commands).toHaveLength(0);
    expect(
      (
        await call("can_handle_event", {
          sessionId: rootA.sessionId,
          eventType: "RUN",
        })
      ).data.canHandle,
    ).toBe(true);
    const beforeB = (
      await call("get_state_timeline", { sessionId: rootB.sessionId })
    ).data;
    expect(
      (
        await call("send_event", {
          target: rootA.sessionId,
          event: { type: "RUN" },
        })
      ).data,
    ).toMatchObject({ sessionId: rootA.sessionId, success: true });
    expect((await a.command()).sessionId).toBe(a.localRootId);
    expect(
      (await call("get_actor_state", { sessionId: rootA.sessionId })).data
        .value,
    ).toBe("running");
    expect(
      (await call("get_actor_state", { sessionId: rootB.sessionId })).data
        .value,
    ).toBe("idle");
    expect(
      (await call("get_actor_state", { sessionId: childA.sessionId })).data
        .value,
    ).toBe("working");
    expect(
      (await call("get_actor_state", { sessionId: childB.sessionId })).data
        .value,
    ).toBe("idle");
    const history = (
      await call("get_event_history", { sessionId: childA.sessionId })
    ).data;
    expect(history.events).toContainEqual(
      expect.objectContaining({
        event: { type: "WORK" },
        sourceId: rootA.sessionId,
      }),
    );
    const timeline = (
      await call("get_state_timeline", { sessionId: rootA.sessionId })
    ).data;
    expect(timeline.transitions).toContainEqual(
      expect.objectContaining({
        fromValue: "idle",
        toValue: "running",
        event: "RUN",
      }),
    );
    expect(
      (await call("get_state_timeline", { sessionId: rootB.sessionId })).data,
    ).toEqual(beforeB);
    expect(
      (
        await call("send_event", {
          target: childB.sessionId,
          event: { type: "WORK" },
        })
      ).data.success,
    ).toBe(true);
    expect((await b.command()).sessionId).toBe(childB.localSessionId);
    expect(
      (await call("get_actor_state", { sessionId: childB.sessionId })).data
        .value,
    ).toBe("working");
    expect(
      (await call("get_actor_state", { sessionId: rootB.sessionId })).data
        .value,
    ).toBe("idle");
    for (const name of ["debug_actor", "explain_machine", "trace_event_flow"]) {
      const prompt = await client.getPrompt({
        name,
        arguments: { sessionId: rootA.sessionId },
      });
      expect(JSON.stringify(prompt)).toContain(rootA.sessionId);
      expect(JSON.stringify(prompt)).not.toContain(rootB.sessionId);
    }
    for (const name of [
      "get_actor_state",
      "get_event_history",
      "get_machine_definition",
      "get_state_timeline",
      "can_handle_event",
    ]) {
      expect(
        (await call(name, { sessionId: "x:0", eventType: "RUN" })).isError,
      ).toBe(true);
    }
  });

  it("rejects foreign inspection targets and scopes all supplied relationship IDs", async () => {
    const { app, call, root, store } = await setup();
    const owner = await app("owner");
    const stranger = await app("stranger");
    const owned = root("owner"),
      other = root("stranger");
    const uniqueLocal = "only/owner?#%😀";
    await owner.request("emit", {
      frames: [
        {
          type: "@xstate.actor",
          sessionId: uniqueLocal,
          parentId: owned.localSessionId,
          rootId: owned.localSessionId,
          name: "owner-only",
          snapshot: { value: "safe" },
        },
      ],
    });
    const unique = store
      .listActors()
      .find((a) => a.localSessionId === uniqueLocal)!;
    for (const target of [uniqueLocal, unique.sessionId, owned.sessionId]) {
      await stranger.request("emit", {
        frames: [
          {
            type: "@xstate.snapshot",
            sessionId: target,
            connectionId: owned.connectionId,
            snapshot: { value: "FORGED" },
          },
          {
            type: "@xstate.event",
            sessionId: target,
            connectionId: owned.connectionId,
            event: { type: "FORGED" },
          },
        ],
      });
    }
    expect(
      (await call("get_actor_state", { sessionId: unique.sessionId })).data
        .value,
    ).toBe("safe");
    expect(
      (await call("get_event_history", { sessionId: unique.sessionId })).data
        .events.length,
    ).toBe(0);
    expect(
      (await call("get_actor_state", { sessionId: owned.sessionId })).data
        .value,
    ).toBe("idle");
    // Same local ID is valid only inside the sender's own namespace.
    await stranger.request("emit", {
      frames: [
        {
          type: "@xstate.snapshot",
          sessionId: "x:0",
          snapshot: { value: "LOCAL" },
        },
        {
          type: "@xstate.actor",
          sessionId: owned.sessionId,
          parentId: owned.sessionId,
          rootId: owned.sessionId,
          connectionId: owned.connectionId,
        },
        {
          type: "@xstate.event",
          sessionId: "x:0",
          sourceId: unique.sessionId,
          event: { type: "LOCAL" },
        },
      ],
    });
    expect(
      (await call("get_actor_state", { sessionId: owned.sessionId })).data
        .value,
    ).toBe("idle");
    expect(
      (await call("get_actor_state", { sessionId: other.sessionId })).data
        .value,
    ).toBe("LOCAL");
    const forgedName = store
      .listActors()
      .find((a) => a.localSessionId === owned.sessionId)!;
    expect(forgedName.connectionId).toBe(other.connectionId);
    expect(forgedName.sessionId).not.toBe(owned.sessionId);
    expect(forgedName.parentId).not.toBe(owned.sessionId);
    expect(forgedName.rootId).toBe(forgedName.sessionId);
    const history = (
      await call("get_event_history", { sessionId: other.sessionId })
    ).data;
    expect(history.events.at(-1).sourceId).not.toBe(unique.sessionId);
    const resource = await call("get_actor_state", {
      sessionId: unique.sessionId,
    });
    expect(resource.data.parentId).toBe(owned.sessionId);
  });

  it("keeps requests on original sockets during overlapping reconnects and ignores stale responses", async () => {
    const { app, call, root, store } = await setup();
    const old = await app("same application");
    const oldActor = root("same application");
    await old.request("hold");
    let oldSettled = false,
      nextSettled = false;
    const oldResult = call("send_event", {
      target: oldActor.sessionId,
      event: { type: "RUN" },
    }).then((r) => {
      oldSettled = true;
      return r;
    });
    const oldCommand = await old.command();
    const next = await app("same application");
    const nextActor = store
      .listActors()
      .find((a) => a.parentId === null && a.sessionId !== oldActor.sessionId)!;
    expect(nextActor.connectionId).not.toBe(oldActor.connectionId);
    await next.request("hold");
    const nextResult = call("send_event", {
      target: nextActor.sessionId,
      event: { type: "RUN" },
    }).then((r) => {
      nextSettled = true;
      return r;
    });
    const nextCommand = await next.command();
    await next.request("emit", {
      frames: [
        {
          type: "xstate-mcp.send.response",
          requestId: oldCommand.requestId,
          success: true,
        },
      ],
    });
    await old.request("emit", {
      frames: [
        {
          type: "xstate-mcp.send.response",
          requestId: nextCommand.requestId,
          success: true,
        },
      ],
    });
    await call("list_actors");
    expect(oldSettled).toBe(false);
    expect(nextSettled).toBe(false);
    await old.close();
    expect((await oldResult).data).toMatchObject({
      success: false,
      error: "Client disconnected",
    });
    expect(nextSettled).toBe(false);
    expect((await call("list_actors")).data.totalActors).toBe(2);
    expect(
      (await call("get_actor_state", { sessionId: oldActor.sessionId }))
        .isError,
    ).toBe(true);
    expect(
      (await call("get_actor_state", { sessionId: nextActor.sessionId })).data
        .value,
    ).toBe("idle");
    await next.request("emit", {
      frames: [
        {
          type: "xstate-mcp.send.response",
          requestId: oldCommand.requestId,
          success: true,
        },
      ],
    });
    await call("list_actors");
    expect(nextSettled).toBe(false);
    await next.request("emit", {
      frames: [
        {
          type: "xstate-mcp.send.response",
          requestId: nextCommand.requestId,
          success: true,
        },
      ],
    });
    expect((await nextResult).data.success).toBe(true);
  });

  it("preserves history on duplicate registration and requires fresh registration after clear", async () => {
    const { app, call, root, store, registry } = await setup();
    const a = await app("A");
    const b = await app("B");
    const actor = root("A");
    await call("send_event", {
      target: actor.sessionId,
      event: { type: "RUN" },
    });
    await a.command();
    const before = (
      await call("get_state_timeline", { sessionId: actor.sessionId })
    ).data;
    await a.request("register");
    expect(
      (await call("get_state_timeline", { sessionId: actor.sessionId })).data,
    ).toEqual(before);
    await a.request("hold");
    const pending = call("send_event", {
      target: actor.sessionId,
      event: { type: "RUN" },
    });
    const stale = await a.command();
    expect((await call("clear_actors")).data.cleared).toBe(4);
    expect((await pending).data).toMatchObject({
      success: false,
      error: "Registry cleared",
    });
    expect(registry.getConnectedSessionCount()).toBe(0);
    await a.request("emit", {
      frames: [
        {
          type: "@xstate.snapshot",
          sessionId: "x:0",
          snapshot: { value: "ignored" },
        },
      ],
    });
    expect(store.size).toBe(0);
    await a.request("register");
    await b.request("register");
    expect(root("A").connectionId).toBe(actor.connectionId);
    let settled = false;
    const result = call("send_event", {
      target: actor.sessionId,
      event: { type: "RUN" },
    }).then((r) => {
      settled = true;
      return r;
    });
    const current = await a.command();
    await a.request("emit", {
      frames: [
        {
          type: "xstate-mcp.send.response",
          requestId: stale.requestId,
          success: true,
        },
      ],
    });
    await call("list_actors");
    expect(settled).toBe(false);
    await a.request("emit", {
      frames: [
        {
          type: "xstate-mcp.send.response",
          requestId: current.requestId,
          success: true,
        },
      ],
    });
    expect((await result).data.success).toBe(true);
    store.clear();
    expect(registry.getConnectedSessionCount()).toBe(0);
  });

  it("enforces isolation and disconnect cleanup when used without a command registry", async () => {
    const { app, call, root } = await setup(false);
    const a = await app("A");
    await app("B");
    const survivor = root("B");
    expect((await call("list_actors")).data.totalActors).toBe(4);
    await a.close();
    expect((await call("list_actors")).data.totalActors).toBe(2);
    expect(
      (await call("get_actor_state", { sessionId: survivor.sessionId })).data
        .value,
    ).toBe("idle");
  });
});
