# Application sessions and actor identity

Each application WebSocket connection gets a server-generated `connectionId`.
An actor's public `sessionId` combines that connection with its local XState
session ID. Two tabs can both register `x:0` and `x:1`; all four actors remain
separately addressable, even when their names and machine definitions match.

The namespace belongs to one connection, which normally represents one browser
tab or application runtime. Multiple actor systems sharing that socket must
already have distinct local IDs. Do not multiplex independent runtimes with
colliding IDs over one socket.

## Choosing an application

An adapter may supply a descriptive label in the WebSocket URL:

```typescript
const url = new URL("ws://127.0.0.1:7357");
url.searchParams.set("applicationName", "Checkout — tab A");
const ws = new WebSocket(url);
```

This also works as the `url` passed to an inspector. The label is trimmed and
limited to 128 JavaScript string characters. It may be absent or duplicated;
it does not establish ownership, authentication, or reconnect identity.

1. Call `list_actors` to see `applicationName`, `connectionId`, `localSessionId`,
   actor name, and current state. `xstate://actors` exposes the same identity fields.
2. Use the label, root actor names, and application context to select a connection.
   If tabs are otherwise indistinguishable, give them different labels.
3. Pass that `connectionId` to `list_actors` or `get_actor_tree` to focus discovery.
   `list_actors` also accepts a `status` filter; both filters apply together.
4. Copy the exact returned `sessionId` into actor tools, prompts, and resource URIs.
   Treat it as opaque: do not construct, decode, persist, or substitute local IDs.
5. For `send_event`, prefer the exact `sessionId`. Actor names work only when
   unique across all connections. Ambiguous-name errors include the matching
   connection identities so the agent can select the intended actor.

A filtered discovery call does not change subsequent tool scope. Every actor
request still carries its explicit `sessionId`. `clear_actors` remains global
and clears all applications.

## Identifier migration

Previously, MCP exposed local IDs such as `x:0` directly. MCP callers must now
rediscover actors and use their scoped `sessionId`, including in saved resource
URIs and prompt arguments. There is no local-ID alias: it would become ambiguous
as soon as another application connected.

Discovery results, tree nodes, current-state results, and actor resources expose:

- `sessionId`: the opaque identifier to pass to MCP.
- `localSessionId`: the actor's original identifier in the application runtime.
- `connectionId`: the server-assigned namespace for that live connection.
- `applicationName`: optional descriptive label, or `null`.

`parentId`, `rootId`, and event-history `sourceId` are scoped to the same
connection, including references to actors not yet registered. A reference cannot
link to another application's actor, even if its supplied string looks like a
public ID. Arbitrary context, definition, and event payloads remain application
data; embedded actor references in those payloads are not rewritten.

Application-side messages keep using **local** IDs. The server scopes incoming
inspection identifiers, then translates `send_event` back to the original local
ID in the outgoing `xstate-mcp.send.sessionId`. Existing command handlers can
continue looking up actors by their local ID. MCP's tool result contains the
scoped ID, while `requestId` is carried unchanged in the acknowledgement.
The inspection stream and acknowledgement handler must use the **same socket**.

Native adapters must preserve `actorRef.sessionId` and `sourceRef.sessionId`
before serializing; native `Actor.toJSON()` can retain only the actor's name.
Forward local hierarchy metadata as well. Namespace isolation cannot recover
identity or parent information an adapter has already discarded. A complete
first-party adapter is tracked in [#13](https://github.com/eandualem/xstate-mcp/issues/13).

Code that directly constructs `ActorStore` records without a WebSocket may leave
connection metadata absent. Those records report `connectionId: null` and use
the provided ID as `localSessionId`; they have no command route until registered
through a `ClientRegistry`. This is an internal factory/test convention, not a
wire-protocol compatibility mode.

## Ownership and lifetime

Registration establishes ownership inside the sender's namespace. Snapshots and
events are accepted only for an actor registered on that socket. A supplied
`connectionId` cannot claim another connection. Repeated registration of the
same local ID on the same socket is ignored, preserving the existing snapshot,
definition, and history. Send snapshot messages for subsequent state updates.

Every pending command retains its original socket and actor binding. Only a
validated response on that socket can settle it. Wrong-socket acknowledgements,
unknown request IDs, duplicates, and late responses are ignored. Acknowledgement
still means dispatch was reported by the application; inspect runtime state to
verify the outcome.

Disconnecting removes only that connection's actors and fails only its pending
commands. A reconnect always creates a **new** connection and new public actor
IDs, even when the label and local IDs are unchanged. Old and new sockets may
overlap without taking over each other's actors. There is no ownership migration,
automatic request retry, or continuity of history across connections. Adapters
must replay registrations and current snapshots after reconnecting; agents must
rediscover IDs.

Clearing the store fails pending commands and drops actor ownership mappings.
Live sockets keep their connection IDs but must register actors again before
updates or commands work. Old acknowledgements cannot settle new requests after
re-registration. Closing a WebSocket server releases its store-clear listener.

These checks isolate connected applications; they are not an authentication
protocol. The existing loopback binding and origin policy still govern which
applications may connect.

## Verification

`tests/application-sessions-mcp.test.ts` runs independent processes with real
XState 5.28.0 root and child actors, real loopback WebSockets, and an MCP client.
Each process naturally starts with the same local session counter. Coverage
includes discovery and connection filters, hierarchy, all actor tools, resource
reads/completion, prompts, command routing, foreign mutations and responses,
overlapping reconnects, duplicate registration, clear/re-registration, and
operation without an externally supplied command registry. Ping/pong and MCP
round trips order observations without arbitrary sleeps.

The subprocess adapter in `tests/fixtures/session-application.ts` deliberately
extracts hierarchy and machine metadata for these fixtures. It is not the
first-party browser adapter or a claim of full Stately producer compatibility.
The producer-format work is tracked separately in
[#1](https://github.com/eandualem/xstate-mcp/issues/1).
