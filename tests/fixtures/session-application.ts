import { negotiateApplication } from "./application-hello.js";
// Each subprocess gets its own real XState session counter, just like a browser tab.
import { once } from "node:events";
import { WebSocket } from "ws";
import { createActor, createMachine, sendTo, type AnyActorRef } from "xstate";

const ws = new WebSocket(process.argv[2]);
await once(ws, "open");
await negotiateApplication(ws);
const actors = new Map<string, AnyActorRef>();
const registrations: unknown[] = [];
const commands: unknown[] = [];
let hold = false;
const child = createMachine({
  id: "worker",
  initial: "idle",
  states: { idle: { on: { WORK: "working" } }, working: {} },
});
const machine = createMachine({
  id: "app",
  context: { application: process.argv[3] },
  invoke: { id: "worker", src: child },
  initial: "idle",
  states: {
    idle: {
      on: {
        RUN: { target: "running", actions: sendTo("worker", { type: "WORK" }) },
      },
    },
    running: {},
  },
});
const actor = createActor(machine, {
  inspect(event) {
    if (event.type === "@xstate.actor")
      actors.set(event.actorRef.sessionId, event.actorRef as AnyActorRef);
    // An adapter must preserve local session IDs before Actor.toJSON drops them.
    // _parent/logic.config are fixture-only metadata extraction, not a public adapter API.
    const ref = event.actorRef as AnyActorRef & {
      _parent?: AnyActorRef;
      logic: { config?: unknown };
    };
    const frame = {
      ...event,
      sessionId: ref.sessionId,
      ...(event.type === "@xstate.actor"
        ? {
            name: ref.id,
            parentId: ref._parent?.sessionId,
            definition: ref.logic.config,
          }
        : {}),
      ...(event.type === "@xstate.event"
        ? { sourceId: event.sourceRef?.sessionId }
        : {}),
    };
    if (event.type === "@xstate.actor") registrations.push(frame);
    ws.send(JSON.stringify(frame));
  },
});
ws.on("message", (raw) => {
  const command = JSON.parse(raw.toString());
  if (command.type !== "xstate-mcp.send") return;
  commands.push(command);
  process.send?.({ command });
  if (hold) return;
  const target = actors.get(command.sessionId);
  target?.send(command.event);
  ws.send(
    JSON.stringify({
      type: "xstate-mcp.send.response",
      requestId: command.requestId,
      success: !!target,
    }),
  );
});
async function flush() {
  const pong = once(ws, "pong");
  ws.ping();
  await pong;
}
process.on(
  "message",
  async (input: {
    id: number;
    op: string;
    frames?: unknown[];
    value?: boolean;
  }) => {
    if (input.op === "hold") hold = input.value ?? true;
    if (input.op === "emit")
      for (const frame of input.frames ?? []) ws.send(JSON.stringify(frame));
    if (input.op === "register")
      for (const frame of registrations) ws.send(JSON.stringify(frame));
    await flush();
    process.send?.({ id: input.id, commands });
  },
);
actor.start();
await flush();
process.send?.({ ready: true, rootId: actor.sessionId });
