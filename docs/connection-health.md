# Connection health and application capabilities

Start debugging with `get_connection_health`. It reports whether the inspection
listener is available, whether an application has connected, whether registration
arrived, and whether that connection supports `send_event`. It contains no actor
context, events, definitions, URL query strings, request headers or error payloads.

The MCP client communicates with this server over stdio. The application connects
to its separate WebSocket listener. Application protocol version `1` below is an
xstate-mcp adapter contract; it is distinct from the MCP protocol version and the
XState/Stately inspection format version.

## A short doctor workflow

1. Call `get_connection_health` with `{}`. A running CLI should show
   `listener.state: "listening"` and the actual bound `listener.endpoint.url`,
   including the assigned port when a library host requests port zero. A factory
   used only for capability scanning shows `not_started`. `starting` means binding
   is pending, `closed` means the listener stopped, and `error` has a bounded
   `errorCode`, such as `EADDRINUSE`. Choose a free port for that error. If MCP itself
   cannot initialize, inspect the CLI's stderr first; a failed process cannot
   answer a health tool call.
2. If `totals.connectedClients` is `0`, open the development application and check
   its WebSocket URL. `totals.rejectedConnections > 0` records origin-policy
   rejections since this server started. Configure the exact development origin;
   health does not disclose the rejected URL or headers.
3. If there is a connection but its `actorCount` is `0`, inspect
   `counters.acceptedInspectionFrames`, `counters.rejectedFrames` and
   `lastRejection`. No inspection frames usually means the adapter is not wired to
   the actor, or startup events were sent before the socket opened.
   `actor_not_registered` means an event/snapshot arrived without a currently owned
   actor registration; reconnect/replay the registration and latest state.
   `invalid_json`, `invalid_envelope`, `invalid_inspection`, or `missing_session_id`
   indicate framing/serialization problems. Check adapter/server compatibility.
   `@xstate.microstep` is intentionally counted as ignored, not rejected.
4. Before writing, require `negotiation: "negotiated"` and `commands` containing
   `send_event`. `awaiting_hello` means the legacy connection is observation-only;
   `invalid` means its hello failed validation; `incompatible` means the offered
   protocol is unsupported. Send the version-1 hello below. A negotiated adapter
   with `commands: []` is read-only: enable its command handler and reconnect.
5. Call `list_actors`, select the intended session, then `get_actor_state`.
   After `send_event`, verify actual state with `get_actor_state` or the timeline;
   a successful acknowledgement alone does not prove a transition. If a connection
   is `stale`, check the application process/network and reconnect. Re-register
   actors after reconnect or `clear_actors`.

For a runnable sanity check, install this checkout's development dependencies with
`bun install --frozen-lockfile`, configure an MCP client to run the built CLI, and
start the separate application fixture:

```bash
node examples/doctor-app.mjs ws://127.0.0.1:7357
```

Use the endpoint reported by health if you changed the port. Expected tool flow:

```text
get_connection_health({})
  → application.name "doctor-example", actorCount 1,
    protocolVersion 1, commands ["send_event"], freshness "fresh"
list_actors({})
  → doctor in idle; copy its sessionId
send_event({target: "<sessionId>", event: {type: "RUN"}})
  → success true
get_actor_state({sessionId: "<sessionId>"})
  → value "running"
```

