#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import {
  createInspectionServer,
  type InspectionServer,
} from "./inspection-server.js";

async function main(): Promise<void> {
  let bridge: InspectionServer | undefined;
  let logger = new Logger("error");
  let stopping = false;
  let exitDeadline: ReturnType<typeof setTimeout> | undefined;
  const armExitDeadline = () => {
    if (exitDeadline) return;
    // Do not keep a clean process alive. If blocked stdio writes or another
    // handle prevent natural exit after cleanup, enforce the final CLI budget.
    exitDeadline = setTimeout(() => {
      logger.error(
        "CLI shutdown exceeded 1500ms; forcing exit (stdio may be blocked)",
      );
      process.exit(1);
    }, 1500);
    exitDeadline.unref();
  };
  const report = (error: unknown) => {
    process.exitCode = 1;
    logger.error(error instanceof Error ? error.message : String(error));
  };
  const stop = () => {
    stopping = true;
    armExitDeadline();
    void bridge?.close().catch(report);
  };
  const streamError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") report(error);
    stop();
  };
  try {
    const config = loadConfig();
    logger = new Logger(config.logLevel);
    bridge = createInspectionServer(config);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdin.on("end", stop);
    process.stdin.on("close", stop);
    process.stdin.on("error", streamError);
    process.stdout.on("error", streamError);
    if (process.stdin.readableEnded || process.stdin.destroyed) stop();
    else {
      await bridge.start(new StdioServerTransport());
      logger.info("MCP server connected via stdio");
    }
    await bridge.closed;
  } catch (error) {
    if (
      !(
        stopping &&
        error instanceof Error &&
        error.message === "Inspection server closed during startup"
      )
    )
      report(error);
  } finally {
    armExitDeadline();
    try {
      await bridge?.close();
    } catch (error) {
      report(error);
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.off("end", stop);
    process.stdin.off("close", stop);
    process.stdin.off("error", streamError);
    process.stdout.off("error", streamError);
    process.stdin.pause();
  }
}

void main();
