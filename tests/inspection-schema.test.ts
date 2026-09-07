import { describe, expect, it } from "vitest";
import { inspectionEventSchema } from "../src/types.js";

describe.each(["@xstate.actor", "@xstate.event", "@xstate.snapshot"])(
  "%s metadata",
  (type) => {
    it.each([null, undefined, "inspection-message-1"])(
      "accepts message id %s",
      (id) => {
        expect(
          inspectionEventSchema.safeParse({
            type,
            sessionId: "x:0",
            id,
            createdAt: "1788768000000",
          }).success,
        ).toBe(true);
      },
    );

    it.each([
      { id: 42 },
      { sessionId: null },
      { rootId: null },
      { actorRef: { sessionId: null } },
      { createdAt: null },
      { createdAt: 1788768000000 },
      { _version: {} },
    ])("rejects malformed metadata %j", (metadata) => {
      expect(
        inspectionEventSchema.safeParse({
          type,
          sessionId: "x:0",
          id: null,
          ...metadata,
        }).success,
      ).toBe(false);
    });
  },
);

it.each(["@xstate.actor", "@xstate.snapshot"])(
  "rejects a malformed %s snapshot",
  (type) => {
    expect(
      inspectionEventSchema.safeParse({
        type,
        sessionId: "x:0",
        id: null,
        snapshot: "not-an-object",
      }).success,
    ).toBe(false);
  },
);
