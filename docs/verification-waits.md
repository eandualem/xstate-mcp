# Verify observed state and events

`wait_for_state` and `wait_for_event` observe the inspection stream. They do not
send events, replay actions, evaluate guards, or run a model. A send acknowledgement
confirms the adapter's reply; a wait confirms the requested observation.

## State and status

`wait_for_state` takes a `sessionId` and at least one of:

- `state`: an exact string or nested object for compound/parallel states.
  Object key order does not matter. It is not a partial match, dot-path expression,
  wildcard, or executable predicate.
- `status`: `active`, `done`, `error`, or `stopped`. This also works for promise
  actors without a state value.

Both predicates must match when provided. Without `after`, the current snapshot
can match immediately. With `after`, only a newer observed snapshot can match.
The tool checks the current and future snapshots; it does not reconstruct
intermediate snapshots replaced before the call began. For a transient state,
begin waiting before triggering the action.

Predicates allow at most 32 levels (root counts as one), 1024 nodes, and 1024
characters per key/string. Objects must contain strings or nested objects. These
bounds limit comparison work in inspection callbacks.

## Events and cursors

`wait_for_event` takes a `sessionId` and exact `eventType`. Without `after`, only
future events match. With `after`, it first searches retained events newer than
the cursor, then watches new events. It returns the first match. If any events
after the baseline were evicted, it returns `history_lost` rather than claiming
incomplete history proves absence or that a retained match was the first one.

An event observation does not prove it was handled or caused a transition.
Verify the resulting state/status and check the frontend separately.

`get_actor_state`, `get_event_history`, and snapshot resources expose a cursor:

```json
{
  "generation": "5d2727b8-c095-4b22-946e-464b5e3f7f64",
  "snapshot": 3,
  "event": 5
}
```

These are server observation counts, not application timestamps. Each registration
gets a new generation, including re-registration of the same session ID. A cursor
from another registration, or with future counts, returns `invalid_cursor`.
Event records include a `sequence` matching the event counter. The cursor returned
by an event match points to that event, so the next event wait does not skip later
retained events. Its snapshot counter describes the current snapshot when the
result is assembled.

## Observe, act, verify

1. Read `get_actor_state(sessionId)` and save its cursor.
2. Call `send_event` once, or trigger the UI action.
3. Call `wait_for_state` with the expected state/status and the saved cursor.
4. Check `outcome`, inspect the matched snapshot, and verify the UI.

For an application that handles `LOAD` and reaches `ready`, step 3 uses this MCP
request (substitute the actual session ID and cursor from step 1):

```json
{
  "name": "wait_for_state",
  "arguments": {
    "sessionId": "x:0",
    "state": "ready",
    "after": {
      "generation": "5d2727b8-c095-4b22-946e-464b5e3f7f64",
      "snapshot": 3,
      "event": 5
    },
    "timeoutMs": 5000
  }
}
```

For event verification, use the same baseline with `wait_for_event` and
`eventType: "LOAD"`. Both tools use inspection notifications rather than polling
or arbitrary sleeps. The [real actor tests](../tests/wait-tools-mcp.test.ts)
provide complete asynchronous load → success/failure examples over WebSocket
and MCP, including checks that waiting does not repeat sends, guards, or actions.

## Limits and outcomes

`timeoutMs` defaults to 5000 and accepts integers from 0 through 30000. Zero
performs one check. Each MCP server instance permits 100 pending waits; immediate
checks occupy no slot. The manager uses one store subscription and at most one
timer and abort listener per pending wait. Every terminal outcome frees that
wait's slot, timer, and abort listener.

Results include `sessionId`, `outcome`, `startedAt`, `completedAt`, `elapsedMs`,
and a cursor when the actor is known. Elapsed time uses a monotonic clock.
`matched` also includes the matched `snapshot` or `event`. Other outcomes set
the MCP tool's `isError` flag:

- `timeout`: no eligible match was observed by the deadline.
- `disconnected`: the application's owning WebSocket disconnected.
- `actor_removed`, `actor_replaced`, `cleared`: actor/store lifecycle ended the wait.
- `actor_not_found`, `invalid_cursor`, `history_lost`: inspect current data and
  establish an appropriate new baseline before retrying.
- `capacity_exceeded`: all pending slots are occupied.
- `invalid_input`: a predicate or argument is invalid. MCP schema validation may
  reject invalid arguments before the tool runs.

Cancellation follows [MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).
The internal wait settles as `cancelled` and frees its resources. The SDK
suppresses the response; the caller sees cancellation. A closed MCP transport
cannot deliver a structured result. Explicit server shutdown settles internal
waits as `shutdown` and removes store subscriptions, including when closed before
connecting. Use a fresh server instance for a new transport after closure.

## Integration dependencies

Waits reflect data accepted by ActorStore. Cross-application socket ownership
remains [#3](https://github.com/eandualem/xstate-mcp/issues/3); complete output/error
preservation is [#10 / PR #22](https://github.com/eandualem/xstate-mcp/pull/22).
Merge those fixes before relying on multiple applications and full failure
diagnostics. Disposable internal observation/notification callbacks provide wait
cleanup here; the resource subscription protocol remains
[#4](https://github.com/eandualem/xstate-mcp/issues/4). General retained-byte and
response budgets remain [#11](https://github.com/eandualem/xstate-mcp/issues/11).
