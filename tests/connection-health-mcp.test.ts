import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  request as httpRequest,
} from "node:http";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket, type WebSocketServer } from "ws";
import { createActor, createMachine } from "xstate-compat";
import { expect, it, onTestFinished } from "vitest";
import { ActorStore } from "../src/actor-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import {
  ConnectionHealth,
  connectionHealthSchema,
  HEARTBEAT_INTERVAL_MS,
  STALE_AFTER_MS,
} from "../src/connection-health.js";
import { Logger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createWsServer } from "../src/ws-server.js";
import { applicationHello } from "./fixtures/application-hello.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const logger = new Logger("error");
async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const content = result.content as { type: string; text: string }[];
  const data = JSON.parse(content[0].text);
  expect(data).toEqual(result.structuredContent);
  return data;
}
async function status(client: Client, args: Record<string, unknown> = {}) {
  return connectionHealthSchema.parse(
    await tool(client, "get_connection_health", args),
  );
}
async function flush(ws: WebSocket) {
  const pong = once(ws, "pong");
  ws.ping();
  await pong;
}
async function hello(ws: WebSocket, data: unknown = applicationHello()) {
  const reply = once(ws, "message");
  ws.send(JSON.stringify(data));
  return JSON.parse((await reply)[0].toString());
}
function produce(ws: WebSocket, id = "doctor") {
  const machine = createMachine({
    id,
    initial: "idle",
    context: { secret: "actor-payload-secret" },
    states: { idle: { on: { RUN: "running" } }, running: {} },
  });
  let forwarding = true;
  const actor = createActor(machine, {
    inspect(event) {
      if (forwarding)
        ws.send(
          JSON.stringify({
            ...event,
            sessionId: event.actorRef.sessionId,
            ...(event.type === "@xstate.actor"
              ? { definition: machine.toJSON() }
              : {}),
          }),
        );
    },
  });
  const command = (raw: Buffer) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "xstate-mcp.send") return;
    const success = message.sessionId === actor.sessionId;
    if (success) actor.send(message.event);
    ws.send(
      JSON.stringify({
        type: "xstate-mcp.send.response",
        requestId: message.requestId,
        sessionId: message.sessionId,
        success,
      }),
    );
  };
  ws.on("message", command);
  actor.start();
  return {
    actor,
    stop() {
      forwarding = false;
      actor.stop();
      ws.off("message", command);
    },
  };
}
async function harness(
  options: {
    health?: ConnectionHealth;
    server?: HttpServer;
    port?: number;
    listen?: boolean;
    allowedOrigins?: string[];
  } = {},
) {
  const store = new ActorStore(100, logger);
  const registry = new ClientRegistry(5000, logger, {
    health: options.health,
    writePolicy: { readOnly: false, allow: [{ actor: "*", events: ["RUN"] }] },
  });
  const mcp = createMcpServer(store, registry, logger);
  const client = new Client({ name: "doctor-tests", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  let wss: WebSocketServer | undefined;
  const producers: ReturnType<typeof produce>[] = [];
  const sockets: WebSocket[] = [];
  onTestFinished(async () => {
    for (const producer of producers) producer.stop();
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    registry.clear();
    if (wss) {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((done) => wss!.close(() => done()));
    }
    await client.close();
    await mcp.close();
  });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const listen = async (port = options.port ?? 0) => {
    wss = createWsServer({
      port,
      server: options.server,
      store,
      clientRegistry: registry,
      logger,
      allowedOrigins: options.allowedOrigins,
    });
    if (!options.server?.listening) await once(wss, "listening");
    return wss;
  };
  if (options.listen !== false) await listen();
  const connect = async (
    socketOptions: { origin?: string; autoPong?: boolean } = {},
  ) => {
    const endpoint = registry.getHealth().listener.endpoint!;
    const ws = new WebSocket(endpoint.url, socketOptions);
    sockets.push(ws);
    await once(ws, "open");
    return ws;
  };
  return {
    client,
    registry,
    store,
    listen,
    connect,
    wss: () => wss!,
    producer(ws: WebSocket, id?: string) {
      const p = produce(ws, id);
      producers.push(p);
      return p;
    },
  };
}

it("discovers the read-only health tool and distinguishes no listener, no clients and a client without actors", async () => {
  const h = await harness({ listen: false });
  expect(
    (await h.client.listTools()).tools.find(
      (t) => t.name === "get_connection_health",
    ),
  ).toMatchObject({
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: { type: "object" },
  });
  expect(await status(h.client)).toMatchObject({
    listener: { state: "not_started", endpoint: null },
    totals: { connectedClients: 0 },
  });
  await h.listen();
  const ready = await status(h.client);
  expect(ready.listener).toMatchObject({
    state: "listening",
    endpoint: { host: "127.0.0.1" },
  });
  expect(ready.listener.endpoint!.port).toBeGreaterThan(0);
  expect(ready.totals.connectedClients).toBe(0);
  await h.connect();
  expect(await status(h.client)).toMatchObject({
    totals: {
      connectedClients: 1,
      clientsWithActors: 0,
      registeredSessions: 0,
    },
    connections: [
      { negotiation: "awaiting_hello", actorCount: 0, application: null },
    ],
  });
  const invalid = await h.client.callTool({
    name: "get_connection_health",
    arguments: { limit: 51 },
  });
  expect(invalid.isError).toBe(true);
});

it("negotiates a real adapter, commands a real XState actor and exposes no actor payload or handshake extras", async () => {
  const h = await harness();
  const ws = await h.connect();
  const reply = await hello(ws, {
    ...applicationHello(),
    token: "handshake-secret",
    application: { name: "doctor", url: "https://example.test/?token=secret" },
  });
  expect(reply).toMatchObject({
    success: true,
    protocolVersion: 1,
    commands: ["send_event"],
  });
  const p = h.producer(ws);
  await flush(ws);
  const { actors } = await tool(h.client, "list_actors");
  const sessionId = actors[0].sessionId;
  expect(actors[0].connectionId).toBe(reply.connectionId);
  expect(actors[0].localSessionId).toBe(p.actor.sessionId);
  expect(sessionId).not.toBe(p.actor.sessionId);
  expect(
    await tool(h.client, "send_event", {
      target: sessionId,
      event: { type: "RUN" },
    }),
  ).toMatchObject({ success: true });
  expect(p.actor.getSnapshot().value).toBe("running");
  expect(await tool(h.client, "get_actor_state", { sessionId })).toMatchObject({
    value: "running",
  });
  const health = await status(h.client, { connectionId: reply.connectionId });
  expect(health.connections[0]).toMatchObject({
    application: { name: "doctor" },
    adapter: { name: "test-adapter", version: "1.0.0" },
    commands: ["send_event"],
    actorCount: 1,
    negotiation: "negotiated",
    freshness: "fresh",
  });
  expect(health.connections[0].lastInspectionAt).not.toBeNull();
  expect(JSON.stringify(health)).not.toMatch(
    /actor-payload-secret|handshake-secret|token=secret/,
  );
});

it("counts wrong-socket acknowledgements without consuming the owner's pending command", async () => {
  const h = await harness();
  const owner = await h.connect();
  const attacker = await h.connect();
  const ownerHello = await hello(owner);
  const attackerHello = await hello(attacker);
  const producer = h.producer(owner);
  await flush(owner);
  // Hold the real adapter's acknowledgement so the other socket can try it first.
  owner.removeAllListeners("message");
  const { actors } = await tool(h.client, "list_actors");
  const sessionId = actors[0].sessionId;
  const command = once(owner, "message");
  let settled = false;
  const sent = tool(h.client, "send_event", {
    target: sessionId,
    event: { type: "RUN" },
  }).then((result) => {
    settled = true;
    return result;
  });
  const frame = JSON.parse((await command)[0].toString());
  expect(frame.sessionId).toBe(producer.actor.sessionId);
  const ack = JSON.stringify({
    type: "xstate-mcp.send.response",
    requestId: frame.requestId,
    success: true,
  });
  attacker.send(ack);
  await flush(attacker);
  expect(settled).toBe(false);
  expect(
    (await status(h.client, { connectionId: attackerHello.connectionId }))
      .connections[0],
  ).toMatchObject({
    lastRejection: "unexpected_ack",
    counters: { rejectedFrames: 1 },
  });
  expect(producer.actor.getSnapshot().value).toBe("idle");
  producer.actor.send(frame.event);
  owner.send(ack);
  expect(await sent).toMatchObject({ success: true });
  expect(await tool(h.client, "get_actor_state", { sessionId })).toMatchObject({
    value: "running",
  });
  expect(
    (await status(h.client, { connectionId: ownerHello.connectionId }))
      .connections[0],
  ).toMatchObject({
    connectionId: actors[0].connectionId,
    counters: { rejectedFrames: 0, commandTimeouts: 0 },
  });
});

it("reports an already-listening external HTTP server without taking ownership of it", async () => {
  const external = createHttpServer((_request, response) =>
    response.end("external-server"),
  );
  onTestFinished(() => {
    external.closeAllConnections();
    external.close();
  });
  external.listen(0, "127.0.0.1");
  await once(external, "listening");
  const address = external.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const h = await harness({ server: external });
  const endpoint = {
    host: "127.0.0.1",
    port: address.port,
    url: `ws://127.0.0.1:${address.port}`,
  };
  expect((await status(h.client)).listener).toEqual({
    state: "listening",
    endpoint,
    errorCode: null,
  });
  const ws = await h.connect();
  const reply = await hello(ws);
  const producer = h.producer(ws);
  await flush(ws);
  const { actors } = await tool(h.client, "list_actors");
  expect(actors[0].connectionId).toBe(reply.connectionId);
  expect((await status(h.client)).totals.registeredSessions).toBe(1);

  external.emit("error", new Error("Post-attachment listener error"));
  expect((await status(h.client)).listener).toEqual({
    state: "listening",
    endpoint,
    errorCode: null,
  });
  producer.stop();
  const socketClosed = once([...h.wss().clients][0], "close");
  ws.close();
  await socketClosed;
  await new Promise<void>((resolve) => h.wss().close(() => resolve()));
  expect((await status(h.client)).listener.state).toBe("closed");
  expect(external.listening).toBe(true);
  const response = await fetch(`http://127.0.0.1:${address.port}`);
  expect(await response.text()).toBe("external-server");
});

it("follows external HTTP close, failed rebind and a new listening endpoint", async () => {
  const external = createHttpServer();
  const occupied = createHttpServer();
  onTestFinished(() => {
    external.closeAllConnections();
    external.close();
    occupied.close();
  });
  external.listen(0, "127.0.0.1");
  occupied.listen(0, "127.0.0.1");
  await Promise.all([once(external, "listening"), once(occupied, "listening")]);
  const next = occupied.address();
  if (!next || typeof next === "string") throw new Error("Missing address");
  const h = await harness({ server: external });
  const closeObservers = external.listenerCount("close");
  await new Promise<void>((resolve) => external.close(() => resolve()));
  expect.soft((await status(h.client)).listener).toEqual({
    state: "closed",
    endpoint: null,
    errorCode: null,
  });
  const failed = once(external, "error");
  external.listen(next.port, "127.0.0.1");
  expect((await failed)[0]).toMatchObject({ code: "EADDRINUSE" });
  expect.soft((await status(h.client)).listener).toEqual({
    state: "error",
    endpoint: null,
    errorCode: "EADDRINUSE",
  });
  await new Promise<void>((resolve) => occupied.close(() => resolve()));
  external.listen(next.port, "127.0.0.1");
  await once(external, "listening");
  expect((await status(h.client)).listener).toEqual({
    state: "listening",
    endpoint: {
      host: "127.0.0.1",
      port: next.port,
      url: `ws://127.0.0.1:${next.port}`,
    },
    errorCode: null,
  });
  const ws = await h.connect();
  await hello(ws);
  const producer = h.producer(ws);
  await flush(ws);
  expect((await status(h.client)).totals.registeredSessions).toBe(1);
  producer.stop();
  const socketClosed = once([...h.wss().clients][0], "close");
  ws.close();
  await socketClosed;
  await new Promise<void>((resolve) => h.wss().close(() => resolve()));
  expect(external.listening).toBe(true);
  expect(external.listenerCount("close")).toBe(closeObservers - 1);
  await new Promise<void>((resolve) => external.close(() => resolve()));
  external.listen(0, "127.0.0.1");
  await once(external, "listening");
  expect((await status(h.client)).listener.state).toBe("closed");
});

it("reports a live external Unix socket without inventing a TCP endpoint", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "xmcp-socket-"));
  const path = resolve(directory, "inspection.sock");
  const external = createHttpServer((_request, response) =>
    response.end("unix-http"),
  );
  onTestFinished(async () => {
    external.closeAllConnections();
    await new Promise<void>((done) => external.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  });
  external.listen(path);
  await once(external, "listening");
  const h = await harness({ server: external });
  expect((await status(h.client)).listener).toEqual({
    state: "listening",
    endpoint: null,
    errorCode: null,
  });
  external.emit("error", new Error("Active Unix listener error"));
  expect((await status(h.client)).listener.state).toBe("listening");
  await new Promise<void>((done) => h.wss().close(() => done()));
  expect(external.listening).toBe(true);
  const body = await new Promise<string>((done, reject) => {
    httpRequest({ socketPath: path, path: "/" }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => done(data));
      response.on("error", reject);
    })
      .on("error", reject)
      .end();
  });
  expect(body).toBe("unix-http");
});

