import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebSocketServer } from "ws";
import { ActorStore } from "./actor-store.js";
import { ClientRegistry } from "./client-registry.js";
import { Logger } from "./logger.js";
import { createMcpServer } from "./mcp-server.js";
import { createWsServer } from "./ws-server.js";
import type { LogLevel } from "./types.js";
import type {
  WritePolicyOptions,
  RedactionOptions,
} from "./inspection-policy.js";

export interface InspectionServerOptions {
  writePolicy?: WritePolicyOptions;
  redaction?: RedactionOptions;
  wsPort?: number;
  wsHost?: string;
  bufferSize?: number;
  logLevel?: LogLevel;
  allowedOrigins?: string[];
  requireOrigin?: boolean;
  /** Total shutdown budget, 1–30000ms; defaults to 1000ms. */
  shutdownTimeoutMs?: number;
}
export interface InspectionServer {
  readonly store: ActorStore;
  readonly clientRegistry: ClientRegistry;
  readonly mcpServer: McpServer;
  readonly address: AddressInfo | string | null;
  /** Settles when shutdown completes, including shutdown triggered by transport close. */
  readonly closed: Promise<void>;
  start(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new Error("Inspection server closed during startup"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Constructs an idle bridge. Only start() binds a port or starts the supplied MCP transport. */
export function createInspectionServer(
  options: InspectionServerOptions = {},
): InspectionServer {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1000;
  if (
    !Number.isInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 1 ||
    shutdownTimeoutMs > 30000
  ) {
    throw new Error("shutdownTimeoutMs must be an integer between 1 and 30000");
  }
  const port = options.wsPort ?? 7357;
  const host = options.wsHost ?? "127.0.0.1";
  const logger = new Logger(options.logLevel ?? "info");
  const store = new ActorStore(
    options.bufferSize ?? 100,
    logger,
    options.redaction,
  );
  const clientRegistry = new ClientRegistry(5000, logger, {
    writePolicy: options.writePolicy,
  });
  const mcpServer = createMcpServer(store, clientRegistry, logger);
  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  let http: HttpServer | undefined;
  let wss: WebSocketServer | undefined;
  let transport: Transport | undefined;
  let state: "idle" | "starting" | "running" | "closing" | "closed" = "idle";
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // An automatic transport-close shutdown may finish before an embedder awaits closed.
  void closed.catch(() => {});
  const disposeMcp = mcpServer.server.onclose;
  mcpServer.server.onclose = () => {
    disposeMcp?.();
    void close();
  };

  function forceSockets() {
    for (const ws of wss?.clients ?? []) ws.terminate();
    for (const socket of sockets) socket.destroy();
  }

  function close(): Promise<void> {
    if (state === "closing" || state === "closed") return closed;
    state = "closing";
    void shutdown().then(resolveClosed, rejectClosed);
    return closed;
  }

  async function shutdown() {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Install close observers before aborting a pending listen operation.
      const httpClosed = http
        ? new Promise<void>((resolve) => http!.close(() => resolve()))
        : Promise.resolve();
      const wsClosed = wss
        ? new Promise<void>((resolve) => wss!.close(() => resolve()))
        : Promise.resolve();
      lifetime.abort();
      // The SDK takes ownership before start() settles, but connect() can also
      // reject before attachment (for example, if the MCP factory was closed).
      const transportAttached = mcpServer.server.transport === transport;
      const mcpClosed = mcpServer.close(); // synchronously disposes store callbacks
      const unusedTransportClosed = transportAttached
        ? Promise.resolve()
        : (transport?.close() ?? Promise.resolve());
      clientRegistry.close();
      store.clear();
      for (const ws of wss?.clients ?? [])
        ws.close(1001, "Server shutting down");
      graceTimer = setTimeout(
        forceSockets,
        Math.min(250, shutdownTimeoutMs / 2),
      );
      const timeout = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          forceSockets();
          reject(new Error(`Shutdown exceeded ${shutdownTimeoutMs}ms`));
        }, shutdownTimeoutMs);
      });
      await Promise.race([
        Promise.all([httpClosed, wsClosed, mcpClosed, unusedTransportClosed]),
        timeout,
      ]);
    } finally {
      clearTimeout(graceTimer);
      clearTimeout(deadlineTimer);
      forceSockets();
      // Release SDK request handlers even if an embedder's transport close failed/hung.
      if (transport && mcpServer.server.transport === transport)
        transport.onclose?.();
      if (transport) {
        transport.onclose = undefined;
        transport.onerror = undefined;
        transport.onmessage = undefined;
      }
      state = "closed";
    }
  }

  async function start(selectedTransport: Transport): Promise<void> {
    if (state !== "idle")
      throw new Error(
        "Inspection server already started or closed; create a new instance",
      );
    state = "starting";
    transport = selectedTransport;
    try {
      http = createServer((_request, response) => {
        response.writeHead(426, { "Content-Type": "text/plain" });
        response.end("Upgrade Required");
      });
      http.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        if (lifetime.signal.aborted) socket.destroy();
      });
      wss = createWsServer({
        port,
        host,
        server: http,
        signal: lifetime.signal,
        store,
        clientRegistry,
        logger,
        allowedOrigins: options.allowedOrigins ?? [
          "http://localhost:*",
          "http://127.0.0.1:*",
        ],
        requireOrigin: options.requireOrigin,
      });
      const listening = new Promise<void>((resolve, reject) => {
        const onListening = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(
            new Error(
              `Cannot listen for XState inspection on ${host}:${port}: ${error.message}`,
              { cause: error },
            ),
          );
        };
        const onAbort = () => {
          cleanup();
          reject(new Error("Inspection server closed during startup"));
        };
        const cleanup = () => {
          http!.off("listening", onListening);
          http!.off("error", onError);
          lifetime.signal.removeEventListener("abort", onAbort);
        };
        http!.once("listening", onListening);
        http!.once("error", onError);
        lifetime.signal.addEventListener("abort", onAbort, { once: true });
        http!.listen({ port, host, signal: lifetime.signal });
      });
      await listening;
      if (lifetime.signal.aborted)
        throw new Error("Inspection server closed during startup");
      await abortable(mcpServer.connect(transport), lifetime.signal);
      if (lifetime.signal.aborted)
        throw new Error("Inspection server closed during startup");
      state = "running";
    } catch (error) {
      await close();
      throw error;
    }
  }
  return {
    store,
    clientRegistry,
    mcpServer,
    closed,
    start,
    close,
    get address() {
      return http?.address() ?? null;
    },
  };
}
