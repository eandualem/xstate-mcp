import type { LogLevel } from "./types.js";
import { safeStringify } from "./safe-stringify.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private threshold: number;

  constructor(private level: LogLevel = "info") {
    this.threshold = LEVEL_ORDER[level];
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < this.threshold) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

    if (data !== undefined) {
      process.stderr.write(`${prefix} ${message} ${safeStringify(data)}\n`);
    } else {
      process.stderr.write(`${prefix} ${message}\n`);
    }
  }

  debug(message: string, data?: unknown): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log("error", message, data);
  }
}
