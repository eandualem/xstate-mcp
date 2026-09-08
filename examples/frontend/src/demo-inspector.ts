import {
  createInspectionGuard,
  type PolicyResult,
} from "../../../dist/inspection-policy.js";
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
  const guard = createInspectionGuard({
    enabled: import.meta.env.DEV,
    writePolicy: {
      readOnly: false,
      allow: [
        {
          actor: "*",
          events: ["SAVE", "RETRY", "CHANGE_TITLE", "CHANGE_BODY"],
        },
      ],
    },
    redaction: { keys: ["draftAccessToken"] },
  });
  const actors = new Map<string, TrackedActor>();
  const recent: CapturedEvent[] = [];
  let ws: WebSocket | undefined;
  let epoch = "";
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 150;
  let negotiated = false;
  let negotiationDeadline: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let paused = false;
  let rejected = false;
  const url = import.meta.env.VITE_XSTATE_MCP_URL ?? "ws://127.0.0.1:7357";
  const wireId = (id: string) => `${epoch}.${id.replace(/:/g, "_")}`;
  const root = () =>
    Array.from(actors.values()).find((actor) => actor.name === "workspace");
  const control = (value: unknown) => {
    if (guard.enabled && ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(value));
  };
  const emit = (value: unknown) => {
    if (!negotiated || ws?.readyState !== WebSocket.OPEN) return;
    const serialized = guard.serializeInspection(value);
    if (serialized !== null) ws.send(serialized);
  };
  const stamp = () => new Date().toISOString();

  function snapshot(actor: TrackedActor, value = actor.ref.getSnapshot()) {
    if (!value) return undefined;
    const context = value.context as DocumentContext;
    return {
      status: value.status,
      value: value.value,
      // Project plain data; the shared guard redacts the fixture token before transfer.
      context:
        actor.name === "document"
          ? {
              title: context.title,
              body: context.body,
              saved: context.saved,
              attempts: context.attempts,
              revision: context.revision,
              error: context.error,
              draftAccessToken: context.draftAccessToken,
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
    let result: PolicyResult;
    if (!actor || actor.name !== "document")
      result = {
        success: false,
        code: "actor_not_found",
        error: "This demo permits commands only to the document actor",
      };
    else if (!event)
      result = {
        success: false,
        code: "write_not_allowed",
        error: "Event is not allowed by the demo policy",
      };
    else if (!actor.ref.getSnapshot().can(event))
      result = {
        success: false,
        code: "invalid_event",
        error: "Event is not enabled in the current state",
      };
    else
      result = guard.dispatch(
        {
          sessionId: wireId(actor.ref.sessionId),
          send: () => actor.ref.send(event),
        },
        { ...data, event },
      );
    control({
      type: "xstate-mcp.send.response",
      requestId: data.requestId,
      ...result,
    });
  }

  function connect() {
    if (
      !guard.enabled ||
      disposed ||
      paused ||
      rejected ||
      ws?.readyState === WebSocket.OPEN ||
      ws?.readyState === WebSocket.CONNECTING
    )
      return;
    clearTimeout(retry);
    clearTimeout(negotiationDeadline);
    negotiated = false;
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
      if (socket !== ws || disposed || paused) {
        socket.close();
        return;
      }
      // Bound an unresponsive peer without treating an open socket as negotiation.
      negotiationDeadline = setTimeout(() => {
        if (socket === ws && !negotiated) socket.close();
      }, 5000);
      control({
        type: "xstate-mcp.hello",
        protocolVersion: 1,
        application: { name: "Release note demo" },
        adapter: { name: "frontend-demo", version: "1" },
        capabilities: { commands: ["send_event"] },
      });
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
      if (record.type === "xstate-mcp.hello.response") {
        if (negotiated) return;
        clearTimeout(negotiationDeadline);
        if (
          record.success !== true ||
          record.protocolVersion !== 1 ||
          typeof record.connectionId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            record.connectionId,
          ) ||
          !Array.isArray(record.commands) ||
          !record.commands.includes("send_event")
        ) {
          rejected = true;
          onConnection("rejected");
          socket.close();
          return;
        }
        negotiated = true;
        retryDelay = 150;
        for (const actor of Array.from(actors.values()).sort((a) =>
          a.name === "workspace" ? -1 : 1,
        ))
          register(actor);
        for (const event of recent.splice(0)) sendCaptured(event);
        onConnection("connected");
        return;
      }
      if (negotiated && record.type === "xstate-mcp.send")
        handleCommand(record);
    });
    socket.addEventListener("close", () => {
      if (socket !== ws || disposed) return;
      clearTimeout(negotiationDeadline);
      negotiated = false;
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
        if (negotiated && ws?.readyState === WebSocket.OPEN)
          sendCaptured(captured);
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
      clearTimeout(negotiationDeadline);
      negotiated = false;
      ws?.close();
      onConnection("disconnected");
    },
    resume() {
      if (disposed) return;
      paused = false;
      rejected = false;
      clearTimeout(negotiationDeadline);
      negotiated = false;
      if (ws) {
        ws.close();
        ws = undefined;
      }
      connect();
    },
    dispose() {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(negotiationDeadline);
      negotiated = false;
      ws?.close();
      ws = undefined;
      actors.clear();
      recent.length = 0;
    },
  };
}