it("keeps a live endpoint after server errors and reports its eventual closure", async () => {
  const h = await harness();
  const listening = (await status(h.client)).listener;
  h.wss().emit("error", new Error("Post-startup listener error"));
  expect((await status(h.client)).listener).toEqual(listening);

  // A server error need not stop the underlying listener or legacy inspection.
  const ws = await h.connect();
  const producer = h.producer(ws);
  await flush(ws);
  expect((await status(h.client)).totals.registeredSessions).toBe(1);
  producer.stop();
  const socketClosed = once([...h.wss().clients][0], "close");
  ws.close();
  await socketClosed;
  await new Promise<void>((resolve) => h.wss().close(() => resolve()));
  expect((await status(h.client)).listener).toEqual({
    state: "closed",
    endpoint: null,
    errorCode: null,
  });
});

it.each(["legacy", "read-only"])(
  "fails %s writes immediately while retaining observation",
  async (mode) => {
    const h = await harness();
    const ws = await h.connect();
    if (mode === "read-only") await hello(ws, applicationHello([]));
    h.producer(ws);
    await flush(ws);
    const { actors } = await tool(h.client, "list_actors");
    const sessionId = actors[0].sessionId;
    const result = await h.client.callTool(
      {
        name: "send_event",
        arguments: { target: sessionId, event: { type: "RUN" } },
      },
      undefined,
      { timeout: 1000 },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        success: false,
        code:
          mode === "legacy"
            ? "capability_negotiation_required"
            : "unsupported_command",
      },
    });
    expect(
      await tool(h.client, "get_actor_state", { sessionId }),
    ).toMatchObject({ value: "idle" });
    expect((await status(h.client)).counters).toMatchObject({
      unsupportedCommands: 1,
      commandTimeouts: 0,
    });
  },
);

