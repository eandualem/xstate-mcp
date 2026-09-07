# Live producer fixtures

## Stately inspection contract fixture

`stately-machine.ts` defines a root machine with an invoked worker. The root
forwards PING to the worker, which enters working and increments its context.

The live contract test in `../stately-inspector.test.ts` runs this fixture with
**XState 5.32.6** and **@statelyai/inspect 0.7.2**, pinned as exact development
dependencies in package.json and resolved by bun.lock. The packages generate the
actual WebSocket messages; the test does not rewrite IDs, timestamps, snapshots,
definitions, or parent/source relationships before the server receives them.

The observer verifies nullable message IDs, epoch-millisecond timestamp strings,
and the producer version on all three message types. MCP assertions cover the
root and child definitions, hierarchy, state/context, source actor, and timeline.
The existing normalization tests additionally cover optional native metadata,
absent timestamps, UTC and offset ISO timestamps, epoch boundaries, and invalid
dates. Schema tests ensure nullable message IDs do not permit invalid actor IDs.

When changing producer versions, update the exact dependency pins and this
record, then run the live contract test before making new compatibility claims.

## Application session fixture

`session-application.ts` starts an actual XState 5.32.6 machine with an invoked
child actor in a separate Node.js process. Each process has its own native local
session counter (`x:0` root, `x:1` child), reproducing independent browser tabs
without renaming actor IDs in test data.

The fixture forwards native inspection events over a real WebSocket. It captures
local session IDs before JSON serialization and extracts `_parent` and
`logic.config` for hierarchy and definitions. Those internal fields are used
only for this pinned test producer, not as a supported adapter API. Commands
look up real actor references by their original local session IDs.

IPC lets the test hold acknowledgements, inject foreign/stale frames, replay
registrations, and observe received commands. WebSocket ping/pong provides an
ingestion barrier. The test owns and terminates every subprocess and socket.
