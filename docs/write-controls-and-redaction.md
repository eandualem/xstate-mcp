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
the **same** rule. `actor` matches an exact resolved session ID; `events` contains
exact event types. Matching is case-sensitive. A whole string `"*"` explicitly
allows every actor or event; `"user.*"` is a literal, not a pattern. Actor names
cannot bypass a session rule. Empty or omitted rules deny all writes, even when
read-only is false. Read-only true overrides every rule.

Direct hosts configure the same boundary:

```typescript
const registry = new ClientRegistry(5000, logger, {
  writePolicy: {
    readOnly: false,
    allow: [{ actor: "x:1", events: ["NEXT"] }],
  },
});
const store = new ActorStore(100, logger, {
  keys: ["email"],
  paths: [["customer", "address"]],
});
```

These are constructor examples for hosts using the source modules. The package
root still has the historical CLI startup behavior on this branch; importable
server factories are tracked in #5 / PR #26. Import only the dedicated policy
subpath from applications.

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
`dispatch_failed`. Unknown or malformed codes are withheld, as are codes attached
to successful ACKs. The generic application rejection message remains available.

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
restrict anything the server allows.

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
sanitized state values and event types. All existing read tools, resource
contents/listings, prompts and histories use that store, including both tool text
and structured results. An
application-side filter prevents transfer to the server; an additional server
filter prevents retained data from reaching MCP clients. `excludeContext` and
`contextMaxChars` remain presentation options, not privacy controls.

Serialization recursively copies plain objects and arrays without calling getters
or `toJSON`. It supports bigint as strings; cycles, functions, accessors and
non-plain instances (including native Error objects) become `[OMITTED]`. Project
Error fields explicitly, then redact their sensitive properties or whole error
field. Stringified `definition` objects are parsed before redaction; invalid
serialized definitions are omitted. Traversal has a depth limit of 64 and a
10,000-value budget per call. Oversized containers are omitted. This limits
traversal work; it is not a total byte or retained-memory budget (#11).

Redacted fields can affect static analysis and hide transitions caused only by
sensitive data changes. Use non-sensitive state/event names and protocol IDs;
the routing session IDs, timestamps, resource URIs and client-supplied lookup
arguments are protocol metadata, not secret-bearing payload fields. Do not
configure rules that remove required transport identifiers in an application
envelope. Retained event
`sourceId` metadata can be hidden with an explicit key or path rule without
changing actor routing. The in-process store is trusted host state; hosts must not
mutate its records with raw data.

This is a key/path filter, not a secret detector. It does not scan arbitrary text,
encoded strings, property names or JSON embedded in other string fields. A password
copied into `context.message` needs an explicit rule for that field. Redact entire
context/output/error subtrees when their contents are uncertain. Keep domain
policies in the application, where you know what data is sensitive.

The server does not persist inspection data or upload it. MCP clients receive tool,
resource and prompt contents over stdio and **may forward them to their configured
model provider or retain them in logs/conversation history**. Server redaction
cannot retract earlier client data, or hide sensitive commands the client itself
supplied. Review the coding client's data handling separately.

## Run the development example

Build the checkout with `bun install --frozen-lockfile` and `bun run build`. Point
your MCP client at `node /absolute/path/to/checkout/dist/index.js`. Set the server
write environment shown above (or leave defaults to verify rejection).

In another terminal in the checkout:

```bash
NODE_ENV=development node examples/policy-app.mjs
```

The example stays inactive without `NODE_ENV=development`. It forwards a real
XState actor through the guard, with a redacted password and email. Through MCP:

1. Call `list_actors`, then `get_actor_state` for the discovered session ID.
2. Call `send_event` targeting `policy-demo` with `{ "type": "NEXT" }`.
3. Read the snapshot and verify `ready` and `count: 1`.
4. Try `RESET`: the adapter denies it even if the server explicitly allows it.

A successful ACK means the adapter accepted dispatch. An ignored event can be
acknowledged without changing state; async work can still fail later. Verify the
subsequent snapshot/history and, for frontend development, the rendered UI.

The executable example is a single-actor development fixture. Full adapter
reconnect/replay, child actors and capability negotiation are tracked in #13/#14;
this branch starts from main and does not incorporate those unmerged changes.

## Diagnostic export boundary and integration

`serializeRedacted(value, redactionOptions)` is the same browser-safe serializer
for a manually constructed diagnostic object. It returns JSON without writing or
uploading anything. The protocol test writes a temporary trace-shaped fixture,
reads it back and verifies that secrets are absent alongside actual MCP tool,
resource, prompt and history results. There is **no exported-trace MCP tool yet**;
the versioned cross-actor trace API, causal ordering and export metadata remain #16.
Use the shared serializer and sanitized store when implementing that issue.

When integrating the other main-based PRs:

- #25: server allow rules match resolved public scoped IDs; adapter rules match
  original local IDs. Preserve socket ownership checks independently of policy.
- #31: combine capability negotiation and write authorization. A successful hello
  cannot enable a denied write. Reconcile the `ClientRegistry` constructor options,
  and make the example negotiate before dispatch.
- #22/#24: sanitize error/output/lifecycle data before retention and preserve
  sanitized wait results. State predicates will observe sanitized data.
- #26/#30: propagate options through the managed factory/CLI, preserve the policy
  subpath when combining exports/build entries, and explicitly enable only the
  commands needed by release consumer fixtures. #27 updates the shared lockfile
  and runtime matrix. Contract CI integration remains #7.
