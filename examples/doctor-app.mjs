// Opt-in development fixture. Run alongside an MCP client connected to the server.
import { once } from "node:events";
import { WebSocket } from "ws";
import { createActor, createMachine } from "xstate";

const ws = new WebSocket(process.argv[2] ?? "ws://127.0.0.1:7357");
let actor;
let forwarding = true;
const startup = new AbortController();
const startupDeadline = setTimeout(() => {
  console.error("Doctor adapter did not connect/negotiate within 5 seconds");
  startup.abort(new Error("Negotiation timed out"));
  ws.terminate();
  process.exitCode = 1;
}, 5000);
function stop() {
  forwarding = false;
  startup.abort();
  actor?.stop();
  ws.close();
  const deadline = setTimeout(() => ws.terminate(), 500);
  deadline.unref();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
ws.on("close", () => {
  clearTimeout(startupDeadline);
  forwarding = false;
  actor?.stop();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
});
ws.on("error", (error) => console.error(error.message));

ws.on("message", (raw) => {
  const command = JSON.parse(raw.toString());
  if (
    !command ||
    command.type !== "xstate-mcp.send" ||
    typeof command.requestId !== "string"
  )
    return;
  const success =
    actor &&
    command.sessionId === actor.sessionId &&
    command.event &&
    typeof command.event === "object" &&
    typeof command.event.type === "string";
  if (success) actor.send(command.event);
  ws.send(
    JSON.stringify({
      type: "xstate-mcp.send.response",
      requestId: command.requestId,
      sessionId: command.sessionId,
      success: Boolean(success),
      ...(success ? {} : { error: "Unknown actor or invalid event" }),
    }),
  );
});

try {
  await once(ws, "open", { signal: startup.signal });
  const response = once(ws, "message", { signal: startup.signal });
  ws.send(
    JSON.stringify({
      type: "xstate-mcp.hello",
      protocolVersion: 1,
      application: { name: "doctor-example" },
      adapter: { name: "doctor-example", version: "1.0.0" },
      capabilities: { commands: ["send_event"] },
    }),
  );
  const reply = JSON.parse((await response)[0].toString());
  if (
    reply.type !== "xstate-mcp.hello.response" ||
    !reply.success ||
    !reply.commands.includes("send_event")
  )
    throw new Error("Adapter negotiation failed");
  clearTimeout(startupDeadline);
  const machine = createMachine({
    id: "doctor",
    initial: "idle",
    states: { idle: { on: { RUN: "running" } }, running: {} },
  });
  actor = createActor(machine, {
    inspect(event) {
      if (forwarding && ws.readyState === WebSocket.OPEN)
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
  actor.subscribe((snapshot) =>
    console.error(`doctor state: ${snapshot.value}`),
  );
  actor.start();
} catch (error) {
  clearTimeout(startupDeadline);
  console.error(
    error instanceof Error ? error.message : "Doctor adapter failed",
  );
  process.exitCode = 1;
  stop();
}
