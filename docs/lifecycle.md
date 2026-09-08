# Actor lifecycle diagnostics

`get_actor_state` and `xstate://actor/{sessionId}/snapshot` expose the same
snapshot fields: `sessionId`, `localSessionId`, `connectionId`, `applicationName`,
`name`, `status`, `value`, `context`, `output`, `error`, `parentId`, and `updatedAt`.
All three analysis prompts include output and error alongside status.
The tool's context exclusion/truncation options
affect only its context field; the resource returns the full context.

`output` is the received completion value. Falsy values such as `0`, `false`,
and `""` are preserved. An absent output is presented as `null`, as is an
explicit null output. Promise and callback actors can have no state value;
`value: null` alone does not indicate a problem. Callback actors do not produce
completion outputs. See [XState actor capabilities](https://stately.ai/docs/actors).

The stored `error` is a diagnostic summary with a required `message`, optional
`name`, and optional string or finite-number `code`. Message text is capped at
4096 characters; name and string code at 256. Stack, cause, and arbitrary error
properties are omitted. String, number, and boolean rejections become messages.
An error object without a usable message produces `"Error details unavailable"`;
an absent or null error is presented as `null`. This field selection does not
redact secrets embedded in a message, output, context, or raw event history.

For partial snapshots, omitted `value`, `context`, and `status` retain their
previous values. Explicit `null` clears value or context. Output and error belong
to the incoming snapshot: omission clears the previous result. No error or output
is inferred from status alone.

## Timeline entries

`get_state_timeline` retains its `transitions` array and `totalTransitions` count
for compatibility. They now include all observed snapshot changes:

- `type: "state"`: the state value changed.
- `type: "lifecycle"`: status, output, or error changed without a state value change.
- `type: "context"`: only context changed.

Each entry includes `changes`, listing every changed field (`value`, `context`,
`status`, `output`, `error`), and `fromStatus`/`toStatus` alongside the existing
`fromValue`, `toValue`, `event`, and `timestamp`. If state and status change
together, the type is `state` and `changes` includes both. A context-only update
does not claim that a state-machine transition occurred. Duplicate snapshots do
not add entries. An initial snapshot after registration without a snapshot has
`fromStatus: null`.

Entries retain the resulting output and sanitized error when present, so a later
snapshot does not erase earlier completion/failure evidence. Context contents are
not copied into history. The per-actor ring buffer still bounds entry count;
`totalTransitions` counts all entries recorded, including evicted entries.
Filtering `type: "state"` gives state-value changes within the retained window.
Byte budgets for general payloads are separate work in [#11](https://github.com/eandualem/xstate-mcp/issues/11).

## Adapter requirements and verified limits

The server can preserve only data it receives. Plain `JSON.stringify(new Error(...))`
loses non-enumerable properties such as message and name. An adapter must copy
those fields before serializing inspection snapshots, for example using a JSON
replacer that maps an `Error` to `{ name: value.name, message: value.message }`.
Receiving `{}` cannot recover the original message. The installed
`@statelyai/inspect@0.7.2` snapshot converter also loses native Error properties;
its wire compatibility fix in [#21](https://github.com/eandualem/xstate-mcp/pull/21)
does not restore those properties.

With XState 5.28.0, promise rejection and explicit stop produce snapshot inspection
events. A synchronous callback exception, during startup or an event handler,
does not. A complete adapter must capture `actor.getSnapshot()` from an actor
error observer and forward it as a snapshot update. Native actor reference JSON
also omits `sessionId`, so an adapter must preserve that routing metadata.
Complete adapter behavior is tracked in [#13](https://github.com/eandualem/xstate-mcp/issues/13).

The [live contract tests](../tests/actor-lifecycle-mcp.test.ts) use exact dev
dependency `xstate@5.32.6`, a loopback WebSocket, and an MCP SDK client.
They discover public actor IDs through `list_actors` before querying lifecycle data.
The [test forwarder](../tests/fixtures/native-inspection.ts) preserves session IDs
and Error fields without rewriting state, context, status, or output. Its callback
error observer samples a real failed callback snapshot. It is test infrastructure,
not a shipped reconnecting adapter or a Stately Inspector compatibility test.
The cases cover promise and machine output, rejected invocation on child and
parent, callback failure, callback/machine stop, and a transition actor resetting
context to null with no state value.
