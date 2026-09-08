# Application write controls and inspection redaction

`send_event` can trigger application actions, service calls, and deletion. Application
writes are disabled by default. Configure both the server and your development
adapter before deliberately enabling a command.

These controls and the `xstate-mcp/inspection-policy` export are changes in this
checkout. They are not available in the historical npm releases.

## Server policy

The CLI reads these settings at startup:

- `XSTATE_MCP_READ_ONLY`: `true` (default) or `false`, exactly.
- `XSTATE_MCP_WRITE_ALLOW`: JSON array of paired rules, default `[]`.
- `XSTATE_MCP_REDACTION`: JSON object with additional `keys` and/or `paths`, default `{}`.

For example, configure your MCP client's server environment with:

```json
{
  "XSTATE_MCP_READ_ONLY": "false",
  "XSTATE_MCP_WRITE_ALLOW": "[{\"actor\":\"*\",\"events\":[\"NEXT\"]}]",
  "XSTATE_MCP_REDACTION": "{\"keys\":[\"email\"],\"paths\":[[\"customer\",\"address\"]]}"
}
```

Every send is checked after target name resolution, inside `ClientRegistry`, before
creating a pending request or sending a WebSocket frame. An actor/event must match
the **same** rule. `actor` matches an exact resolved public session ID from `list_actors`; `events` contains
exact event types. Matching is case-sensitive. A whole string `"*"` explicitly
allows every actor or event; `"user.*"` is a literal, not a pattern. Actor names
cannot bypass a session rule. Empty or omitted rules deny all writes, even when
read-only is false. Read-only true overrides every rule.

Direct hosts configure the same boundary through the importable factory:

```typescript
import { createInspectionServer } from "xstate-mcp";

const bridge = createInspectionServer({
  writePolicy: {
    readOnly: false,
    allow: [{ actor: "*", events: ["NEXT"] }],
  },
  redaction: {
    keys: ["email"],
    paths: [["customer", "address"]],
  },
});
```

The root import and factory are idle until `bridge.start(transport)`; see
[server lifecycle](server-lifecycle.md). Lower-level hosts can pass
`{ health?, writePolicy? }` as `ClientRegistry`'s third argument and redaction
options as `ActorStore`'s third argument. The dedicated policy subpath is browser-safe.

Rules are validated and copied at construction; mutating the original options
cannot broaden access. There are at most 100 rules, with at most 100 event types
per rule, 1024 characters per actor target and 256 per event type. Invalid config
fails startup without printing its contents. Restart to change policy.

`send_event` returns `isError: true` and a stable `code` for server policy rejection:
`read_only`, `write_not_allowed`, or `invalid_event`. Allowed commands keep their
original payload: redaction changes inspection and returned data, not the event
executed by the application. The echoed tool payload is redacted on success and
failure. Free-form application ACK error details and send errors are withheld
because they may contain application data. Rejected adapter ACKs preserve the
guard's fixed codes: `read_only`, `write_not_allowed`, `invalid_event`,
`instrumentation_disabled`, `invalid_command`, `actor_not_found`, and
`dispatch_failed`. Unknown valid codes are withheld, as are codes attached to successful ACKs.
On the wire, an optional `code` must be a non-empty string of at most 128
characters. A malformed code rejects the complete ACK without settling the
pending command; validation runs before the fixed-code allowlist. Valid rejected
ACKs retain a generic application rejection message.

`clear_actors` remains available in application read-only mode. It discards the
debugger's retained data, routes and pending requests; it does not stop application
actors or undo commands already sent. Its annotations remain destructive,
non-read-only, idempotent, and closed-world. `send_event` is annotated potentially
destructive, non-idempotent and open-world. These are descriptive
[MCP hints](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations);
the dispatch checks enforce the policy.

## Application boundary

```typescript
import { createInspectionGuard } from "xstate-mcp/inspection-policy";

const guard = createInspectionGuard({
  enabled: import.meta.env.DEV, // Vite example; use your build system's dev flag
  writePolicy: {
    readOnly: false,
    allow: [{ actor: "*", events: ["NEXT"] }],
  },
  redaction: { keys: ["email"], paths: [["customer", "address"]] },
});
```

The helper defaults to disabled and read-only. It has no Node dependencies or
network side effects. Only open your inspection WebSocket when `guard.enabled`
is true. Serialize **before** sending and skip envelopes rejected by the guard:

```typescript
const serialized = guard.serializeInspection(preparedEnvelope);
if (serialized !== null) ws.send(serialized);
```

The serializer returns redacted JSON, or `null` when disabled, when the inspection
type is unsupported, or when the top-level `sessionId` is missing, invalid,
redacted, or omitted. Do not send the original envelope alongside the sanitized
one, or attach a second unfiltered inspector.

