# xstate-mcp

[![npm version](https://img.shields.io/npm/v/xstate-mcp.svg)](https://www.npmjs.com/package/xstate-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that gives AI coding agents live read/write access to XState v5 state machines. See every running actor, query state and context, inspect event history, check transition eligibility, and send events — without console.log or React DevTools.

The intended loop is **observe the running machine → develop or exercise the
frontend → verify state and UI**. The coding agent writes the frontend; this
server supplies runtime evidence. See [purpose and architecture](docs/concepts.md),
[contributing](CONTRIBUTING.md), and [working across coding agents](docs/agent-workflow.md).

**September 2026 review:** the existing 148 tests pass, but real application checks
found adapter compatibility and lifecycle bugs. Read the
[review and issue roadmap](docs/reviews/2026-09-07.md) before relying on the browser
examples below. The [demo plan](docs/demo-plan.md) follows the reliability fixes.
## Runnable frontend example

[Fieldnotes](examples/frontend/README.md) demonstrates the complete local MCP loop
with a real XState release-note editor: inspect root/child actors, save, observe an
intentional failure, reject a forbidden command, retry, and verify the rendered UI.
Automated browser/MCP tests require no model or API key. See the example guide for
clean-clone commands, current-main compatibility, and captured evidence.

## Quick Start

Requires Node.js 22.23.2+ within 22.x, or 24.20.0+ within 24.x.
See the [runtime and dependency policy](docs/runtime-support.md).

### 1. Configure your MCP client

**Claude Code** — add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "xstate-mcp": {
      "command": "npx",
      "args": ["-y", "xstate-mcp"]
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xstate-mcp": {
      "command": "npx",
      "args": ["-y", "xstate-mcp"],
      "env": {
        "XSTATE_MCP_WS_PORT": "7357"
      }
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "xstate-mcp": {
      "command": "npx",
      "args": ["-y", "xstate-mcp"]
    }
  }
}
```

Or install globally:

```bash
npm install -g xstate-mcp
```

### 2. Verify with MCP Inspector (optional)

Confirm the server works before wiring up your app:

```bash
npx -y @modelcontextprotocol/inspector npx -y xstate-mcp
```

This opens a web UI at `http://localhost:6274`. The server exposes 12 tools, 1 fixed resource, 2 resource templates, and 3 prompts. `list_actors` returns an empty actor list when no application is connected. This verifies MCP discovery only; it does not verify that the application inspection connection works.

## Library and lifecycle

The `xstate-mcp` command starts the inspection bridge. The package's ESM import
is a library: it exports an idle `createInspectionServer` factory and the
`createSandboxServer` capability-scanning factory (also the default export).
Imports read no process configuration, bind no port, and attach no stdio.

The CLI waits for the inspection port before connecting MCP. It closes connected
applications and pending commands on SIGINT, SIGTERM, or stdin EOF. For direct
execution from a checkout, use `node dist/cli.js`; `dist/index.js` is now the
importable library. See [embedding, migration, and shutdown](docs/server-lifecycle.md).

## Configuration

| Environment Variable         | Default                                 | Description                                                                    |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `XSTATE_MCP_WS_PORT`         | `7357`                                  | WebSocket server port                                                          |
| `XSTATE_MCP_WS_HOST`         | `127.0.0.1`                             | WebSocket server bind address (localhost only by default)                      |
| `XSTATE_MCP_BUFFER_SIZE`     | `100`                                   | Max events per actor in ring buffer                                            |
| `XSTATE_MCP_LOG_LEVEL`       | `info`                                  | Logging verbosity (`debug`, `info`, `warn`, `error`)                           |
| `XSTATE_MCP_ALLOWED_ORIGINS` | `http://localhost:*,http://127.0.0.1:*` | Comma-separated list of allowed WebSocket origins (supports `*` port wildcard) |
| `XSTATE_MCP_REQUIRE_ORIGIN`  | `false`                                 | When `true`, reject WebSocket connections without an Origin header             |

Application write settings are `XSTATE_MCP_READ_ONLY` (default `true`) and
`XSTATE_MCP_WRITE_ALLOW` (JSON paired actor/event rules, default `[]`). Additional
redaction is configured by `XSTATE_MCP_REDACTION` (JSON, default `{}`). See
[the policy guide](docs/write-controls-and-redaction.md) for examples and limits.

## Browser Adapter

Use a development-only adapter that projects native XState inspection events into
plain data, redacts before sending, and checks write policy immediately before
`actor.send`. Import `createInspectionGuard` from `xstate-mcp/inspection-policy`;
it defaults to disabled and read-only.

Inspection reception is tested with **XState 5.32.6** and
**@statelyai/inspect 0.7.2**, using a real root/child machine over WebSocket and
MCP client queries. Stately's nullable message IDs are accepted; actor session
IDs still require strings. The inspector integration supplies definitions,
parent relationships, snapshots, and event history. Bidirectional commands
still require an application handler and the write policies described below.

Incoming `createdAt` may be an integer epoch-millisecond string or an ISO
timestamp with `Z` or an explicit timezone offset. Stored timestamps use UTC ISO
format with millisecond precision. When `createdAt` is absent (native inspection),
the server uses receipt time. Invalid supplied timestamps are rejected rather
than replaced with receipt time; timezone-free dates and numeric JSON values
are not supported. History retains receipt order rather than sorting by
producer clocks.

See [write controls and redaction](docs/write-controls-and-redaction.md) for the
contract and [the runnable single-actor example](examples/policy-app.mjs). The
example requires a built checkout; this helper is not in historical npm releases.
The complete reconnecting adapter is tracked in #13.

### Enabling `send_event` (bidirectional)

Application writes are disabled by default. Set `XSTATE_MCP_READ_ONLY=false` and
an explicit `XSTATE_MCP_WRITE_ALLOW` array, and opt into the adapter's own policy.
For example, `[{"actor":"*","events":["NEXT"]}]` permits only `NEXT` on any actor.
Empty rules deny everything; read-only true overrides all rules. The server checks
the resolved public session ID even when the tool target is an actor name.

A successful acknowledgement confirms dispatch, not a completed transition. Read
the actor state/history afterward, and verify the UI when developing a frontend.

For writes, install the handler before sending a version-1 `xstate-mcp.hello` on
that same socket and wait for its successful response. The
[policy example](examples/policy-app.mjs) combines negotiation, serialization and
local write checks; see the [handshake guide](docs/connection-health.md). General
reconnect handling remains [#13](https://github.com/eandualem/xstate-mcp/issues/13).

### Incoming message validation

Every WebSocket message must be a JSON object with a non-empty string `type`
of at most 128 characters.
The server ignores malformed JSON, nulls, arrays, primitives, and invalid
inspection messages while keeping the connection available for valid traffic.

A `xstate-mcp.send.response` acknowledgement must include a non-empty string
`requestId` of at most 128 characters copied from the command and a boolean
`success`. Optional `error` must be a string of at most 4096 characters; omit it
when there is no error. Optional `code` must be a non-empty string of at most
128 characters; only the guard's fixed rejection codes are exposed on failed ACKs.
Invalid acknowledgements leave
the pending request intact so a valid reply can still resolve it, subject to
the existing timeout. Unknown request IDs are ignored. Validation warnings and
unknown-request warnings use fixed descriptions on stderr, without echoing the
incoming payload or request ID.

## Application identity

Each WebSocket connection gets its own namespace. Two tabs with identical local
XState IDs remain independent. Use `applicationName` (an optional URL query
parameter) and `connectionId` from `list_actors` to select an application, then
copy the returned opaque `sessionId` into tools, prompts, and resource URIs.

This changes MCP identifiers: local IDs such as `x:0` are no longer actor keys.
Application-side inspection and command messages continue to use local IDs.
Reconnects get fresh namespaces and require rediscovery. See the
[application-session contract and migration guide](docs/application-sessions.md).

## Tools

Examples below abbreviate public IDs as `app-session` and `agents-session`.
Always copy the actual opaque `sessionId` from discovery.

### Discovery & Orientation

#### `get_connection_health`

Start here when no actors appear or before sending an event. Reports the actual
listener endpoint, live applications (including sockets without actors), negotiated
adapter/protocol versions, supported commands, rejected-frame counters and freshness.
Output contains metadata only, with at most 50 connection rows.

**Parameters:** optional `limit` (integer 1–50), `offset` (nonnegative integer),
and `connectionId` (UUID). Use `nextOffset` for further pages.

See the [connection doctor guide](docs/connection-health.md) for expected failure
outputs, the version-1 adapter handshake and a runnable XState example. Legacy
inspectors remain readable; `send_event` now requires a successful hello advertising
that command and otherwise fails immediately with remediation.

#### `list_actors`

What's running right now? Returns all registered actors with their current state, status, and child count.

**Parameters:** optional `connectionId` and `status` filters

```json
{
  "actors": [
    {
      "sessionId": "app-session",
      "localSessionId": "x:0",
      "connectionId": "connection-A",
      "applicationName": "Checkout",
      "name": "app",
      "currentState": "ready",
      "status": "active",
      "childCount": 5
    },
    {
      "sessionId": "agents-session",
      "localSessionId": "x:0:agents",
      "connectionId": "connection-A",
      "applicationName": "Checkout",
      "name": "agentsMachine",
      "currentState": "idle",
      "status": "active",
      "childCount": 0
    }
  ],
  "totalActors": 2
}
```

#### `get_actor_tree`

See the parent-child hierarchy. Useful when your app has nested or parallel actors.

**Parameters:** optional `connectionId` filter

```json
{
  "tree": [
    {
      "sessionId": "app-session",
      "localSessionId": "x:0",
      "connectionId": "connection-A",
      "applicationName": "Checkout",
      "name": "app",
      "state": "ready",
      "status": "active",
      "children": [
        {
          "sessionId": "agents-session",
          "localSessionId": "x:0:agents",
          "connectionId": "connection-A",
          "applicationName": "Checkout",
          "name": "agentsMachine",
          "state": "idle",
          "status": "active",
          "children": []
        }
      ]
    }
  ],
  "totalActors": 2
}
```

#### `get_actor_state`

Drill into one actor — state value, context, status, completion output, and sanitized
error details. See [lifecycle diagnostics](docs/lifecycle.md) for field semantics
and adapter requirements.

**Parameters:**

- `sessionId` (string) — actor's session ID from `list_actors`

```json
{
  "sessionId": "agents-session",
  "localSessionId": "x:0:agents",
  "connectionId": "connection-A",
  "applicationName": "Checkout",
  "name": "agentsMachine",
  "status": "active",
  "value": "idle",
  "context": { "entities": [], "selectedId": null },
  "output": null,
  "error": null,
  "parentId": "app-session",
  "updatedAt": "2026-02-28T12:00:01.500Z",
  "cursor": {
    "generation": "5d2727b8-c095-4b22-946e-464b5e3f7f64",
    "snapshot": 3,
    "event": 1
  }
}
```

#### `get_machine_definition`

Full state chart structure — states, transitions, guards, actions, invoked services.

**Parameters:**

- `sessionId` (string)

```json
{
  "sessionId": "agents-session",
  "name": "agentsMachine",
  "definition": {
    "id": "agents",
    "initial": "idle",
    "states": {
      "idle": { "on": { "sys.refresh": "loading" } },
      "loading": { "invoke": { "src": "fetcher" } }
    }
  }
}
```

### Analysis & Debugging

#### `get_event_history`

Raw events that flowed through an actor (from the ring buffer). Includes full event payloads.
Response `sessionId` and `sourceId` values are public actor IDs; inspection frames
use the application's local IDs before the server scopes them to a connection.

**Parameters:**

- `sessionId` (string)
- `limit` (number, optional, default: 20)

```json
{
  "sessionId": "agents-session",
  "events": [
    {
      "sequence": 1,
      "event": { "type": "sys.refresh" },
      "sourceId": "app-session",
      "createdAt": "2026-02-28T12:00:01.000Z"
    }
  ],
  "totalInBuffer": 1,
  "bufferCapacity": 100,
  "cursor": {
    "generation": "5d2727b8-c095-4b22-946e-464b5e3f7f64",
    "snapshot": 3,
    "event": 1
  }
}
```

#### `get_state_timeline`

History of state, context, and lifecycle changes — from/to values and statuses,
triggering event, and timestamps. `type` distinguishes state changes from context
updates and lifecycle results; `changes` lists every changed field. The existing
`transitions` and `totalTransitions` fields count all three types. See
[timeline semantics](docs/lifecycle.md#timeline-entries).

**Parameters:**

- `sessionId` (string)
- `limit` (number, optional, default: 50)

```json
{
  "sessionId": "agents-session",
  "name": "agentsMachine",
  "currentState": "idle",
  "totalTransitions": 4,
  "transitions": [
    {
      "type": "state",
      "changes": ["value"],
      "fromValue": "idle",
      "toValue": "loading",
      "fromStatus": "active",
      "toStatus": "active",
      "event": "sys.refresh",
      "timestamp": "2026-02-28T12:00:01.000Z"
    },
    {
      "type": "state",
      "changes": ["value"],
      "fromValue": "loading",
      "toValue": "idle",
      "fromStatus": "active",
      "toStatus": "active",
      "event": "xstate.done.actor.0.agents.loading",
      "timestamp": "2026-02-28T12:00:01.500Z"
    }
  ]
}
```

#### `can_handle_event`

Static check of the current snapshot and supplied definition, with XState v5
child/ancestor precedence, partial/global wildcards and forbidden transitions.
`canHandle` is `true` for a structural handler, `false` for no handler, a forbidden
transition or an inactive actor, and `null` when the answer is unknown. Known
guards are never evaluated and produce `null`. Missing/incomplete definitions or
snapshots also produce `null`.

Every successful result has `analysis: "static"` and a `reason`. `matchedTransitions` contains
selected handler paths (or the guarded candidate for an unknown result);
`blockedTransitions` contains selected forbidden paths. These are paths in the
supplied definition, not a list of all ancestor/wildcard declarations.
Serialization can omit inline guards and other details, so even a structural
match does not guarantee a runtime transition. See the
[semantics and schema migration](docs/event-eligibility.md).

**Parameters:**

- `sessionId` (string)
- `eventType` (string) — e.g. `"sys.refresh"`, `"SUBMIT"`

```json
{
  "sessionId": "agents-session",
  "canHandle": true,
  "analysis": "static",
  "reason": "transition_found",
  "currentState": "idle",
  "matchedTransitions": ["idle.on.sys.refresh"],
  "blockedTransitions": [],
  "note": "Static evidence from the supplied definition and snapshot; guards are not evaluated and serialization may omit them. null means unknown. A structural match does not guarantee a transition; verify state after sending the full event."
}
```

#### `wait_for_state` and `wait_for_event`

Wait for observed state or events after an action, with bounded timeouts and
cancellation. Neither tool sends events or executes guards/actions.

- `wait_for_state`: `sessionId`, exact `state` and/or `status`, optional `after`
  cursor, and optional `timeoutMs`. Both predicates must match when supplied.
- `wait_for_event`: `sessionId`, exact `eventType`, optional `after` cursor,
  and optional `timeoutMs`. Without a cursor, only future events match.
- Timeouts default to 5000 ms, accept integers from 0 to 30000, and zero checks
  once. Each server allows at most 100 pending waits.

Capture the cursor from `get_actor_state`, `get_event_history`, or a snapshot
resource before triggering the action. A result includes an `outcome`, timing,
and the matched snapshot/event when successful. Timeouts, disconnects, actor
removal/replacement, and evicted event history have distinct outcomes. See the
[verification contract and examples](docs/verification-waits.md).

### Actions

#### `send_event`

Send an event to a running actor. Target can be a sessionId or actor name. Requires explicit [server and adapter write permission](#enabling-send_event-bidirectional). Events may cause destructive application side effects.

**Parameters:**

- `target` (string) — sessionId or actor name
- `event` (object) — must have a `type` field, e.g. `{ "type": "sys.refresh" }`

```json
{
  "sessionId": "agents-session",
  "event": { "type": "sys.refresh" },
  "success": true
}
```

Capture a cursor before sending, then use `wait_for_state` or `wait_for_event`
to verify asynchronous work. Use `get_state_timeline` or `get_actor_state` for
additional diagnostics.

#### `clear_actors`

Reset the registry. Actors re-register automatically on next page load.

**Parameters:** none

```json
{
  "cleared": 44
}
```

## Workflows

### "What's running right now?"

Start every debugging session here:

```
get_connection_health → check listener, application, freshness and commands
list_actors         → see all actors, their states, and statuses
get_actor_tree      → see the parent-child hierarchy
get_actor_state     → drill into one actor for full context
```

### "Can this machine handle what I'm about to send?"

Inspect the structural evidence before triggering an action:

```
can_handle_event(sessionId, "sys.refresh")
→ { canHandle: true, matchedTransitions: ["idle.on.sys.refresh"] }

can_handle_event(sessionId, "NAVIGATE")
→ { canHandle: false, matchedTransitions: [] }
```

Handle `canHandle === null` as unknown; use `reason` to identify missing data or
guards. Do not coerce it to `false`. A `true` result is structural evidence only:
send the complete event payload when appropriate, then inspect state/history and
the UI to verify what actually happened.

### "Trigger and verify"

```
send_event(target: "actor-session", event: { type: "sys.refresh" })
→ { success: true }

get_state_timeline(sessionId: "actor-session", limit: 3)
→ idle → loading → idle (with timestamps)
```

### "What happened?"

When debugging unexpected behavior:

```
get_state_timeline   → ordered state transitions (high level)
get_event_history    → raw events with full payloads (low level)
```

Use timeline first to see state flow, drill into events when you need the data.

### "Understand a machine"

```
get_machine_definition  → full state chart (states, transitions, guards)
get_actor_state         → current state and context
get_event_history       → recent activity
```

### The verification loop (with Playwright or similar)

The highest-value pattern combines xstate-mcp with a browser automation tool:

1. **Navigate** to the page (Playwright)
2. **Capture state before** — `get_actor_state` on the domain machine
3. **Trigger action** — click a button (Playwright) or `send_event`
4. **Verify state after** — `get_actor_state` again — did the machine transition?
5. **Check event flow** — `get_event_history` — did the right events fire?
6. **Verify visual** — screenshot (Playwright) — does the UI match the state?

This catches the two most common XState integration bugs:

- UI shows the right thing but the machine didn't transition (local state bypass)
- Machine transitioned correctly but the UI doesn't reflect it (render bug)

## Resources

MCP resources provide direct access to actor data without tool calls. Resource
subscription support is incomplete: the server emits some notifications but does
not implement `resources/subscribe` or `resources/unsubscribe`. Use explicit reads
until the subscription issue in the review is resolved.

| Resource           | URI                                     | Description                                         |
| ------------------ | --------------------------------------- | --------------------------------------------------- |
| Actor list         | `xstate://actors`                       | All registered actors with current state and status |
| Actor snapshot     | `xstate://actor/{sessionId}/snapshot`   | Current state snapshot of a specific actor          |
| Machine definition | `xstate://actor/{sessionId}/definition` | Machine JSON definition for a specific actor        |

Template resources support autocomplete — type a partial sessionId or actor name and the server suggests matches.

## Prompts

Pre-built analysis prompts that assemble actor data into structured context for the LLM.

All three include current status, output, and sanitized error details. Debugging
and tracing prompts distinguish state, context, and lifecycle timeline entries.

#### `debug_actor`

Pulls state, event history, transitions, and machine definition for an actor and asks the LLM to check for state consistency issues, missed transitions, stuck states, and context validity.

**Arguments:** `sessionId` (string)

#### `explain_machine`

Fetches the machine definition and current state, then asks the LLM to explain states, transitions, guards, and the actor's current position in plain language.

**Arguments:** `sessionId` (string)

#### `trace_event_flow`

Assembles the full event and transition history, then asks the LLM to walk through each event chronologically, explaining what triggered each transition and why the machine ended up in its current state.

**Arguments:** `sessionId` (string)

## Usage Examples

### "Why is the form stuck?"

```
User: The checkout form isn't submitting. Can you check what state the form machine is in?

Agent uses: list_actors → finds "formMachine" at sessionId "form-session"
Agent uses: get_actor_state("form-session") → state: "validating", context: { errors: ["email"] }
Agent uses: can_handle_event("form-session", "SUBMIT") → canHandle: false

Agent: The form machine is stuck in "validating" because there's an email validation
error in the context. The SUBMIT event can't fire from this state — the machine
needs the validation to pass first. Check the email field validation logic.
```

### "What happened after the user clicked refresh?"

```
User: Something broke after the refresh button was clicked. Trace what happened.

Agent uses: get_state_timeline("agents-session", limit: 5) →
  idle → loading → error (event: "xstate.error.actor")

Agent uses: get_event_history("agents-session", limit: 10) →
  Shows the error event payload: { type: "xstate.error.actor", data: { status: 500 } }

Agent: The agents machine transitioned from idle to loading on sys.refresh, then
hit an error state because the API returned a 500. The error payload is in the
event history — it's a server-side failure, not a state machine bug.
```

### "Help me understand this machine"

```
User: I'm new to this codebase. Can you explain the session machine?

Agent uses prompt: explain_machine("x:0:sessions")

Agent: The sessions machine manages WebSocket connection lifecycle. It has 4 states:
- disconnected (initial) — waiting for a connect event
- connecting — attempting WebSocket handshake, with a 5s timeout
- connected — active session, handles message events
- reconnecting — after disconnect, tries to reconnect with exponential backoff
...
```

## Architecture

```
Browser (XState 5 app)              xstate-mcp                    AI Coding Tool
──────────────────────              ──────────                    ──────────────
createActor(machine, {              WebSocket Server :7357         MCP Client
  inspect: callback  ────────────►  receives inspection events     (stdio)
})                                  stores in ActorStore
                                    ↓
                    xstate-mcp.send ◄────────────────────────────► send_event
                                    ↓
                                    McpServer (stdio)  ──────────► 12 tools, 3 resources, 3 prompts
```

- **MCP transport:** stdio (standard for Claude Code MCP servers)
- **WebSocket:** receives the XState inspection stream from the browser; also sends `send_event` commands back
- **Storage:** in-memory only — actors re-register on page load, no persistence across restarts
- **Event history:** ring buffer per actor (bounded, configurable — default 100 events)
- **State timeline:** separate ring buffer tracking state, context, and lifecycle changes

## Development

For contributors working on xstate-mcp itself:

```bash
git clone https://github.com/eandualem/xstate-mcp.git
cd xstate-mcp
bun install --frozen-lockfile # Install the reviewed dependency graph
bun run dev           # Start dev server (tsx watch)
bun run build         # Production build (tsup)
bun run test          # Run tests (vitest)
bun run lint          # ESLint
bun run format        # Prettier
bun run check         # Full quality gate (lint + format + types + test)
```

Use Node.js 24.20.0 (`.node-version`) and Bun 1.4.2 (`.bun-version` and
`packageManager`) for contribution. Node.js 22.23.2 is also tested in CI. Keep
`bun.lock` authoritative and use frozen installs; do not add another lockfile.
`bun run audit:check` checks advisories with the single documented exception in
[the dated audit](docs/dependency-audit-2026-09-07.md). The
[runtime policy](docs/runtime-support.md) explains support and update procedures.

## Privacy

The server binds to loopback by default, keeps inspection history in memory and
implements no telemetry, persistence or uploads. The MCP client receives results
over stdio and may forward them to its configured model provider or retain them
in logs and conversations.

Redact sensitive data in the application before transfer. Server redaction applies
before retention, so existing tools, resources, prompts and history share sanitized
values. Default secret-key filtering can be extended with application-specific
keys and paths through `XSTATE_MCP_REDACTION`. Context truncation is a presentation
option; it is not a privacy policy. See the [redaction contract and limits](docs/write-controls-and-redaction.md#redaction-contract).

## License

MIT

## Releases and package verification

The repository uses an unpublished development version while revival work is
reviewed. See [the release guide](docs/releases.md) for the historical npm 1.0.3
provenance, reproducible candidate builds, registry metadata and the explicit
maintainer publishing procedure. `bun run release:prepare` builds and verifies a
clean consumer installation; it does not publish.
