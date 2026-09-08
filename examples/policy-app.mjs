// Run from a built checkout: NODE_ENV=development node examples/policy-app.mjs
import { createActor, createMachine, assign } from "xstate";
import WebSocket from "ws";
import { createInspectionGuard } from "xstate-mcp/inspection-policy";

const guard = createInspectionGuard({
  enabled: process.env.NODE_ENV === "development",
  writePolicy: {
    readOnly: false,
    allow: [{ actor: "*", events: ["NEXT"] }],
  },
  redaction: { keys: ["email"] },
});

if (guard.enabled) {
  const port = Number(process.env.XSTATE_MCP_WS_PORT ?? 7357);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  const machine = createMachine({
    id: "policy-demo",
    initial: "idle",
    context: { count: 0, password: "demo-secret", email: "demo@example.test" },
    states: {
      idle: {
        on: {
          NEXT: {
            target: "ready",
            actions: assign({ count: ({ context }) => context.count + 1 }),
          },
        },
      },
      ready: { on: { RESET: "idle" } },
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let actor;
  const deadline = setTimeout(() => {
    process.stderr.write("Development inspector connection timed out\n");
    process.exitCode = 1;
    ws.terminate();
  }, 5000);
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "xstate-mcp.hello",
        protocolVersion: 1,
        application: { name: "policy-demo" },
        adapter: { name: "policy-example", version: "1.0.0" },
        capabilities: { commands: ["send_event"] },
      }),
    );
  });
  function startActor() {
    clearTimeout(deadline);
    actor = createActor(machine, {
      inspect(event) {
        if (
          event.type !== "@xstate.actor" &&
          event.type !== "@xstate.snapshot" &&
          event.type !== "@xstate.event"
        )
          return;
        // Project data first. Native actor refs are live objects with internal state.
        const snapshot =
          event.type === "@xstate.snapshot" ? event.snapshot : undefined;
        const message = guard.serializeInspection({
          type: event.type,
          sessionId: event.actorRef.sessionId,
          ...(event.type === "@xstate.actor"
            ? { name: "policy-demo", definition: machine.toJSON() }
            : {}),
          ...(snapshot
            ? {
                snapshot: {
                  status: snapshot.status,
                  value: snapshot.value,
                  context: snapshot.context,
                  output: snapshot.output,
                },
              }
            : {}),
          ...(event.type === "@xstate.event" ||
          event.type === "@xstate.snapshot"
            ? { event: event.event }
            : {}),
          createdAt: new Date().toISOString(),
        });
        if (message !== null && ws.readyState === WebSocket.OPEN)
          ws.send(message);
      },
    });
    actor.start();
    process.stderr.write(
      "Policy demo ready; NEXT is allowed, RESET is denied\n",
    );
  }
  ws.on("message", (raw) => {
    let command;
    try {
      command = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (command?.type === "xstate-mcp.hello.response") {
      if (
        command.success === true &&
        command.protocolVersion === 1 &&
        command.commands?.includes("send_event")
      ) {
        if (!actor) startActor();
      } else {
        clearTimeout(deadline);
        process.stderr.write("Development inspector negotiation failed\n");
        process.exitCode = 1;
        ws.terminate();
      }
      return;
    }
    if (
      !command ||
      command.type !== "xstate-mcp.send" ||
      typeof command.requestId !== "string" ||
      command.requestId.length > 128
    )
      return;
    const result = guard.dispatch(actor, command);
    ws.send(
      JSON.stringify({
        type: "xstate-mcp.send.response",
        requestId: command.requestId,
        ...result,
      }),
    );
  });
  ws.on("error", () => {
    clearTimeout(deadline);
    process.stderr.write("Development inspector connection failed\n");
    process.exitCode = 1;
  });
  ws.on("close", () => {
    clearTimeout(deadline);
    actor?.stop();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      clearTimeout(deadline);
      ws.terminate();
      actor?.stop();
    });
}
