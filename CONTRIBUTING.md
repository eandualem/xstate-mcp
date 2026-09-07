# Contributing

xstate-mcp helps coding agents inspect and exercise running XState applications.
Keep changes focused on making the observe → act → verify loop reliable.
Read [the concepts](docs/concepts.md) and [agent instructions](AGENTS.md) first.

## Setup

Use Bun with the committed `bun.lock` and a maintained Node.js LTS (Node 24 was
used for the September 2026 review). The package still declares Node >=20;
updating that support policy is tracked in the roadmap.

```bash
bun install --frozen-lockfile
bun run check
bun run build
```

The suite runs locally without a browser, API key, model, backbone, or another
repository. WebSocket tests bind loopback ports. The current suite does not
establish compatibility with real XState applications; see the
[review](docs/reviews/2026-09-07.md) for the integration test work.

`bun run dev` starts the server. Use `XSTATE_MCP_WS_PORT` to avoid another MCP
process's port. Server stdout is reserved for JSON-RPC; read diagnostics on stderr.

## Changes and pull requests

- Branch from the current default branch, currently `main`, and target it with PRs.
- Keep source fixes, capabilities, and demos reviewable as separate issues/PRs.
- Use conventional commit prefixes; explain the reason for the change.
- Run `bun run check` and `bun run build` for code/dependency changes. For a
  docs-only change, validate links, configuration, and consistency with the code.
- Add behavioral regression tests for bugs. For wire protocol changes, include
  real producer messages and a real MCP client; keep fixtures versioned.
- Link the issue and summarize validation. Use `Closes #N` only when all its
  acceptance criteria are met. Leave remaining work explicit.

Instructions and local handoffs work across CLIs; see
[the agent workflow](docs/agent-workflow.md). Backbone is an optional coordination
tool and is not a build or runtime dependency.

## Releases

Publishing is a separate maintainer operation. `make publish` currently bumps
the npm version and publishes immediately. The September review found version
drift across npm, the checkout, and server metadata; reconcile that provenance
before the next release. A release should be built and tested from a known commit,
with consistent metadata, a tag, and release notes. Do not publish incidentally
while working on an issue.
