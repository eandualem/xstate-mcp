import pkg from "../package.json" with { type: "json" };

// Bundled at build time; installed servers do not read a workspace manifest.
export const version = pkg.version;