it("counts rejected frames and lost registration without retaining their content", async () => {
  const h = await harness();
  const ws = await h.connect();
  ws.send("invalid-secret-json");
  ws.send("null");
  ws.send(
    JSON.stringify({
      type: "@xstate.snapshot",
      sessionId: "lost-startup",
      snapshot: { secret: "lost-secret" },
    }),
  );
  ws.send(
    JSON.stringify({
      type: "@xstate.actor",
      id: null,
      sessionId: "invalid-inspection",
      createdAt: 42,
    }),
  );
  ws.send(
    JSON.stringify({ type: "@xstate.microstep", payload: "ignored-secret" }),
  );
  ws.send(
    JSON.stringify({
      type: "xstate-mcp.send.response",
      requestId: "unknown",
      success: "true",
    }),
  );
  ws.send(
    JSON.stringify({
      type: "xstate-mcp.send.response",
      requestId: "unknown",
      success: true,
    }),
  );
  await flush(ws);
  let health = await status(h.client);
  expect(health.totals.registeredSessions).toBe(0);
  expect(health.counters).toMatchObject({
    receivedFrames: 7,
    rejectedFrames: 6,
    ignoredFrames: 1,
  });
  expect(health.connections[0].lastRejection).toBe("unexpected_ack");
  expect(JSON.stringify(health)).not.toMatch(
    /invalid-secret|lost-secret|ignored-secret|invalid-inspection/,
  );
  await hello(ws);
  h.producer(ws);
  await flush(ws);
  health = await status(h.client);
  expect(health.totals.registeredSessions).toBe(1);
  expect(health.counters.acceptedInspectionFrames).toBeGreaterThan(0);
  expect(health.counters.rejectedFrames).toBe(6);
});

