// Bundle-only configuration boundary. The package's real CLI owns its lifecycle.
import { readFileSync } from "node:fs";

function integer(name, min, max) {
  const value = process.env[name];
  if (
    !/^\d+$/.test(value ?? "") ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(`${name} must be a whole number between ${min} and ${max}`);
}
try {
  if (![22, 24].includes(Number(process.versions.node.split(".")[0])))
    throw new Error("This bundle is verified on Node.js 22 and 24");
  integer("XSTATE_MCP_WS_PORT", 1024, 65535);
  integer("XSTATE_MCP_BUFFER_SIZE", 1, 10000);
  if (!["127.0.0.1", "::1"].includes(process.env.XSTATE_MCP_WS_HOST))
    throw new Error(
      "XSTATE_MCP_WS_HOST must be a loopback address (127.0.0.1 or ::1)",
    );
  if (
    !["debug", "info", "warn", "error"].includes(
      process.env.XSTATE_MCP_LOG_LEVEL,
    )
  )
    throw new Error("XSTATE_MCP_LOG_LEVEL must be debug, info, warn or error");
  if (!["true", "false"].includes(process.env.XSTATE_MCP_REQUIRE_ORIGIN))
    throw new Error("XSTATE_MCP_REQUIRE_ORIGIN must be true or false");
  const origins = process.env.XSTATE_MCP_ALLOWED_ORIGINS?.split(",").map((s) =>
    s.trim(),
  );
  if (
    !origins?.length ||
    origins.length > 32 ||
    origins.some((origin) => {
      try {
        const url = new URL(origin.replace(/:\*$/, ":7357"));
        return (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash ||
          origin.endsWith("/")
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      "XSTATE_MCP_ALLOWED_ORIGINS must contain at most 32 HTTP(S) origins",
    );
  const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  );
  const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["xstate-mcp"];
  if (
    typeof entry !== "string" ||
    !/^dist\/[a-zA-Z0-9_./-]+\.js$/.test(entry) ||
    entry.split("/").includes("..")
  )
    throw new Error("Bundle package has an invalid CLI entry");
  await import(new URL(entry, import.meta.url).href);
} catch (error) {
  process.stderr.write(
    `xstate-mcp bundle: ${error instanceof Error ? error.message : "startup failed"}\n`,
  );
  process.exitCode = 1;
}
