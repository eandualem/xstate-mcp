# Releasing xstate-mcp

`package.json` is the version source. The MCP handshake bundles that version at
build time. `server.json` repeats it for discovery and is checked for drift.
The current `1.1.0-dev.0` is an unpublished development candidate. It is not a
promise that the combined revival changes will be a minor release.

## Historical 1.0.3 provenance

On 2026-09-07, the npm registry listed only 1.0.0 (2026-03-01) and 1.0.3
(2026-03-02); latest was 1.0.3. Source main was
`c7995acd1f823aa07c083d1ae8a67ee57faef99d`, package.json said 1.0.1, and
initialize/server.json said 1.0.0. There were no remote tags or GitHub releases.

The [npm 1.0.3 record](https://registry.npmjs.org/xstate-mcp/1.0.3) names
`6dce7c787ddfab3dde8d06f81f6e0b0cdbfe6003` as gitHead. That object was not
available in the fetched checkout. We cannot authenticate its source history.
Do not create a retrospective tag implying otherwise.

The downloaded tarball has npm SHA-1
`4a0fdbf273d6d41d78985b18ede27ae5b6b402ed` and integrity
`sha512-n8MRUz09S6xutR1WatVZOJ4xTjWIowB+s88svypQ+zIJRjzDb68a9AZv46vbsydO2UxdV1jgoFrk5O7NkH+YsA==`.
A frozen Bun 1.4.2 / Node 24.20.0 rebuild of c7995ac produced byte-identical
`dist/index.js`, its source map and declarations. README and LICENSE also match;
package.json differs only in version (1.0.1 versus 1.0.3). This establishes
artifact equivalence for those files, not verified Git or build provenance.
The executable's SHA-256 is
`158257198318c6844a9940a22446f085285c2afcee727b183aadd8db7582ef7c`.

Reproduce with `npm pack xstate-mcp@1.0.3 --ignore-scripts` in a scratch directory
and compare its extracted files with a frozen rebuild of that commit. Never
republish 1.0.3 or use an existing version to repair metadata.

## Prepare a candidate

Use Node 24.20.0 (bundled npm 11.19.0) and Bun 1.4.2. `bun.lock` is authoritative;
production dependency ranges still allow consumer installations to resolve newer
versions. Each candidate records the actual clean consumer's package-lock.json.

```bash
bun install --frozen-lockfile
bun run check
bun run release:prepare
```

The preparation command validates metadata, builds twice from clean `dist/`,
compares tarball SHA-256, checks the package allowlist and executable mode, then
installs the archive outside the checkout without development dependencies or
lifecycle scripts. A real XState actor is discovered, commanded via `send_event`,
and verified through both state and resource reads. The handshake must match the
installed package version. Export and declaration targets must resolve. After
#5 is integrated, the smoke additionally imports and closes the library factory.

`artifacts/` contains the archive, metadata, committed release notes, consumer
lockfile and `release.json` with source commit, dirty flag, tool versions and
checksums. `bun run release:verify` checks their relationship to the checkout.
Local dirty candidates are useful for development; CI artifacts must be clean.
The workflow tests the same archive on Node 22.23.2 and 24.20.0.

These checks establish repeatable package bytes with the pinned build tools on
the same platform. They do not promise all operating systems produce identical
archives or freeze future consumers' transitive dependencies. The consumer test
is also a runnable minimal example: see `scripts/consumer-fixture.mjs` for the
inspection forwarding and acknowledgement adapter. It is not a complete
production adapter or frontend demo; those remain #13 and #17.

## Maintainer release procedure

1. Integrate and review the intended changes, including #5, #6 and #7. The
   publication preflight rejects the old combined CLI/library entry point and a
   missing audit gate. Complete the full contract CI work before releasing.
2. Select an unused stable version after assessing the combined API/runtime
   changes. Run `npm version X.Y.Z --no-git-tag-version` (the version hook updates
   server.json), add `docs/releases/X.Y.Z.md`, update the lock with Bun if needed,
   and commit through a PR. CI must pass for the integrated commit on main.
3. Create and push the annotated tag `vX.Y.Z` at that exact reviewed main commit.
   Tags alone do not publish. Dispatch the **Release** workflow from that tag with
   `publish: true`. A dispatch with the default `false` only prepares artifacts.
4. Review the candidate artifact and approve the `npm-release` environment. The
   workflow rechecks tag/version/main ancestry and npm availability, verifies the
   downloaded archive, then publishes those bytes with scripts disabled. It does
   not install dependencies or rebuild in the publishing job. A separate job
   attaches the exact archive, notes and evidence to a GitHub release.

Before using publication, configure the GitHub `npm-release` environment with
required maintainer reviewers and tag deployment restrictions. Configure npm's
trusted publisher for owner `eandualem`, repository `xstate-mcp`, workflow
`release.yml`, environment `npm-release`, with direct `npm publish` permitted.
These are external maintainer settings; adding this workflow does not configure
them. The workflow grants read-only access to testing, OIDC plus contents-read to
publication, and contents-write only to GitHub release creation. It stores no npm
token. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

If npm succeeds but GitHub release creation fails, rerun only the release-notes
job or attach the original artifact manually. Do not rerun publication: the
existing npm version check will reject it. If a defect is discovered after
publication, fix it in a new version; retain the tag and original evidence.
`make publish` now exits with instructions; it never bumps or publishes.

## Discovery metadata

`bun run metadata:sync` updates registry version fields;
`bun run metadata:check` validates them and the package export paths. JSON schemas
are vendored under `schemas/` with upstream URLs, retrieval dates and SHA-256 in
`sources.json`, so validation does not depend on a mutable network response.
Review schema updates against upstream and update the recorded digest together.

- MCP Registry uses the versioned
  [2025-12-11 schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
  The npm package includes `mcpName` matching `server.json`, as required by
  [registry ownership verification](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx).
  Registry publication is a separate maintainer step after npm publication;
  schema validation alone does not establish ownership or create a listing.
- Glama now uses its [current schema](https://glama.ai/mcp/schemas/server.json)
  with the GitHub maintainer list. Repository fields belong in package metadata.
  No live Glama ownership claim or listing was changed.
- The old `smithery.yaml` is retired. Current Smithery
  [local publishing](https://smithery.ai/docs/build/publish) distributes MCPB
  bundles; the npm tarball and legacy YAML are not such a bundle. Smithery
  distribution requires a separately built and tested MCPB bundle, tracked in
  [#29](https://github.com/eandualem/xstate-mcp/issues/29). This release
  workflow supports npm and prepares MCP Registry metadata; it does not claim a
  verified Smithery deployment.