it("reports incompatible protocols and rejects their inspection until a valid hello", async () => {
  const h = await harness();
  const ws = await h.connect();
  expect(
    await hello(ws, { ...applicationHello(), protocolVersion: 2 }),
  ).toMatchObject({
    success: false,
    code: "incompatible_protocol",
    supportedProtocolVersions: [1],
  });
  const before = h.producer(ws);
  await flush(ws);
  before.stop();
  expect((await status(h.client)).connections[0]).toMatchObject({
    negotiation: "incompatible",
    protocolVersion: null,
    offeredProtocolVersion: 2,
    actorCount: 0,
  });
  expect(await hello(ws)).toMatchObject({ success: true });
  h.producer(ws, "after");
  await flush(ws);
  expect((await status(h.client)).connections[0]).toMatchObject({
    negotiation: "negotiated",
    actorCount: 1,
  });
});

it("reports stale transport separately from an idle actor and refreshes on a pong", async () => {
  let clock = 0;
  const h = await harness({ health: new ConnectionHealth(() => clock) });
  const ws = await h.connect();
  await hello(ws);
  h.producer(ws);
  await flush(ws);
  clock = STALE_AFTER_MS;
  expect((await status(h.client)).connections[0]).toMatchObject({
    freshness: "stale",
    activityAgeMs: STALE_AFTER_MS,
    inspectionAgeMs: STALE_AFTER_MS,
  });
  const serverWs = [...h.wss().clients][0];
  const pong = once(serverWs, "pong");
  serverWs.ping();
  await pong;
  expect((await status(h.client)).connections[0]).toMatchObject({
    freshness: "fresh",
    activityAgeMs: 0,
    inspectionAgeMs: STALE_AFTER_MS,
  });
});

