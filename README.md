# xstate-mcp

[![npm version](https://img.shields.io/npm/v/xstate-mcp.svg)](https://www.npmjs.com/package/xstate-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that gives AI coding agents live read/write access to XState v5 state machines. See every running actor, query state and context, inspect event history, check transition eligibility, and send events — without console.log or React DevTools.

## Runnable frontend example

[Fieldnotes](examples/frontend/README.md) demonstrates the complete local MCP loop
with a real XState release-note editor: inspect root/child actors, save, observe an
intentional failure, reject a forbidden command, retry, and verify the rendered UI.
Automated browser/MCP tests require no model or API key. See the example guide for
clean-clone commands, current-main compatibility, and captured evidence.

## Quick Start

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

This opens a web UI at `http://localhost:6274`. You should see 9 tools, 3 resources, and 3 prompts listed. Click any tool to test it — `list_actors` will return an empty array (no browser connected yet), which confirms the server is running correctly.

## Configuration

| Environment Variable         | Default                                 | Description                                                                    |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `XSTATE_MCP_WS_PORT`         | `7357`                                  | WebSocket server port                                                          |
| `XSTATE_MCP_WS_HOST`         | `127.0.0.1`                             | WebSocket server bind address (localhost only by default)                      |
| `XSTATE_MCP_BUFFER_SIZE`     | `100`                                   | Max events per actor in ring buffer                                            |
| `XSTATE_MCP_LOG_LEVEL`       | `info`                                  | Logging verbosity (`debug`, `info`, `warn`, `error`)                           |
| `XSTATE_MCP_ALLOWED_ORIGINS` | `http://localhost:*,http://127.0.0.1:*` | Comma-separated list of allowed WebSocket origins (supports `*` port wildcard) |
| `XSTATE_MCP_REQUIRE_ORIGIN`  | `false`                                 | When `true`, reject WebSocket connections without an Origin header             |

## Browser Adapter

Your XState 5 app needs to send inspection events to the WebSocket server. Two options:

### Option A: Using `@statelyai/inspect` (recommended)

```typescript
import { createWebSocketInspector } from "@statelyai/inspect";

const inspector = createWebSocketInspector({
  url: "ws://127.0.0.1:7357",
});

const actor = createActor(yourMachine, {
  inspect: inspector.inspect,
});
actor.start();
```

### Option B: Custom adapter (minimal)

```typescript
const ws = new WebSocket("ws://127.0.0.1:7357");

const actor = createActor(yourMachine, {
  inspect: (event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  },
});
actor.start();
```

Both approaches work. Actors register automatically when they start — you'll see them in `list_actors` immediately.

### Enabling `send_event` (bidirectional)

The `send_event` tool sends events from the AI agent to your running actors. This requires the browser to handle incoming messages and respond:

```typescript
const ws = new WebSocket("ws://127.0.0.1:7357");

ws.addEventListener("message", (msg) => {
  const data = JSON.parse(msg.data);

  if (data.type === "xstate-mcp.send") {
    try {
      // Find the actor and send the event
      const actor = getActorBySessionId(data.sessionId); // your lookup logic
      actor.send(data.event);
      ws.send(
        JSON.stringify({
          type: "xstate-mcp.send.response",
          requestId: data.requestId,
          success: true,
        }),
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "xstate-mcp.send.response",
          requestId: data.requestId,
          success: false,
          error: err.message,
        }),
      );
    }
  }
});
```

## Tools

### Discovery & Orientation

#### `list_actors`

What's running right now? Returns all registered actors with their current state, status, and child count.

**Parameters:** none

```json
{
  "actors": [
    {
      "sessionId": "x:0",
      "name": "app",
      "currentState": "ready",
      "status": "active",
      "childCount": 5
    },
    {
      "sessionId": "x:0:agents",
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

**Parameters:** none

```json
{
  "tree": [
    {
      "sessionId": "x:0",
      "name": "app",
      "state": "ready",
      "status": "active",
      "children": [
        {
          "sessionId": "x:0:agents",
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

Drill into one actor — full state value, context, and status.

**Parameters:**

- `sessionId` (string) — actor's session ID from `list_actors`

```json
{
  "sessionId": "x:0:agents",
  "name": "agentsMachine",
  "status": "active",
  "value": "idle",
  "context": { "entities": [], "selectedId": null },
  "parentId": "x:0",
  "updatedAt": "2026-02-28T12:00:01.500Z"
}
```

#### `get_machine_definition`

Full state chart structure — states, transitions, guards, actions, invoked services.

**Parameters:**

- `sessionId` (string)

```json
{
  "sessionId": "x:0:agents",
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

**Parameters:**

- `sessionId` (string)
- `limit` (number, optional, default: 20)

```json
{
  "sessionId": "x:0:agents",
  "events": [
    {
      "event": { "type": "sys.refresh" },
      "sourceId": "x:0",
      "createdAt": "2026-02-28T12:00:01.000Z"
    }
  ],
  "totalInBuffer": 1,
  "bufferCapacity": 100
}
```

#### `get_state_timeline`

State transition history — from/to values, triggering event, and timestamps. Higher level than event history.

**Parameters:**

- `sessionId` (string)
- `limit` (number, optional, default: 50)

```json
{
  "sessionId": "x:0:agents",
  "name": "agentsMachine",
  "currentState": "idle",
  "totalTransitions": 4,
  "transitions": [
    {
      "fromValue": "idle",
      "toValue": "loading",
      "event": "sys.refresh",
      "timestamp": "2026-02-28T12:00:01.000Z"
    },
    {
      "fromValue": "loading",
      "toValue": "idle",
      "event": "xstate.done.actor.0.agents.loading",
      "timestamp": "2026-02-28T12:00:01.500Z"
    }
  ]
}
```

#### `can_handle_event`

Static check: can this actor handle a given event type in its current state? Analyzes the machine definition without executing anything.

**Parameters:**

- `sessionId` (string)
- `eventType` (string) — e.g. `"sys.refresh"`, `"SUBMIT"`

```json
{
  "sessionId": "x:0:agents",
  "canHandle": true,
  "currentState": "idle",
  "matchedTransitions": ["idle.on.sys.refresh"],
  "note": "Guards are not evaluated — transition may still be rejected at runtime"
}
```

### Actions

#### `send_event`

Send an event to a running actor. Target can be a sessionId or actor name. Requires the [browser-side response handler](#enabling-send_event-bidirectional).

**Parameters:**

- `target` (string) — sessionId or actor name
- `event` (object) — must have a `type` field, e.g. `{ "type": "sys.refresh" }`

```json
{
  "sessionId": "x:0:agents",
  "event": { "type": "sys.refresh" },
  "success": true
}
```

Follow up with `get_state_timeline` or `get_actor_state` to verify the transition.

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
list_actors         → see all actors, their states, and statuses
get_actor_tree      → see the parent-child hierarchy
get_actor_state     → drill into one actor for full context
```

### "Can this machine handle what I'm about to send?"

Before triggering an action:

```
can_handle_event(sessionId, "sys.refresh")
→ { canHandle: true, matchedTransitions: ["idle.on.sys.refresh"] }

can_handle_event(sessionId, "NAVIGATE")
→ { canHandle: false, matchedTransitions: [] }
```

Catches event type typos and wrong-target bugs before they happen.

### "Trigger and verify"

```
send_event(target: "x:5", event: { type: "sys.refresh" })
→ { success: true }

get_state_timeline(sessionId: "x:5", limit: 3)
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

MCP resources provide direct access to actor data without tool calls. Clients that support resource subscriptions get real-time updates when actors register, snapshots change, or the store clears.

| Resource           | URI                                     | Description                                         |
| ------------------ | --------------------------------------- | --------------------------------------------------- |
| Actor list         | `xstate://actors`                       | All registered actors with current state and status |
| Actor snapshot     | `xstate://actor/{sessionId}/snapshot`   | Current state snapshot of a specific actor          |
| Machine definition | `xstate://actor/{sessionId}/definition` | Machine JSON definition for a specific actor        |

Template resources support autocomplete — type a partial sessionId or actor name and the server suggests matches.

## Prompts

Pre-built analysis prompts that assemble actor data into structured context for the LLM.

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

Agent uses: list_actors → finds "formMachine" at sessionId "x:3"
Agent uses: get_actor_state("x:3") → state: "validating", context: { errors: ["email"] }
Agent uses: can_handle_event("x:3", "SUBMIT") → canHandle: false

Agent: The form machine is stuck in "validating" because there's an email validation
error in the context. The SUBMIT event can't fire from this state — the machine
needs the validation to pass first. Check the email field validation logic.
```

### "What happened after the user clicked refresh?"

```
User: Something broke after the refresh button was clicked. Trace what happened.

Agent uses: get_state_timeline("x:0:agents", limit: 5) →
  idle → loading → error (event: "xstate.error.actor")

Agent uses: get_event_history("x:0:agents", limit: 10) →
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
                                    McpServer (stdio)  ──────────► 9 tools, 3 resources, 3 prompts
```

- **MCP transport:** stdio (standard for Claude Code MCP servers)
- **WebSocket:** receives the XState inspection stream from the browser; also sends `send_event` commands back
- **Storage:** in-memory only — actors re-register on page load, no persistence across restarts
- **Event history:** ring buffer per actor (bounded, configurable — default 100 events)
- **State timeline:** separate ring buffer tracking state value transitions

## Development

For contributors working on xstate-mcp itself:

```bash
git clone https://github.com/eandualem/xstate-mcp.git
cd xstate-mcp
bun install           # Install dependencies
bun run dev           # Start dev server (tsx watch)
bun run build         # Production build (tsup)
bun run test          # Run tests (vitest)
bun run lint          # ESLint
bun run format        # Prettier
bun run check         # Full quality gate (lint + format + types + test)
```

Requires Node.js 20+.

## Privacy

xstate-mcp runs entirely on your local machine. It does not:

- Send any data to external servers or APIs
- Collect telemetry, analytics, or usage metrics
- Store any data to disk (all state is in-memory and cleared on restart)
- Make any outbound network requests

The WebSocket server binds to `127.0.0.1` by default (localhost only, not reachable from other machines). The MCP transport uses stdio. All data stays between your browser and your AI coding tool.

## License

MIT
