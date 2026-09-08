# Purpose and architecture

xstate-mcp gives an AI coding agent access to the runtime behavior of an XState
v5 application. Reading machine source explains what could happen; this server
shows what actors exist, their state and context, and recent events. With an
application-side command handler, the agent can send an event and inspect the
result. A browser tool verifies that the rendered UI agrees with the machine.

The intended development loop is:

1. Discover the actors and identify the relevant machine.
2. Inspect its state, definition, and recent history.
3. Change application code, interact with the UI, or send a machine event.
4. Observe the resulting state and event history.
5. Verify the UI and add a regression test for the behavior being developed.

The coding agent performs the frontend development. xstate-mcp supplies runtime
evidence; it does not generate code, open a browser, execute a model, or host an app.
Its three prompts assemble debugging context for the agent's model.

## Components

```text
Application / XState v5
  inspection callback + application-side event handler
                │ inspection messages / command acknowledgements
                ▼
  ws-server.ts ───────► ActorStore (actor records + per-actor history)
       ▲                    │
       │                    ▼
  ClientRegistry ◄──── mcp-server.ts ◄────► MCP client / coding agent
       │               tools, resources,          stdio
       └─ event command ──► application
```

- `config.ts` loads environment configuration; `cli.ts` starts the process and
  owns stdio, signals, and shutdown. `index.ts` exports import-safe factories.
- `inspection-server.ts` coordinates the inspection listener, actor storage,
  command registry, and MCP transport through explicit `start()` and `close()`.
- `ws-server.ts` validates and normalizes inspection messages with schemas in
  `types.ts`. Registration associates an actor with the producing socket.
- `actor-store.ts` holds the last snapshot, machine definition, actor metadata,
  and two ring buffers: events and snapshot changes. Context-only changes also
  create timeline entries, so the timeline is not exclusively state-value changes.
- `client-registry.ts` routes commands and waits up to five seconds for a response.
- `mcp-server.ts` registers eleven tools, `xstate://actors`, two per-actor resource
  templates (snapshot and definition), and three prompts. Tool handlers and prompt
  builders live in separate directories.

The process keeps data in memory. Restarting it loses history; disconnecting an
application removes that client's actors. Per-actor ring buffers bound the number
of entries. Actor counts, payload bytes, and pending requests have no global budget.

## Contracts and limits

The incoming inspection types are `@xstate.actor`, `@xstate.event`, and
`@xstate.snapshot`; `@xstate.microstep` is intentionally skipped. Normalization
accepts top-level session identifiers or serialized actor references. A useful
adapter must retain registration, stable identity, hierarchy, definitions, and
snapshots through startup and reconnects. The current README adapters have known
gaps documented in the [September review](reviews/2026-09-07.md).

`send_event` emits `xstate-mcp.send` with a request ID, session ID, and event. The
application must respond with `xstate-mcp.send.response`. A successful response
acknowledges dispatch; guards or asynchronous work can still leave the actor in
the same state. `can_handle_event` currently checks definition structure without
executing guards and has additional wildcard/forbidden-transition limitations.

The server defaults to loopback and an origin allowlist. Context and event data
become available to the configured MCP client; that client may send them to its
model provider. Application-side redaction and development-only instrumentation
are planned improvements. This server has no outbound telemetry of its own.

## Historical context

The original consumer was the Lovely Console orchestration dashboard. The old
configuration was kept outside this checkout in orchestration's
`archive/config/core/code/WF/xstate-mcp/{AGENTS,CLAUDE}.md`. Those files described
the initial four-tool, read-only version and inherited workspace instructions.

This repository preserves the useful design rationale: TypeScript, stdio plus
WebSocket, stderr-only logging, per-actor ring buffers, and in-memory debugging.
The current tool count, file names, write capabilities, and known limitations
come from the actual implementation. Claims of uniqueness, old workspace paths,
private skills, named agent roles, and inherited branch policies are not required.

The shared instruction/handoff pattern was adapted from
[agent-backbone](https://github.com/eandualem/agent-backbone).