Prepare explicit plain data from native XState inspection events. Project actor
references to IDs and snapshots to status/value/context/output/error data as
appropriate. Do not stringify live actor objects. XState describes the native
[event shapes here](https://stately.ai/docs/inspection). The guard is a policy
and serialization boundary, not a complete reconnecting multi-actor adapter.

On each parsed `xstate-mcp.send`, look up the actual locally registered actor and
call `guard.dispatch(actor, command)`. It validates the command, checks that the
actor's actual session ID equals the command target, applies its own actor/event
rules and only then calls `actor.send`. Return its result in the ACK. Adapter
rules use local session IDs. Keep this check adjacent to dispatch; advertising
command support alone is not permission. The application policy can further
restrict anything the server allows. First negotiate protocol version 1 and
`send_event` on this same socket, as described in the [handshake guide](connection-health.md).
A successful hello never overrides server or adapter write policy. Missing command
negotiation returns `capability_negotiation_required`; a negotiated adapter without
command support returns `unsupported_command`, after server policy permits the request.

The helper does not infer a production environment from a browser global. Omit
`enabled` unless you explicitly pass a development build flag. Production code
should exclude the inspection connection setup entirely.

## Redaction contract

Default keys are `password`, `passwd`, `secret`, `token`, `accessToken`,
`refreshToken`, `apiKey`, `authorization`, `cookie`, `setCookie`, `privateKey`, and
`clientSecret`. Additional keys extend these defaults. Keys match at any depth,
ignoring case, underscores and hyphens. Values become `[REDACTED]`.

Paths are arrays of literal segments, matched as suffixes at any depth. For
example, `["customer", "address"]` covers that field inside snapshot context,
event payloads, definitions and diagnostic wrappers. `["items", "*", "note"]`
matches one segment for each `*`, including array indices. Dots inside a segment
are literal; paths are case-sensitive. At most 100 keys (128 characters each)
and 100 paths (1–16 segments, 128 characters per segment) are accepted.

The server sanitizes and copies actor names, definitions, snapshots, event
payloads and event source IDs **before retention**. Timeline entries derive from
sanitized state values, context, status, output, errors and event types. All existing read tools, resource
contents/listings, prompts and histories use that store, including both tool text
and structured results. Bounded state/event waits and store observers see only
sanitized snapshots and events, with lifecycle status and observation cursors
preserved. A state predicate must match the sanitized state value. An
application-side filter prevents transfer to the server; an additional server
filter prevents retained data from reaching MCP clients. `excludeContext` and
`contextMaxChars` remain presentation options, not privacy controls.

Serialization recursively copies plain objects and arrays without calling getters
or `toJSON`. It supports bigint as strings; cycles, functions, accessors and
non-plain instances (including native Error objects) become `[OMITTED]`. Project
Error fields explicitly, then redact their sensitive properties or whole error
field. For direct library hosts, the actor store preserves the supported native
Error `message`, `name`, and `code` fields using bounded inert property descriptors
before applying the same snapshot redaction; getters, stacks, causes and arbitrary
Error properties are not retained. Stringified `definition` objects are parsed before redaction; invalid
serialized definitions are omitted. Traversal has a depth limit of 64 and a
10,000-value budget per call. Oversized containers are omitted. This limits
traversal work; it is not a total byte or retained-memory budget (#11).

Redacted fields can affect static analysis and hide transitions caused only by
sensitive data changes. Use non-sensitive state/event names and protocol IDs;
the routing session IDs, timestamps, resource URIs and client-supplied lookup
arguments are protocol metadata, not secret-bearing payload fields. Do not
configure rules that remove required transport identifiers in an application
envelope. Retained event
`sourceId` is first scoped to the public connection namespace, then can be hidden
with an explicit key or path rule without changing actor routing. URL application
labels and negotiated application/adapter labels are separate identity/health
metadata; this payload filter does not filter those labels. Use non-secret labels
and track broader metadata filtering in #35. The in-process store is trusted host state; hosts must not
mutate its records with raw data.

This is a key/path filter, not a secret detector. It does not scan arbitrary text,
encoded strings, property names or JSON embedded in other string fields. A password
copied into `context.message` needs an explicit rule for that field. XState promise
rejections can repeat the message in `snapshot.error.message` and
`event.data.message`; configure both paths (or a `message` key rule) when either
may contain sensitive text. Redact entire
context/output/error subtrees when their contents are uncertain. Keep domain
policies in the application, where you know what data is sensitive.

The server does not persist inspection data or upload it. MCP clients receive tool,
resource and prompt contents over stdio and **may forward them to their configured
model provider or retain them in logs/conversation history**. Server redaction
cannot retract earlier client data, or hide sensitive commands the client itself
supplied. Review the coding client's data handling separately.

## Run the development example

Build the checkout with `bun install --frozen-lockfile` and `bun run build`. Point
your MCP client at `node /absolute/path/to/checkout/dist/cli.js`. Set the server
write environment shown above (or leave defaults to verify rejection).

In another terminal in the checkout:

```bash
NODE_ENV=development node examples/policy-app.mjs
```

The example stays inactive without `NODE_ENV=development`. It forwards a real
XState actor through the guard, with a redacted password and email. Through MCP:

1. Call `list_actors`, then `get_actor_state` for the discovered session ID.
2. Call `send_event` targeting `policy-demo` with `{ "type": "NEXT" }`.
3. Use `wait_for_state` with `state: "ready"`, then read the snapshot and verify `count: 1`.
4. Try `RESET`: the adapter denies it even if the server explicitly allows it.

A successful ACK means the adapter accepted dispatch. An ignored event can be
acknowledged without changing state; async work can still fail later. Verify the
subsequent snapshot/history and, for frontend development, the rendered UI.

The executable example is a single-actor development fixture. It negotiates
command support before starting its actor and applies separate local dispatch
policy. Full adapter reconnect/replay and child actors remain #13.

## Diagnostic export boundary and integration

`serializeRedacted(value, redactionOptions)` is the same browser-safe serializer
for a manually constructed diagnostic object. It returns JSON without writing or
uploading anything. The protocol test writes a temporary trace-shaped fixture,
reads it back and verifies that secrets are absent alongside actual MCP tool,
resource, prompt and history results. There is **no exported-trace MCP tool yet**;
the versioned cross-actor trace API, causal ordering and export metadata remain #16.
Use the shared serializer and sanitized store when implementing that issue.

The factory, connection identity, negotiation, lifecycle and bounded-wait contracts
above are integrated in this checkout. Release consumers must independently opt
into the commands they exercise and negotiate before dispatch. Contract CI remains
#7; a general reconnecting application adapter remains #13.