Stop the example with Ctrl-C. It waits for negotiation before starting its single
actor and cleans up on disconnect. It is a small development fixture, with no
reconnect/replay or React integration. The complete production-quality development
adapter remains [#13](https://github.com/eandualem/xstate-mcp/issues/13).

## Adapter handshake

After opening the application WebSocket, send:

```json
{
  "type": "xstate-mcp.hello",
  "protocolVersion": 1,
  "application": { "name": "my-frontend" },
  "adapter": { "name": "my-development-adapter", "version": "1.0.0" },
  "capabilities": { "commands": ["send_event"] }
}
```

Use `commands: []` for a read-only inspector. Only advertise a command if its
handler is already installed on this same socket. The server responds:

```json
{
  "type": "xstate-mcp.hello.response",
  "success": true,
  "connectionId": "<server-assigned-UUID>",
  "supportedProtocolVersions": [1],
  "protocolVersion": 1,
  "commands": ["send_event"]
}
```

Unknown command names are ignored when intersecting adapter capabilities with
server capabilities. Unknown metadata fields are discarded. Names are at most
64 characters (letters, digits, `_`, spaces, `.`, `@`, `/`, `-`); adapter versions
are at most 32 characters (letters, digits, `_`, `.`, `+`, `-`). Up to eight command
names of at most 32 characters are accepted. Use non-secret display labels.
Application/adapter names and versions are self-reported, not authenticated
identity or proof of compatibility. The connection UUID belongs to the server;
an application cannot choose it by adding a field to its hello.

A malformed or incompatible hello returns `success: false` with `code` and bounded
remediation. Before the first successful negotiation, that connection cannot
ingest inspection until it sends a valid hello. An already accepted handshake
remains in effect when a later hello is rejected.
A successful hello is fixed for the socket's lifetime. An identical repeat is
idempotent; changing it returns `capabilities_locked`. Reconnect to change capabilities.
`clear_actors` clears routes and actors while preserving the connected socket and
its negotiation. A new socket always has a new identity and needs its own hello.

Legacy inspection connections without a hello can still register/read actors.
**Write compatibility change:** they now fail immediately with
`code: "capability_negotiation_required"`, `success: false` and MCP `isError: true`.
Explicitly read-only adapters return `unsupported_command`. Neither case sends a
wire command nor schedules the five-second acknowledgement timeout. Negotiated
writers that fail to acknowledge can still time out; `commandTimeouts` records
that case. Capabilities express supported operations; they are not an authorization
or user-consent policy. Write policy remains [#15](https://github.com/eandualem/xstate-mcp/issues/15).

## Freshness, counters and limits

The listener sends WebSocket protocol pings every 15 seconds. Browsers and normal
WebSocket clients answer automatically; an application does not send a JSON ping.
Inbound messages, pings and pongs update transport activity. At 45 seconds without
inbound activity, health reports `freshness: "stale"`; it does not delete actors,
automatically reconnect, or declare the application's state invalid. A blocked
server event loop can delay heartbeat processing too.

`lastActivityAt` and `lastInspectionAt` use server receipt timestamps.
`activityAgeMs` and `inspectionAgeMs` use a monotonic clock, so wall-clock changes
cannot make a fresh connection appear stale. An idle actor can have old inspection
data while its transport stays fresh. Invalid frames update transport activity but
never inspection freshness. `sampledAt` marks when the response was assembled;
this polling tool does not emit resource subscriptions.

`limit` is an integer from 1 to 50 (default 50). `connectionId` optionally selects
one live connection. Use `offset` (a nonnegative safe integer, default 0) and
`nextOffset` to page through larger sets; `nextOffset: null` ends the list. Pages
are live samples, so reconnects between calls can change their order.
`omittedConnections` counts matching rows left out of this page; totals
always cover all active sockets. There is one fixed-size metadata record per live
socket, and no disconnected record history. Disconnect removes its identity and
per-connection counters; aggregate counters and `lastDisconnectedAt` remain.
Global connection/payload/retention budgets are separate work in
[#11](https://github.com/eandualem/xstate-mcp/issues/11).

Counters saturate at 2,147,483,647 instead of growing without bound. They are
cumulative since the registry was constructed (per-connection counters start at
connect), and `clear_actors` does not reset them. `rejectedFrames` excludes ignored
microsteps and transport errors, which have separate counters. Valid hello/ACK
messages count as received frames, not inspection frames. `lastRejection` stores
only an enum and timestamp, so old rejection counters may remain after recovery.
Do not treat a nonzero historical count as proof of a current failure.
