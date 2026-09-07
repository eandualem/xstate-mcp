import type { AnyActorRef, InspectionEvent } from "xstate";
import {
  documentMachine,
  workspaceMachine,
  type DocumentContext,
  type DocumentEvent,
} from "./model.js";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "rejected";
interface TrackedActor {
  ref: AnyActorRef;
  name: "workspace" | "document";
}
interface CapturedEvent {
  target: string;
  source?: string;
  event: Record<string, unknown>;
  createdAt: string;
}

/** Closed demo adapter for the two persistent actors; not the reusable adapter from #13. */
export function createDemoInspector(
  onConnection: (state: ConnectionState) => void,
) {
  const actors = new Map<string, TrackedActor>();
  const recent: CapturedEvent[] = [];
  let ws: WebSocket | undefined;
  let epoch = "";
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 150;
  let disposed = false;
  let paused = false;
  let rejected = false;
  const url = import.meta.env.VITE_XSTATE_MCP_URL ?? "ws://127.0.0.1:7357";
  const wireId = (id: string) => `${epoch}.${id.replace(/:/g, "_")}`;
  const root = () =>
    Array.from(actors.values()).find((actor) => actor.name === "workspace");
  const emit = (value: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  };
  const stamp = () => new Date().toISOString();

  function snapshot(actor: TrackedActor, value = actor.ref.getSnapshot()) {
    if (!value) return undefined;
    const context = value.context as DocumentContext;
    return {
      status: value.status,
      value: value.value,
      // Explicit projection prevents live actor refs and the fixture token from leaving the page.
      context:
        actor.name === "document"
          ? {
              title: context.title,
              body: context.body,
              saved: context.saved,
              attempts: context.attempts,
              revision: context.revision,
              error: context.error,
            }
          : {},
    };
  }

  function register(actor: TrackedActor, includeSnapshot = true) {
    const parent = actor.name === "document" ? root() : undefined;
    emit({
      type: "@xstate.actor",
      sessionId: wireId(actor.ref.sessionId),
      name: actor.name,
      rootId: root() ? wireId(root()!.ref.sessionId) : undefined,
      parentId: parent ? wireId(parent.ref.sessionId) : undefined,
      definition:
        actor.name === "document"
          ? documentMachine.toJSON()
          : workspaceMachine.toJSON(),
      snapshot: includeSnapshot ? snapshot(actor) : undefined,
      createdAt: stamp(),
    });
  }

  function sendCaptured(event: CapturedEvent) {
    emit({
      type: "@xstate.event",
      sessionId: wireId(event.target),
      sourceId: event.source ? wireId(event.source) : undefined,
      event: event.event,
      createdAt: event.createdAt,
    });
  }

  function commandEvent(value: unknown): DocumentEvent | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const event = value as Record<string, unknown>;
    switch (event.type) {
      case "SAVE":
      case "RETRY":
        return { type: event.type };
      case "CHANGE_TITLE":
      case "CHANGE_BODY":
        if (
          typeof event.value !== "string" ||
          event.value.length > (event.type === "CHANGE_TITLE" ? 120 : 4000)
        )
          return;
        return { type: event.type, value: event.value };
    }
  }

  function handleCommand(data: Record<string, unknown>) {
    if (
      typeof data.requestId !== "string" ||
      data.requestId.length === 0 ||
      data.requestId.length > 128
    )
      return;
    const actor = Array.from(actors.values()).find(
      (actor) => wireId(actor.ref.sessionId) === data.sessionId,
    );
    const event = commandEvent(data.event);
    let error: string | undefined;
    if (!actor || actor.name !== "document")
      error = "This demo permits commands only to the document actor";
    else if (!event) error = "Event is not allowed by the demo policy";
    else if (!actor.ref.getSnapshot().can(event))
      error = "Event is not enabled in the current state";
    else {
      try {
        actor.ref.send(event);
      } catch {
        error = "Demo event dispatch failed";
      }
    }
    emit({
      type: "xstate-mcp.send.response",
      requestId: data.requestId,
      success: !error,
      ...(error ? { error } : {}),
    });
  }

  function connect() {
    if (
      disposed ||
      paused ||
      rejected ||
      ws?.readyState === WebSocket.OPEN ||
      ws?.readyState === WebSocket.CONNECTING
    )
      return;
    clearTimeout(retry);
    epoch = crypto.randomUUID(); // Producer IDs are unique across tabs and connection generations.
    onConnection("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      rejected = true;
      onConnection("rejected");
      return;
    }
    ws = socket;
    socket.addEventListener("open", () => {
      if (socket !== ws || disposed) {
        socket.close();
        return;
      }
      retryDelay = 150;
      // Main ignores this proposal. PR #31 accepts it before processing subsequent frames.
      emit({
        type: "xstate-mcp.hello",
        protocolVersion: 1,
        application: { name: "Release note demo" },
        adapter: { name: "frontend-demo", version: "1" },
        capabilities: { commands: ["send_event"] },
      });
      for (const actor of Array.from(actors.values()).sort((a) =>
        a.name === "workspace" ? -1 : 1,
      ))
        register(actor);
      for (const event of recent.splice(0)) sendCaptured(event);
      onConnection("connected");
    });
    socket.addEventListener("message", (message) => {
      if (socket !== ws || disposed || paused) return;
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const record = data as Record<string, unknown>;
      if (
        record.type === "xstate-mcp.hello.response" &&
        record.success !== true
      ) {
        rejected = true;
        onConnection("rejected");
        socket.close();
        return;
      }
      if (record.type === "xstate-mcp.send") handleCommand(record);
    });
    socket.addEventListener("close", () => {
      if (socket !== ws || disposed) return;
      ws = undefined;
      if (rejected) return;
      onConnection("disconnected");
      if (!paused) {
        retry = setTimeout(connect, retryDelay);
        retryDelay = Math.min(2000, retryDelay * 2);
      }
    });
    socket.addEventListener("error", () => {
      /* close schedules a bounded-delay reconnect */
    });
  }

  return {
    inspect(event: InspectionEvent) {
      // This callback only receives native events from this page's real XState actors.
      const ref = event.actorRef as AnyActorRef;
      if (disposed || (ref.id !== "workspace" && ref.id !== "document")) return;
      const actor: TrackedActor = { ref, name: ref.id };
      if (event.type === "@xstate.actor") {
        actors.set(actor.ref.sessionId, actor);
        register(actor, false);
      }
      if (event.type === "@xstate.snapshot")
        emit({
          type: event.type,
          sessionId: wireId(actor.ref.sessionId),
          snapshot: snapshot(actor, event.snapshot),
          event: { type: event.event.type },
          createdAt: stamp(),
        });
      if (event.type === "@xstate.event") {
        const captured: CapturedEvent = {
          target: actor.ref.sessionId,
          source:
            event.sourceRef && actors.has(event.sourceRef.sessionId)
              ? event.sourceRef.sessionId
              : undefined,
          event: commandEvent(event.event) ?? { type: event.event.type },
          createdAt: stamp(),
        };
        if (ws?.readyState === WebSocket.OPEN) sendCaptured(captured);
        else {
          recent.push(captured);
          if (recent.length > 50) recent.shift();
        }
      }
    },
    connect,
    pause() {
      paused = true;
      clearTimeout(retry);
      ws?.close();
      onConnection("disconnected");
    },
    resume() {
      if (disposed) return;
      paused = false;
      rejected = false;
      if (ws) {
        ws.close();
        ws = undefined;
      }
      connect();
    },
    dispose() {
      disposed = true;
      clearTimeout(retry);
      ws?.close();
      ws = undefined;
      actors.clear();
      recent.length = 0;
    },
  };
}
