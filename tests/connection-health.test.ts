import type { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectionHealth,
  connectionHealthSchema,
  STALE_AFTER_MS,
} from "../src/connection-health.js";
import { ClientRegistry } from "../src/client-registry.js";
import { Logger } from "../src/logger.js";
import { applicationHello } from "./fixtures/application-hello.js";

const socket = () =>
  ({ OPEN: 1, readyState: 1, send: vi.fn() }) as unknown as WebSocket;
const logger = new Logger("error");

describe("connection health and capability contracts", () => {
  it("counts empty connections, keeps actor clearing separate and forgets disconnects", () => {
    const registry = new ClientRegistry(5000, logger);
    const ws = socket();
    const id = registry.health.connect(ws);
    expect(registry.getConnectedClientCount()).toBe(1);
    expect(registry.getHealth()).toMatchObject({
      listener: { state: "not_started" },
      totals: { connectedClients: 1, registeredSessions: 0 },
    });
    registry.registerSession(ws, "actor");
    registry.health.negotiate(ws, applicationHello());
    registry.clear();
    expect(registry.getHealth().connections[0]).toMatchObject({
      connectionId: id,
      negotiation: "negotiated",
      actorCount: 0,
    });
    registry.removeClient(ws);
    registry.removeClient(ws);
    expect(registry.getHealth()).toMatchObject({
      totals: { connectedClients: 0, closedConnections: 1 },
      connections: [],
    });
    expect(registry.health.connect(socket())).not.toBe(id);
  });

  it.each([undefined, []])(
    "rejects unsupported writes immediately without sending or scheduling a timeout (%j)",
    async (commands) => {
      const registry = new ClientRegistry(5000, logger);
      const ws = socket();
      registry.registerSession(ws, "actor");
      if (commands) registry.health.negotiate(ws, applicationHello(commands));
      expect(await registry.sendEvent("actor", { type: "RUN" })).toMatchObject({
        success: false,
        code: commands
          ? "unsupported_command"
          : "capability_negotiation_required",
      });
      expect(ws.send).not.toHaveBeenCalled();
      expect(registry.getHealth().counters).toMatchObject({
        unsupportedCommands: 1,
        commandTimeouts: 0,
      });
      registry.removeClient(ws);
    },
  );

  it("intersects supported commands and locks an accepted handshake until reconnect", () => {
    const health = new ConnectionHealth();
    const ws = socket();
    const hello = applicationHello([
      "future_command",
      "send_event",
      "send_event",
    ]);
    expect(health.negotiate(ws, hello)).toMatchObject({
      success: true,
      protocolVersion: 1,
      commands: ["send_event"],
    });
    expect(health.negotiate(ws, hello).success).toBe(true);
    expect(health.negotiate(ws, applicationHello([]))).toMatchObject({
      success: false,
      code: "capabilities_locked",
      commands: ["send_event"],
    });
    health.disconnect(ws);
    expect(health.negotiate(ws, applicationHello([]))).toMatchObject({
      success: true,
      commands: [],
    });
  });

  it("recovers invalid and incompatible handshakes without retaining unsupported metadata", () => {
    const health = new ConnectionHealth();
    const ws = socket();
    expect(
      health.negotiate(ws, { ...applicationHello(), protocolVersion: 2 }),
    ).toMatchObject({
      success: false,
      code: "incompatible_protocol",
      protocolVersion: null,
    });
    expect(health.canInspect(ws)).toBe(false);
    expect(health.snapshot(() => 0).connections[0]).toMatchObject({
      offeredProtocolVersion: 2,
      application: null,
      adapter: null,
    });
    expect(health.negotiate(ws, null).success).toBe(false);
    expect(health.negotiate(ws, applicationHello()).success).toBe(true);
    expect(health.canInspect(ws)).toBe(true);
  });

  it("uses monotonic receipt ages and separates transport liveness from inspection freshness", () => {
    let clock = 0,
      wall = Date.parse("2026-09-07T00:00:00Z");
    const health = new ConnectionHealth(
      () => clock,
      () => wall,
    );
    const ws = socket();
    health.connect(ws);
    health.acceptedInspection(ws);
    clock = STALE_AFTER_MS;
    wall -= 100_000;
    expect(health.snapshot(() => 1).connections[0]).toMatchObject({
      freshness: "stale",
      activityAgeMs: STALE_AFTER_MS,
      inspectionAgeMs: STALE_AFTER_MS,
    });
    health.activity(ws);
    expect(health.snapshot(() => 1).connections[0]).toMatchObject({
      freshness: "fresh",
      activityAgeMs: 0,
      inspectionAgeMs: STALE_AFTER_MS,
    });
  });

  it("bounds response rows and allows a specific omitted connection to be inspected", () => {
    const health = new ConnectionHealth();
    const ids: string[] = [];
    for (let i = 0; i < 57; i++) ids.push(health.connect(socket()));
    const result = health.snapshot(() => 0);
    expect(result.connections).toHaveLength(50);
    expect(result).toMatchObject({
      nextOffset: 50,
      omittedConnections: 7,
      totals: { connectedClients: 57 },
    });
    expect(
      health.snapshot(() => 0, 1, ids[56]).connections[0].connectionId,
    ).toBe(ids[56]);
    expect(connectionHealthSchema.safeParse(result).success).toBe(true);
    const finalPage = health.snapshot(() => 0, 50, undefined, 50);
    expect(finalPage.connections).toHaveLength(7);
    expect(finalPage.nextOffset).toBeNull();
    expect(finalPage.connections[6].connectionId).toBe(ids[56]);
    expect(() => health.snapshot(() => 0, 50, undefined, NaN)).toThrow(
      RangeError,
    );
    for (const limit of [0, 51, NaN, Infinity, 1.5])
      expect(() => health.snapshot(() => 0, limit)).toThrow(RangeError);
  });

  it("drops unknown metadata and rejects oversized identity fields", () => {
    const health = new ConnectionHealth();
    const ws = socket();
    const secret = "secret-value-not-for-health";
    health.negotiate(ws, {
      ...applicationHello(),
      token: secret,
      application: { name: "demo", url: secret },
      adapter: { name: "fixture", version: "1", token: secret },
    });
    expect(JSON.stringify(health.snapshot(() => 0))).not.toContain(secret);
    const result = health.snapshot(() => 0);
    result.connections[0].application!.name = "mutated";
    result.connections[0].commands.length = 0;
    expect(health.snapshot(() => 0).connections[0]).toMatchObject({
      application: { name: "demo" },
      commands: ["send_event"],
    });
    expect(
      health.negotiate(socket(), {
        ...applicationHello(),
        application: { name: "x".repeat(65) },
      }).code,
    ).toBe("invalid_hello");
  });
});
