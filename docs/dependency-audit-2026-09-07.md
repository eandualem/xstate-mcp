# Dependency audit — 2026-09-07

Scope: the complete Bun dependency graph in this revision, including development
and optional dependencies. Auditor: **Bun 1.4.2**, npm advisory service via
`bun audit --json`. The committed `bun.lock` records exact versions and integrity
hashes. This is an audit of source dependencies, not a published-package update.

## Result

The previous frozen graph (main `c7995acd1f823aa07c083d1ae8a67ee57faef99d`)
reported **19 package names and 79 distinct advisory URLs**. The refreshed graph
reports **one low-severity advisory**, described below. There are no reported
moderate, high or critical advisories, and no reported advisories on the runtime
dependency paths. These counts are audit results, not counts of exploitable
server defects.

Runtime resolutions are **@modelcontextprotocol/sdk 1.30.0**, **ws 8.21.3** and
**zod 4.5.4**. Development resolutions are **@types/node 22.20.1**, **@types/ws
8.18.1**, **@typescript-eslint/eslint-plugin and parser 8.69.0**, **eslint
10.10.0**, **prettier 3.9.6**, **tsup 8.5.1**, **tsx 4.23.13**, **typescript
5.9.3**, **vite 8.2.2**, **vitest 5.0.0**, and real test producers **xstate
5.32.6** / **xstate-compat (npm:xstate) 5.28.0**.

Selected refreshed transitive resolutions: **@hono/node-server 1.19.17**, **hono
4.13.7**, **express 5.2.1**, **express-rate-limit 8.7.0**, **body-parser 2.3.0**,
**qs 6.16.0**, **path-to-regexp 8.4.2**, **postcss 8.5.28** and **rollup 4.63.1**.
**esbuild 0.27.7** remains on the build path; **tsx uses esbuild 0.28.2**.

## Reachability and mitigation

- **WebSocket receiver, fixed:** the old direct `ws 8.19.0` was affected by
  [GHSA-96hv-2xvq-fx4p](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p).
  The application accepts WebSocket data, so the fragment/chunk memory-exhaustion
  path was relevant. `ws 8.21.3` includes the fix. A fixed-size regression sends
  16,386 one-byte fragments (under 120 KiB on the wire), verifies close code 1008
  and confirms the MCP server remains responsive. This tests the fragment cap;
  it does not attempt an unbounded exhaustion attack or prove every resource
  budget safe.
- **Vitest tooling, fixed:** the previous `vitest 3.2.4` appeared in
  [GHSA-5xrq-8626-4rwp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp).
  Exploitation depends on the affected UI/API server mode and exposure. Our
  configured `vitest run` with Node tests does not demonstrate that exposure.
  The graph now uses `vitest 5.0.0` and `vite 8.2.2`, which the audit does not flag.
- **SDK HTTP dependencies, refreshed:** `xstate-mcp → @modelcontextprotocol/sdk`
  includes Hono, its Node adapter, Express and rate-limit middleware. Express
  also brings body-parser/qs and router/path-to-regexp. Our executable uses the
  SDK's stdio transport; it does not instantiate those HTTP/OAuth routes.
  Reviewing the entry point establishes that distinction; the raw audit totals
  did not establish HTTP exploits in this server. Their transitive versions
  were refreshed with the rest of the graph.
- **Remaining low advisory:**
  [GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr)
  affects `esbuild >=0.27.3 <0.28.1` when its development server serves a directory
  on Windows. Paths in this lock: `xstate-mcp (dev) → tsup 8.5.1 → esbuild 0.27.7`
  and the same version as Vite's optional peer (Vite is direct and a Vitest peer).
  tsup calls esbuild's build API; Vite uses transforms/build integration, not
  esbuild's `serve` API. The repository never configures `servedir` or calls
  esbuild's development server. `bun run dev` uses tsx's patched 0.28.2 copy.
  esbuild is absent from the runtime dependencies. Thus the advisory's required
  serving path is not reachable through the documented scripts. Do not expose
  the affected esbuild development server; use a patched standalone version if
  adding that behavior. Retain the compatible tsup range rather than silently
  overriding its pre-1.0 dependency across a minor version. Upgrade the owning
  build tool and remove the exception when possible; review by **2026-10-07**.

## Reproduce and enforce

```sh
bun install --frozen-lockfile
bun pm ls
bun why esbuild
bun audit --json
bun run audit:check
```

Unfiltered `bun audit --json` exits **1** with the one esbuild advisory.
`audit:check` ignores **only GHSA-g7r4-m6w7-qqqr** and exits **0** for this graph;
CI uses that command so any other reported advisory, including low severity,
fails the audit gate. Inspect the unfiltered output on each dependency update;
this exception is specific to the dependency paths and behavior above and must
be reconsidered if either changes. Registry responses can change after this date.

See [runtime support](runtime-support.md) for the pinned Node/Bun versions,
compatibility decisions and required quality/integration gates.
