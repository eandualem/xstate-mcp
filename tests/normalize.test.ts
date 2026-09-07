import { describe, it, expect, vi } from "vitest";
import { normalizeEvent } from "../src/ws-server.js";
import { Logger } from "../src/logger.js";
import type { IncomingEvent } from "../src/types.js";

const logger = new Logger("error");

describe("normalizeEvent", () => {
  describe("timestamps", () => {
    it.each([
      ["1788768000000", "2026-09-07T08:00:00.000Z"],
      ["0", "1970-01-01T00:00:00.000Z"],
      ["-1", "1969-12-31T23:59:59.999Z"],
      ["2026-09-07T11:00:00+03:00", "2026-09-07T08:00:00.000Z"],
      ["2026-09-07T08:00:00Z", "2026-09-07T08:00:00.000Z"],
      ["2026-09-07T08:00:00.123Z", "2026-09-07T08:00:00.123Z"],
    ])("normalizes %s to UTC ISO", (createdAt, expected) => {
      for (const type of [
        "@xstate.actor",
        "@xstate.event",
        "@xstate.snapshot",
      ] as const) {
        expect(
          normalizeEvent(
            {
              type,
              sessionId: "x:0",
              createdAt,
            },
            logger,
          )?.createdAt,
        ).toBe(expected);
      }
    });

    it.each([
      "",
      "not-a-date",
      "1788768000000junk",
      "1.5",
      "1e12",
      "Infinity",
      "8640000000000001",
      "-8640000000000001",
      "99999999999999999999",
      "2026-02-30T08:00:00Z",
      "2026-09-07",
      "2026-09-07T08:00:00",
      " 1788768000000 ",
      "2026-09-07T08:00:00+99:00",
    ])("rejects an invalid supplied timestamp: %s", (createdAt) => {
      expect(
        normalizeEvent(
          {
            type: "@xstate.actor",
            sessionId: "x:0",
            createdAt,
          },
          logger,
        ),
      ).toBeNull();
    });

    it("uses receipt time only when createdAt is absent", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-07T08:00:00.123Z"));
        expect(
          normalizeEvent(
            {
              type: "@xstate.actor",
              sessionId: "x:0",
            },
            logger,
          )?.createdAt,
        ).toBe("2026-09-07T08:00:00.123Z");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("native XState 5 format (actorRef/sourceRef)", () => {
    it("extracts sessionId from actorRef.sessionId", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.actor",
        actorRef: { sessionId: "x:0:agents" },
        rootId: "x:0",
      };

      const result = normalizeEvent(incoming, logger);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("x:0:agents");
      expect(result!.type).toBe("@xstate.actor");
    });

    it("extracts name from actorRef.id for @xstate.actor", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.actor",
        actorRef: { sessionId: "x:0:agents", id: "agentsMachine" },
        rootId: "x:0",
      };

      const result = normalizeEvent(incoming, logger);
      expect(result!.type).toBe("@xstate.actor");
      if (result!.type === "@xstate.actor") {
        expect(result!.name).toBe("agentsMachine");
      }
    });

    it("extracts sourceId from sourceRef.sessionId for @xstate.event", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.event",
        actorRef: { sessionId: "x:0:test" },
        sourceRef: { sessionId: "x:0" },
        event: { type: "LOAD" },
      };

      const result = normalizeEvent(incoming, logger);
      expect(result!.type).toBe("@xstate.event");
      if (result!.type === "@xstate.event") {
        expect(result!.sourceId).toBe("x:0");
      }
    });

    it("generates createdAt when missing", () => {
      const before = new Date().toISOString();
      const incoming: IncomingEvent = {
        type: "@xstate.snapshot",
        actorRef: { sessionId: "x:0:test" },
        snapshot: { status: "active", value: "idle" },
      };

      const result = normalizeEvent(incoming, logger);
      expect(result!.createdAt).toBeDefined();
      expect(result!.createdAt >= before).toBe(true);
    });

    it("extracts sessionId from actorRef.id (real XState 5 serialization)", () => {
      // XState 5 serializes actorRef as { xstate$$type: 1, id: "x:5" }
      const incoming: IncomingEvent = {
        type: "@xstate.actor",
        actorRef: { id: "x:5" },
        rootId: "x:0",
      };

      const result = normalizeEvent(incoming, logger);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("x:5");
    });

    it("extracts sourceId from sourceRef.id for @xstate.event", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.event",
        actorRef: { id: "x:5" },
        sourceRef: { id: "x:0" },
        event: { type: "LOAD" },
      };

      const result = normalizeEvent(incoming, logger);
      if (result!.type === "@xstate.event") {
        expect(result!.sourceId).toBe("x:0");
      }
    });

    it("prefers actorRef.sessionId over actorRef.id", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.actor",
        actorRef: { sessionId: "session-id", id: "ref-id" },
      };

      const result = normalizeEvent(incoming, logger);
      expect(result!.sessionId).toBe("session-id");
    });

    it("returns null when both sessionId and actorRef are missing", () => {
      const incoming = {
        type: "@xstate.actor" as const,
      };

      const result = normalizeEvent(incoming, logger);
      expect(result).toBeNull();
    });
  });

  describe("serialized @statelyai/inspect format (sessionId/sourceId)", () => {
    it("uses top-level sessionId directly", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.actor",
        sessionId: "x:0:agents",
        name: "agentsMachine",
        rootId: "x:0",
        createdAt: "2026-02-28T12:00:00.000Z",
        id: "evt-1",
        _version: 1,
      };

      const result = normalizeEvent(incoming, logger);
      expect(result!.sessionId).toBe("x:0:agents");
      if (result!.type === "@xstate.actor") {
        expect(result!.name).toBe("agentsMachine");
      }
    });

    it("uses top-level sourceId directly for @xstate.event", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.event",
        sessionId: "x:0:test",
        sourceId: "x:0",
        event: { type: "LOAD" },
        createdAt: "2026-02-28T12:00:00.000Z",
      };

      const result = normalizeEvent(incoming, logger);
      if (result!.type === "@xstate.event") {
        expect(result!.sourceId).toBe("x:0");
      }
    });

    it("preserves provided createdAt", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.snapshot",
        sessionId: "x:0:test",
        snapshot: { status: "active", value: "loading" },
        createdAt: "2026-01-15T10:00:00.000Z",
      };

      const result = normalizeEvent(incoming, logger);
      expect(result!.createdAt).toBe("2026-01-15T10:00:00.000Z");
    });
  });

  describe("prefers top-level fields over nested refs", () => {
    it("uses sessionId over actorRef.sessionId when both present", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.actor",
        sessionId: "top-level-id",
        actorRef: { sessionId: "nested-id" },
      };

      const result = normalizeEvent(incoming, logger);
      expect(result!.sessionId).toBe("top-level-id");
    });

    it("uses sourceId over sourceRef.sessionId when both present", () => {
      const incoming: IncomingEvent = {
        type: "@xstate.event",
        sessionId: "x:0:test",
        sourceId: "top-source",
        sourceRef: { sessionId: "nested-source" },
        event: { type: "LOAD" },
      };

      const result = normalizeEvent(incoming, logger);
      if (result!.type === "@xstate.event") {
        expect(result!.sourceId).toBe("top-source");
      }
    });
  });
});