it(
  "sends a protocol heartbeat even when no application messages arrive",
  async () => {
    const h = await harness();
    const ws = await h.connect();
    // Observe the actual timer once; production interval remains fixed and unref'd.
    await once(ws, "ping");
    expect((await status(h.client)).connections[0].freshness).toBe("fresh");
  },
  HEARTBEAT_INTERVAL_MS + 5000,
);

it("keeps negotiation through clear, but assigns a fresh identity and no capabilities on reconnect", async () => {
  const h = await harness();
  const ws = await h.connect();
  const first = await hello(ws);
  const p = h.producer(ws);
  await flush(ws);
  await tool(h.client, "clear_actors");
  expect((await status(h.client)).connections[0]).toMatchObject({
    connectionId: first.connectionId,
    negotiation: "negotiated",
    actorCount: 0,
  });
  p.actor.send({ type: "RUN" });
  await flush(ws);
  expect((await status(h.client)).connections[0].lastRejection).toBe(
    "actor_not_registered",
  );
  p.stop();
  const replay = h.producer(ws, "after-clear");
  await flush(ws);
  const { actors } = await tool(h.client, "list_actors");
  expect(actors[0].connectionId).toBe(first.connectionId);
  expect(
    await tool(h.client, "send_event", {
      target: actors[0].sessionId,
      event: { type: "RUN" },
    }),
  ).toMatchObject({ success: true });
  expect(replay.actor.getSnapshot().value).toBe("running");
  replay.stop();
  const closed = once([...h.wss().clients][0], "close");
  ws.close();
  await closed;
  const next = await h.connect();
  await flush(next);
  const health = await status(h.client);
  expect(health.connections[0].connectionId).not.toBe(first.connectionId);
  expect(health).toMatchObject({
    totals: { connectedClients: 1, closedConnections: 1 },
    connections: [{ negotiation: "awaiting_hello", commands: [] }],
  });
});

