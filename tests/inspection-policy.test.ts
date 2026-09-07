import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInspectionGuard,
  createRedactor,
  createWritePolicy,
  REDACTED,
  serializeRedacted,
} from "../src/inspection-policy.js";
import { loadConfig } from "../src/config.js";
import { ClientRegistry } from "../src/client-registry.js";
import { ActorStore } from "../src/actor-store.js";
import { Logger } from "../src/logger.js";

const logger = new Logger("error");
const allow = [
  { actor: "x:1", events: ["NEXT"] },
  { actor: "x:2", events: ["RESET"] },
];

afterEach(() => vi.unstubAllEnvs());

describe("application write policy", () => {
  it("defaults to read-only and otherwise denies unlisted pairs", () => {
    expect(createWritePolicy()("x:1", "NEXT").code).toBe("read_only");
    expect(createWritePolicy({ readOnly: false })("x:1", "NEXT").code).toBe(
      "write_not_allowed",
    );
    const check = createWritePolicy({ readOnly: false, allow });
    expect(check("x:1", "NEXT").success).toBe(true);
    expect(check("x:2", "RESET").success).toBe(true);
    for (const [actor, event] of [
      ["x:1", "RESET"],
      ["x:2", "NEXT"],
      ["x:3", "NEXT"],
      ["x:1", "next"],
    ])
      expect(check(actor, event).code).toBe("write_not_allowed");
    expect(check("x:1", undefined).code).toBe("invalid_event");
    expect(createWritePolicy({ allow })("x:1", "NEXT").code).toBe("read_only");
  });

  it("supports only an explicit whole-string wildcard and captures config copies", () => {
    const options = {
      readOnly: false,
      allow: [{ actor: "*", events: ["NEXT"] }],
    };
    const check = createWritePolicy(options);
    options.allow[0].events.push("DELETE");
    expect(check("anything", "NEXT").success).toBe(true);
    expect(check("anything", "DELETE").success).toBe(false);
    expect(
      createWritePolicy({
        readOnly: false,
        allow: [{ actor: "x:*", events: ["*"] }],
      })("x:1", "NEXT").success,
    ).toBe(false);
  });

  it("rejects direct registry writes before any socket send", async () => {
    const ws = { OPEN: 1, readyState: 1, send: vi.fn() };
    const registry = new ClientRegistry(1, logger);
    registry.registerSession(ws as never, "x:1");
    expect(await registry.sendEvent("x:1", { type: "NEXT" })).toMatchObject({
      success: false,
      code: "read_only",
    });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("disables instrumentation and dispatch unless enabled, and checks actual actor identity", () => {
    const actor = { sessionId: "x:1", send: vi.fn() };
    const command = {
      type: "xstate-mcp.send",
      requestId: "test",
      sessionId: "x:1",
      event: { type: "NEXT" },
    };
    const disabled = createInspectionGuard({
      writePolicy: { readOnly: false, allow },
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.serializeInspection({ password: "secret" })).toBeNull();
    expect(disabled.dispatch(actor, command).code).toBe(
      "instrumentation_disabled",
    );
    expect(
      createInspectionGuard({ enabled: true }).dispatch(actor, command).code,
    ).toBe("read_only");
    const enabled = createInspectionGuard({
      enabled: true,
      writePolicy: { readOnly: false, allow },
    });
    expect(enabled.dispatch(actor, { ...command, sessionId: "x:2" }).code).toBe(
      "actor_not_found",
    );
    expect(
      enabled.dispatch(actor, { ...command, event: { type: "RESET" } }).code,
    ).toBe("write_not_allowed");
    for (const invalid of [
      null,
      [],
      {},
      { ...command, event: [] },
      { ...command, requestId: "" },
    ])
      expect(enabled.dispatch(actor, invalid).code).toBe("invalid_command");
    expect(actor.send).not.toHaveBeenCalled();
    expect(enabled.dispatch(actor, command).success).toBe(true);
    actor.send.mockImplementation(() => {
      throw new Error("private payload");
    });
    expect(JSON.stringify(enabled.dispatch(actor, command))).not.toContain(
      "private payload",
    );
  });

  it.each([
    null,
    { readOnly: "false" },
    { allow: null },
    { allow: [{ actor: "", events: ["X"] }] },
    { allow: [{ actor: "*", events: "*" }] },
    { allow: [{ actor: "*", events: ["X"], typo: true }] },
    { allow: new Array(101).fill({ actor: "*", events: [] }) },
    { readonly: false },
  ])("rejects invalid write config %j", (value) => {
    expect(() => createWritePolicy(value as never)).toThrow();
  });

  it("loads CLI defaults and validates explicit policy without echoing input", () => {
    for (const key of [
      "XSTATE_MCP_READ_ONLY",
      "XSTATE_MCP_WRITE_ALLOW",
      "XSTATE_MCP_REDACTION",
    ])
      vi.stubEnv(key, undefined);
    expect(loadConfig().writePolicy).toEqual({ readOnly: true, allow: [] });
    vi.stubEnv("XSTATE_MCP_READ_ONLY", "false");
    vi.stubEnv("XSTATE_MCP_WRITE_ALLOW", JSON.stringify(allow));
    vi.stubEnv("XSTATE_MCP_REDACTION", '{"keys":["email"]}');
    expect(loadConfig()).toMatchObject({
      writePolicy: { readOnly: false, allow },
      redaction: { keys: ["email"] },
    });
    vi.stubEnv("XSTATE_MCP_READ_ONLY", "FALSE");
    expect(() => loadConfig()).toThrow("must be true or false");
    vi.stubEnv("XSTATE_MCP_READ_ONLY", "false");
    vi.stubEnv("XSTATE_MCP_REDACTION", "private invalid JSON");
    expect(() => loadConfig()).toThrow("Invalid JSON in XSTATE_MCP_REDACTION");
  });
});

describe("redaction before retention and transfer", () => {
  it("redacts default keys and suffix paths consistently across wrappers and arrays", () => {
    const redact = createRedactor({
      keys: ["email"],
      paths: [
        ["customer", "address"],
        ["items", "*", "note"],
      ],
    });
    const value = {
      customer: { address: "private", public: 1 },
      items: [{ note: "private", amount: 2 }],
      access_token: "private",
      API_KEY: "private",
      email: "private",
    };
    for (const wrapped of [
      value,
      { context: value },
      { traces: [{ snapshot: { context: value } }] },
    ]) {
      expect(JSON.stringify(redact(wrapped))).not.toContain("private");
      expect(JSON.stringify(redact(wrapped))).toContain(REDACTED);
    }
    expect(value.email).toBe("private");
  });

  it("omits accessors, classes, cycles, huge sparse arrays and traversal overflow", () => {
    const getter = vi.fn(() => "private");
    const toJSON = vi.fn(() => ({ password: "private" }));
    const input = {
      get tricky() {
        return getter();
      },
      toJSON,
      big: 12n,
      error: new Error("private"),
      cycle: {} as unknown,
    };
    input.cycle = input;
    const encoded = serializeRedacted(input);
    expect(encoded).not.toContain("private");
    expect(encoded).toContain('"big":"12"');
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(serializeRedacted(new Array(10_000_000))).toBe('"[OMITTED]"');
    let deep: unknown = { password: "private" };
    for (let i = 0; i < 100; i++) deep = { nested: deep };
    expect(serializeRedacted(deep)).toContain("[OMITTED]");
    const data = JSON.parse(
      '{"__proto__":{"password":"private"},"public":true}',
    );
    expect(JSON.parse(serializeRedacted(data)).__proto__.password).toBe(
      REDACTED,
    );
  });

  it("parses serialized definitions before transfer and drops invalid envelopes", () => {
    const guard = createInspectionGuard({ enabled: true });
    const envelope = { type: "@xstate.actor", sessionId: "x:1" };
    const message = guard.serializeInspection({
      ...envelope,
      definition: '{"meta":{"password":"private"}}',
    });
    expect(JSON.parse(message!).definition.meta.password).toBe(REDACTED);
    for (const definition of ["private invalid JSON", '"private"']) {
      expect(
        JSON.parse(guard.serializeInspection({ ...envelope, definition })!)
          .definition,
      ).toBe("[OMITTED]");
    }
    for (const invalid of [
      null,
      undefined,
      [],
      "null",
      {},
      { ...envelope, type: "unknown" },
      { ...envelope, sessionId: "" },
    ])
      expect(guard.serializeInspection(invalid)).toBeNull();
    expect(
      createInspectionGuard({
        enabled: true,
        redaction: { keys: ["sessionId"] },
      }).serializeInspection(envelope),
    ).toBeNull();
  });

  it("copies inputs before storage and filters snapshots, outputs, definitions and event history", () => {
    const store = new ActorStore(10, logger, { keys: ["privateData"] });
    const snapshot = {
      value: "idle",
      context: { password: "private", count: 1 },
      output: { privateData: "private" },
    };
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:1",
      snapshot,
      definition: '{"meta":{"password":"private"}}',
      createdAt: "now",
    });
    snapshot.context.password = "later private";
    const event = { type: "NEXT", data: { privateData: "private" } };
    store.addEvent({
      type: "@xstate.event",
      sessionId: "x:1",
      event,
      createdAt: "now",
    });
    event.data.privateData = "later private";
    store.updateSnapshot({
      type: "@xstate.snapshot",
      sessionId: "x:1",
      snapshot: {
        value: { privateData: "private" },
        context: { password: "private" },
        output: { password: "private" },
      },
      event,
      createdAt: "later",
    });
    const actor = store.getActor("x:1")!;
    expect(
      JSON.stringify([
        actor.currentSnapshot,
        actor.definition,
        actor.eventHistory.toArray(),
        actor.transitionHistory.toArray(),
      ]),
    ).not.toContain('"private"');
    expect(JSON.stringify(actor)).not.toContain("later private");
    expect(snapshot.context.password).toBe("later private");
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "bad-definition",
      definition: "private invalid JSON",
      createdAt: "now",
    });
    expect(store.getActor("bad-definition")!.definition).toBe("[OMITTED]");
  });

  it("applies whole-subtree and event-type rules consistently during retention", () => {
    const store = new ActorStore(10, logger, {
      paths: [
        ["snapshot", "context"],
        ["event", "type"],
        ["definition"],
        ["error", "message"],
      ],
    });
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "x:1",
      createdAt: "now",
      definition: { private: "private" },
      snapshot: { value: "idle", context: { private: "private" } },
    });
    store.addEvent({
      type: "@xstate.event",
      sessionId: "x:1",
      createdAt: "now",
      event: { type: "private" },
    });
    store.updateSnapshot({
      type: "@xstate.snapshot",
      sessionId: "x:1",
      createdAt: "later",
      snapshot: { value: "ready", context: { private: "private" } },
      event: { type: "private" },
    });
    const actor = store.getActor("x:1")!;
    expect(actor.definition).toBe(REDACTED);
    expect(actor.currentSnapshot!.context).toBe(REDACTED);
    expect(actor.eventHistory.toArray()[0].event.type).toBe(REDACTED);
    expect(actor.transitionHistory.toArray()[0].event).toBe(REDACTED);
    expect(
      store.redactField("error", {
        message: "private",
        cause: { token: "private" },
      }),
    ).toEqual({ message: REDACTED, cause: { token: REDACTED } });
    const hidden = new ActorStore(10, logger, { keys: ["snapshot"] });
    hidden.registerActor({
      type: "@xstate.actor",
      sessionId: "x:1",
      createdAt: "now",
      snapshot: { value: "idle", context: {} },
    });
    expect(hidden.getActor("x:1")!.currentSnapshot!.status).toBe("unknown");
  });

  it.each([
    null,
    { keys: "email" },
    { paths: ["context.email"] },
    { paths: [[]] },
    { keys: [""] },
    { paths: [new Array(17).fill("x")] },
    { path: ["email"] },
  ])("rejects invalid redaction config %j", (value) => {
    expect(() => createRedactor(value as never)).toThrow();
  });
});
