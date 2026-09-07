/** Browser-safe policy boundary. This module never opens a connection. */
export interface WritePolicyOptions {
  /** Application writes are disabled unless explicitly set to false. */
  readOnly?: boolean;
  /** Rules are paired; actor and event must match the same rule. Omitted = none. */
  allow?: readonly { actor: string; events: readonly string[] }[];
}

export interface RedactionOptions {
  /** Additional keys, matched anywhere, ignoring case, hyphens and underscores. */
  keys?: readonly string[];
  /** Suffix paths of literal segments; * matches one segment (including array indices). */
  paths?: readonly (readonly string[])[];
}

export interface PolicyResult {
  success: boolean;
  code?: string;
  error?: string;
}

export const REDACTED = "[REDACTED]";
const OMITTED = "[OMITTED]";
const DEFAULT_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "authorization",
  "cookie",
  "setCookie",
  "privateKey",
  "clientSecret",
];
const normalizeKey = (key: string) => key.replace(/[-_]/g, "").toLowerCase();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateOptions(value: unknown, keys: string[]): void {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error("Invalid inspection policy options");
  }
}

function validString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function strings(value: unknown, maxLength = 256): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((v) => validString(v, maxLength))
  );
}

/** Captures a validated copy so later mutation of config cannot enable writes. */
export function createWritePolicy(options: WritePolicyOptions = {}) {
  validateOptions(options, ["readOnly", "allow"]);
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    throw new Error("Invalid readOnly policy");
  }
  const readOnly = options.readOnly !== false;
  const allow = options.allow === undefined ? [] : options.allow;
  if (!Array.isArray(allow) || allow.length > 100)
    throw new Error("Invalid write allow rules");
  const rules = allow.map((rule) => {
    validateOptions(rule, ["actor", "events"]);
    if (!validString(rule.actor, 1024) || !strings(rule.events))
      throw new Error("Invalid write allow rule");
    return { actor: rule.actor, events: new Set(rule.events) };
  });
  return (sessionId: string, eventType: unknown): PolicyResult => {
    if (readOnly)
      return {
        success: false,
        code: "read_only",
        error: "Application writes are disabled",
      };
    if (!validString(eventType))
      return {
        success: false,
        code: "invalid_event",
        error:
          "Event type must be a non-empty string of at most 256 characters",
      };
    if (
      !rules.some(
        (rule) =>
          (rule.actor === "*" || rule.actor === sessionId) &&
          (rule.events.has("*") || rule.events.has(eventType)),
      )
    ) {
      return {
        success: false,
        code: "write_not_allowed",
        error: "Actor/event pair is not allowed by the write policy",
      };
    }
    return { success: true };
  };
}

/** Creates JSON-safe copies without calling getters or toJSON. No original data is retained. */
export function createRedactor(options: RedactionOptions = {}) {
  validateOptions(options, ["keys", "paths"]);
  if (options.keys !== undefined && !strings(options.keys, 128))
    throw new Error("Invalid redaction keys");
  if (
    options.paths !== undefined &&
    (!Array.isArray(options.paths) ||
      options.paths.length > 100 ||
      options.paths.some(
        (path) => !strings(path, 128) || path.length === 0 || path.length > 16,
      ))
  ) {
    throw new Error("Invalid redaction paths");
  }
  const keys = new Set(
    [...DEFAULT_KEYS, ...(options.keys ?? [])].map(normalizeKey),
  );
  const paths = (options.paths ?? []).map((path) => [...path]);
  return (input: unknown): unknown => {
    let remaining = 10_000;
    const ancestors = new WeakSet<object>();
    const visit = (value: unknown, path: string[]): unknown => {
      if (
        keys.has(normalizeKey(path.at(-1) ?? "")) ||
        paths.some(
          (rule) =>
            rule.length <= path.length &&
            rule.every(
              (segment, i) =>
                segment === "*" ||
                segment === path[path.length - rule.length + i],
            ),
        )
      )
        return REDACTED;
      if (--remaining < 0 || path.length > 64) return OMITTED;
      if (path.at(-1) === "definition" && typeof value === "string") {
        try {
          value = JSON.parse(value);
          if (value === null || typeof value !== "object") return OMITTED;
        } catch {
          return OMITTED;
        }
      }
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
      )
        return value;
      if (typeof value === "number")
        return Number.isFinite(value) ? value : null;
      if (typeof value === "bigint") return String(value);
      if (value === undefined) return undefined;
      if (typeof value !== "object") return OMITTED;
      if (ancestors.has(value)) return OMITTED;
      const array = Array.isArray(value);
      if (
        !array &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        return OMITTED;
      if (Array.isArray(value) && value.length > remaining) return OMITTED;
      const names = Object.keys(value);
      if (names.length > remaining) return OMITTED;
      ancestors.add(value);
      const result: Record<string, unknown> | unknown[] = array ? [] : {};
      for (const key of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const next =
          descriptor && "value" in descriptor
            ? visit(descriptor.value, [...path, key])
            : OMITTED;
        Object.defineProperty(result, key, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      ancestors.delete(value);
      return result;
    };
    try {
      return visit(input, []);
    } catch {
      return OMITTED;
    }
  };
}

/** Use for prepared inspection payloads and manually constructed diagnostic exports. */
export function serializeRedacted(
  value: unknown,
  options?: RedactionOptions,
): string {
  return JSON.stringify(createRedactor(options)(value)) ?? "null";
}

export interface DispatchActor {
  sessionId: string;
  send(event: { type: string; [key: string]: unknown }): void;
}

/** Opt in with your development build flag. Supply already projected inspection envelopes. */
export function createInspectionGuard(
  options: {
    enabled?: boolean;
    writePolicy?: WritePolicyOptions;
    redaction?: RedactionOptions;
  } = {},
) {
  validateOptions(options, ["enabled", "writePolicy", "redaction"]);
  if (options.enabled !== undefined && typeof options.enabled !== "boolean")
    throw new Error("Invalid instrumentation enabled flag");
  const enabled = options.enabled === true;
  const check = createWritePolicy(options.writePolicy);
  const redact = createRedactor(options.redaction);
  return {
    enabled,
    serializeInspection(value: unknown): string | null {
      if (!enabled) return null;
      return JSON.stringify(redact(value)) ?? "null";
    },
    dispatch(actor: DispatchActor | undefined, command: unknown): PolicyResult {
      if (!enabled)
        return {
          success: false,
          code: "instrumentation_disabled",
          error: "Development instrumentation is disabled",
        };
      if (
        !isRecord(command) ||
        command.type !== "xstate-mcp.send" ||
        !validString(command.requestId, 128) ||
        !validString(command.sessionId, 1024) ||
        !isRecord(command.event)
      ) {
        return {
          success: false,
          code: "invalid_command",
          error: "Invalid send command",
        };
      }
      if (!actor || actor.sessionId !== command.sessionId)
        return {
          success: false,
          code: "actor_not_found",
          error: "Actor is not registered in this adapter",
        };
      const result = check(actor.sessionId, command.event.type);
      if (!result.success) return result;
      try {
        actor.send(command.event as { type: string; [key: string]: unknown });
        return { success: true };
      } catch {
        // Exception text can contain event/context secrets. Never put it on the wire.
        return {
          success: false,
          code: "dispatch_failed",
          error: "Actor dispatch failed",
        };
      }
    },
  };
}
