# Runtime and dependency support

This source revision supports Node.js **22.23.2+ in 22.x** and **24.20.0+ in
24.x**. `package.json` declares the same ranges; the build targets `node22` and
uses Node 22 type definitions. The default contributor runtime is **24.20.0**
from `.node-version`. This policy describes source/CI, not an already published
npm release.

As of 2026-09-07, Node 22 is in maintenance LTS until 2027-04-30 and Node 24 is in
active LTS, with end of life on 2028-04-30. Node 20 reached end of life on
2026-04-30. Node 26 is currently outside the support matrix; evaluate it after
its scheduled LTS transition on 2026-10-28. See the
[official Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
Dropping Node 20 and restricting major versions is an intentional compatibility
change to call out in the next release.

## Reproducible contribution

Install Node with your preferred version manager and Bun **1.4.2**, pinned in
both `packageManager` and `.bun-version`. No global agent configuration is
required. Bun manages dependencies; Node runs the server and test processes.

```sh
node --version
bun --version
bun install --frozen-lockfile
bun run check
bun run build
bun run audit:check
```

The GitHub Actions matrix runs those gates on Linux with Node **22.23.2** and
**24.20.0**. Each job executes the built CLI with its selected Node and uses an
MCP SDK client over stdio plus a real loopback WebSocket. The compatibility suite
exercises XState **5.28.0** and **5.32.6**, including command success/failure,
state/history queries, resources, prompts, input validation and protocol-only
stdout. A bounded fragmentation probe checks the patched WebSocket receive
limit. This is a runtime/dependency gate; it does not establish compatibility
with every XState version, adapter, operating system or agent application.

`bun run test -- tests/runtime-compatibility.test.ts` runs just those checks and
builds the CLI first. They discover the executable from `package.json` so an
entry-point split can retain the same tests.

## Updating the matrix or dependencies

1. Check the Node release schedule and current security releases. Update the
   engine floors, `.node-version`, build target/types as needed, workflow matrix
   and this policy together. Test both supported major versions before dropping
   or adding a line.
2. Change dependency ranges deliberately, resolve with the pinned Bun, then
   commit `package.json` and `bun.lock` together. Use `bun install
--frozen-lockfile` for subsequent verification. Update `.bun-version` and
   `packageManager` together when changing Bun. Avoid a second lockfile.
3. Run all gates above on each supported Node version. Inspect major-version
   migration notes and exercise the real protocol suite, not only unit mocks.
4. Record a dated `bun audit --json`, exact resolved versions (`bun pm ls`,
   `bun why <package>`), dependency paths, reachability and mitigation for each
   remaining advisory. The reviewed graph is in `bun.lock`; a clean audit is
   evidence about known advisories on that date, not a guarantee of safety.
5. Remove the narrowly scoped esbuild audit exception once its owning build
   dependency supports a patched version. Review it again by **2026-10-07** or
   before changing build/test server behavior, whichever comes first.

TypeScript stays on **5.9.3** (`~5.9.3`): the current tsup declaration worker
injects `baseUrl`, which makes TypeScript 6 fail with TS5101. TypeScript 7 is also
outside the current [typescript-eslint supported range](https://typescript-eslint.io/users/dependency-versions/).
Revisit the compiler together with the build tool instead of suppressing
compiler diagnostics. Vite is explicit because Vitest 5 requires it as a peer.

The SDK and application use a single Zod **4.5.4** resolution. Records now specify
both key and value schemas, as required by the
[Zod 4 migration guide](https://zod.dev/v4/changelog#zrecord). Output/input schema
behavior is exercised by real MCP client requests. Keeping separate Zod 3 and 4
copies caused the source type check to exhaust its heap during this refresh;
the unified graph passes without increasing the heap limit.