it("reports origin rejection and an occupied listener without reflecting URLs or exception payloads", async () => {
  const h = await harness({ allowedOrigins: ["http://localhost:*"] });
  await expect(
    h.connect({ origin: "http://secret.example/?credential=secret" }),
  ).rejects.toThrow("403");
  expect(await status(h.client)).toMatchObject({
    totals: { connectedClients: 0, rejectedConnections: 1 },
  });
  expect(JSON.stringify(await status(h.client))).not.toContain("secret");
  const occupied = await harness({ listen: false });
  await expect(
    occupied.listen(h.registry.getHealth().listener.endpoint!.port),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(await status(occupied.client)).toMatchObject({
    listener: { state: "error", endpoint: null, errorCode: "EADDRINUSE" },
  });
  await new Promise<void>((resolve) => occupied.wss().close(() => resolve()));
  expect((await status(occupied.client)).listener).toEqual({
    state: "error",
    endpoint: null,
    errorCode: "EADDRINUSE",
  });
});

it("exposes health and negotiated writes through the built CLI's actual MCP stdio", async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  await new Promise<void>((done) => reservation.close(() => done()));
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const child = spawn(
    process.execPath,
    [resolve(root, pkg.bin["xstate-mcp"])],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        XSTATE_MCP_WS_PORT: String(address.port),
        XSTATE_MCP_READ_ONLY: "false",
        XSTATE_MCP_WRITE_ALLOW: '[{"actor":"*","events":["RUN"]}]',
        XSTATE_MCP_WS_HOST: "127.0.0.1",
        XSTATE_MCP_REQUIRE_ORIGIN: "false",
        XSTATE_MCP_LOG_LEVEL: "error",
      },
    },
  );
  let stdout = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.resume();
  const closed = once(child, "close");
  const client = new Client({ name: "stdio-doctor", version: "1" });
  let app: ReturnType<typeof spawn> | undefined;
  let appClosed: Promise<unknown> | undefined;
  onTestFinished(async () => {
    app?.kill("SIGKILL");
    if (appClosed) await appClosed;
    child.kill("SIGKILL");
    await closed;
    await client.close();
  });
  await client.connect(new StdioServerTransport(child.stdout, child.stdin));
  await expect
    .poll(async () => (await status(client)).listener.state)
    .toBe("listening");
  app = spawn(
    process.execPath,
    [
      resolve(root, "examples/doctor-app.mjs"),
      (await status(client)).listener.endpoint!.url,
    ],
    { cwd: root, stdio: "pipe" },
  );
  app.stderr!.resume();
  appClosed = once(app, "close");
  await expect
    .poll(async () => (await status(client)).totals.registeredSessions)
    .toBe(1);
  expect((await status(client)).connections[0].application?.name).toBe(
    "doctor-example",
  );
  const { actors } = await tool(client, "list_actors");
  const sessionId = actors[0].sessionId;
  expect(
    await tool(client, "send_event", {
      target: sessionId,
      event: { type: "RUN" },
    }),
  ).toMatchObject({ success: true });
  expect(await tool(client, "get_actor_state", { sessionId })).toMatchObject({
    value: "running",
  });
  expect((await status(client)).totals.clientsWithActors).toBe(1);
  for (const line of stdout.trim().split("\n"))
    expect(JSON.parse(line).jsonrpc).toBe("2.0");
}, 15000);
