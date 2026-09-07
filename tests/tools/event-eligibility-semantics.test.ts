import { describe, expect, it } from "vitest";
import { createActor, createMachine, type MachineConfig } from "xstate-compat";
import * as current from "xstate";
import { ActorStore } from "../../src/actor-store.js";
import { Logger } from "../../src/logger.js";
import { canHandleEvent } from "../../src/tools/can-handle-event.js";

type Config = MachineConfig<Record<string, unknown>, { type: string }> &
  current.MachineConfig<Record<string, unknown>, { type: string }>;
const effect = { actions: "effect" };
const cases: {
  name: string;
  config: Config;
  event: string;
  expected: boolean;
  matched: string[];
  blocked?: string[];
}[] = [
  {
    name: "exact",
    config: {
      initial: "idle",
      states: { idle: { on: { GO: "done" } }, done: {} },
    },
    event: "GO",
    expected: true,
    matched: ["idle.on.GO"],
  },
  {
    name: "unhandled",
    config: {
      initial: "idle",
      states: { idle: { on: { GO: "done" } }, done: {} },
    },
    event: "OTHER",
    expected: false,
    matched: [],
  },
  {
    name: "root atomic wildcard",
    config: { on: { "*": effect } },
    event: "OTHER",
    expected: true,
    matched: ["(root).on.*"],
  },
  {
    name: "root partial wildcard",
    config: { on: { "user.*": effect } },
    event: "user.save",
    expected: true,
    matched: ["(root).on.user.*"],
  },
  {
    name: "bare prefix follows XState v5",
    config: { on: { "user.*": effect } },
    event: "user",
    expected: true,
    matched: ["(root).on.user.*"],
  },
  {
    name: "prefix token boundary",
    config: { on: { "user.*": effect } },
    event: "users.save",
    expected: false,
    matched: [],
  },
  {
    name: "longest wildcard wins",
    config: { on: { "*": effect, "user.*": effect, "user.profile.*": {} } },
    event: "user.profile.save",
    expected: false,
    matched: [],
    blocked: ["(root).on.user.profile.*"],
  },
  {
    name: "exact masks wildcard",
    config: { on: { "*": effect, GO: {} } },
    event: "GO",
    expected: false,
    matched: [],
    blocked: ["(root).on.GO"],
  },
  {
    name: "exact masks partial wildcard",
    config: { on: { "user.*": {}, "user.save": effect } },
    event: "user.save",
    expected: true,
    matched: ["(root).on.user.save"],
  },
  {
    name: "child masks root",
    config: {
      on: { GO: effect },
      initial: "idle",
      states: { idle: { on: { GO: {} } } },
    },
    event: "GO",
    expected: false,
    matched: [],
    blocked: ["idle.on.GO"],
  },
  {
    name: "child wildcard masks parent exact",
    config: {
      on: { GO: effect },
      initial: "idle",
      states: { idle: { on: { "*": {} } } },
    },
    event: "GO",
    expected: false,
    matched: [],
    blocked: ["idle.on.*"],
  },
  {
    name: "parent fallback",
    config: { on: { "user.*": effect }, initial: "idle", states: { idle: {} } },
    event: "user.save",
    expected: true,
    matched: ["(root).on.user.*"],
  },
  {
    name: "nested parent fallback",
    config: {
      initial: "panel",
      states: {
        panel: { initial: "open", states: { open: {} }, on: { GO: effect } },
      },
    },
    event: "GO",
    expected: true,
    matched: ["panel.on.GO"],
  },
  {
    name: "nested child preempts parent",
    config: {
      initial: "panel",
      states: {
        panel: {
          initial: "open",
          states: { open: { on: { GO: effect } } },
          on: { GO: effect },
        },
      },
    },
    event: "GO",
    expected: true,
    matched: ["panel.open.on.GO"],
  },
  {
    name: "undefined is forbidden",
    config: {
      initial: "idle",
      on: { GO: effect },
      states: { idle: { on: { GO: undefined } } },
    },
    event: "GO",
    expected: false,
    matched: [],
    blocked: ["idle.on.GO"],
  },
  {
    name: "empty target is forbidden",
    config: { on: { GO: { target: "" } } },
    event: "GO",
    expected: false,
    matched: [],
    blocked: ["(root).on.GO"],
  },
  {
    name: "empty action list is forbidden",
    config: { on: { GO: { actions: [] } } },
    event: "GO",
    expected: false,
    matched: [],
    blocked: ["(root).on.GO"],
  },
  {
    name: "action-only transition",
    config: { on: { GO: effect } },
    event: "GO",
    expected: true,
    matched: ["(root).on.GO"],
  },
  {
    name: "explicit empty target array follows snapshot.can",
    config: { on: { GO: { target: [] } } },
    event: "GO",
    expected: true,
    matched: ["(root).on.GO"],
  },
  {
    name: "first unguarded alternative masks later handler",
    config: { on: { GO: [{}, effect] } },
    event: "GO",
    expected: false,
    matched: [],
    blocked: ["(root).on.GO"],
  },
  {
    name: "first unguarded handler masks later guard",
    config: { on: { GO: [effect, { guard: "reject" }] } },
    event: "GO",
    expected: true,
    matched: ["(root).on.GO"],
  },
  {
    name: "parallel handlers",
    config: {
      type: "parallel",
      states: { left: { on: { GO: effect } }, right: { on: { GO: effect } } },
    },
    event: "GO",
    expected: true,
    matched: ["left.on.GO", "right.on.GO"],
  },
  {
    name: "parallel forbidden region does not block sibling",
    config: {
      type: "parallel",
      states: { left: { on: { GO: {} } }, right: { on: { GO: effect } } },
    },
    event: "GO",
    expected: true,
    matched: ["right.on.GO"],
    blocked: ["left.on.GO"],
  },
  {
    name: "parallel forbidden prevents parent fallback",
    config: {
      type: "parallel",
      on: { GO: effect },
      states: { left: { on: { GO: {} } }, right: {} },
    },
    event: "GO",
    expected: false,
    matched: [],
    blocked: ["left.on.GO"],
  },
  {
    name: "parallel all regions fall back",
    config: {
      type: "parallel",
      on: { GO: effect },
      states: { left: {}, right: {} },
    },
    event: "GO",
    expected: true,
    matched: ["(root).on.GO"],
  },
  {
    name: "active parallel final region can fall back",
    config: {
      type: "parallel",
      on: { GO: effect },
      states: {
        left: { initial: "done", states: { done: { type: "final" } } },
        right: {},
      },
    },
    event: "GO",
    expected: true,
    matched: ["(root).on.GO"],
  },
];

function check(
  definition: unknown,
  snapshot: { value?: unknown; status?: string } | undefined,
  event = "GO",
) {
  const store = new ActorStore(100, new Logger("error"));
  store.registerActor({
    type: "@xstate.actor",
    sessionId: "actor",
    definition,
    snapshot: snapshot as Record<string, unknown> | undefined,
    createdAt: new Date().toISOString(),
  });
  return canHandleEvent(store, "actor", event).structuredContent as Record<
    string,
    unknown
  >;
}

// Preserve guards while serializing; plain JSON drops inline functions. These
// markers are evidence for the static tool and are never evaluated by it.
function serialized(definition: unknown) {
  return JSON.parse(
    JSON.stringify(definition, (key, value) =>
      key === "toJSON"
        ? undefined
        : typeof value === "function"
          ? "[function]"
          : value,
    ),
  );
}

const producers = [
  [
    "5.28.0",
    (config: Config) =>
      createActor(
        createMachine(config, {
          actions: { effect: () => {} },
          guards: { reject: () => false },
        }),
      ),
  ],
  [
    "5.32.6",
    (config: Config) =>
      current.createActor(
        current.createMachine(config, {
          actions: { effect: () => {} },
          guards: { reject: () => false },
        }),
      ),
  ],
] as const;

describe.each(producers)(
  "static XState %s semantics",
  (_version, makeActor) => {
    it.each(cases)(
      "$name",
      ({ config, event, expected, matched, blocked = [] }) => {
        const actor = makeActor(config).start();
        try {
          const snapshot = actor.getSnapshot();
          expect(snapshot.status).toBe("active");
          expect(snapshot.can({ type: event })).toBe(expected);
          for (const definition of [config, serialized(actor.logic.toJSON())]) {
            const result = check(definition, snapshot, event);
            expect(result.canHandle).toBe(expected);
            expect(result.matchedTransitions).toEqual(matched);
            expect(result.blockedTransitions).toEqual(blocked);
            expect(result.analysis).toBe("static");
          }
        } finally {
          actor.stop();
        }
      },
    );

    it.each([true, false])(
      "leaves guard result %s unknown without executing it",
      (allowed) => {
        let calls = 0;
        const config: Config = {
          on: {
            GO: [
              {
                guard: () => {
                  calls++;
                  return allowed;
                },
                actions: "effect",
              },
              {},
            ],
          },
        };
        const actor = makeActor(config).start();
        try {
          expect(actor.getSnapshot().can({ type: "GO" })).toBe(allowed);
          calls = 0;
          for (const definition of [config, serialized(actor.logic.toJSON())]) {
            expect(check(definition, actor.getSnapshot())).toMatchObject({
              canHandle: null,
              reason: "guard_not_evaluated",
              analysis: "static",
            });
          }
          expect(calls).toBe(0);
        } finally {
          actor.stop();
        }
      },
    );

    it("does not claim a completed actor can act even if snapshot.can is true", () => {
      const config: Config = {
        initial: "done",
        on: { GO: ".done" },
        states: { done: { type: "final" } },
      };
      const actor = makeActor(config).start();
      try {
        expect(actor.getSnapshot().status).toBe("done");
        expect(actor.getSnapshot().can({ type: "GO" })).toBe(true);
        expect(
          check(serialized(actor.logic.toJSON()), actor.getSnapshot()),
        ).toMatchObject({ canHandle: false, reason: "actor_inactive" });
        const before = actor.getSnapshot();
        actor.send({ type: "GO" });
        expect(actor.getSnapshot()).toBe(before);
      } finally {
        actor.stop();
      }
    });
  },
);

it("reports version-dependent empty exact lists as unknown", () => {
  const config: Config = { on: { GO: [], "*": effect } };
  const old = producers[0][1](config).start();
  const latest = producers[1][1](config).start();
  try {
    expect(old.getSnapshot().can({ type: "GO" })).toBe(false);
    expect(latest.getSnapshot().can({ type: "GO" })).toBe(true);
    expect(check(config, old.getSnapshot())).toMatchObject({
      canHandle: null,
      reason: "version_dependent",
    });
  } finally {
    old.stop();
    latest.stop();
  }
});

describe("incomplete evidence", () => {
  it("bounds cyclic inspection definitions", () => {
    const definition: Record<string, unknown> = {};
    definition.states = { child: definition };
    const value: Record<string, unknown> = {};
    value.child = value;
    expect(check(definition, { status: "active", value })).toMatchObject({
      canHandle: null,
      reason: "definition_incomplete",
    });
  });
  it("ignores inherited event handlers", () => {
    expect(
      check(
        { on: Object.create({ GO: effect }) },
        { status: "active", value: {} },
      ),
    ).toMatchObject({ canHandle: false, reason: "no_transition" });
  });

  it.each([
    undefined,
    null,
    {},
    { id: "truncated" },
    [],
    { states: null },
    { states: { other: {} } },
  ])("definition %j", (definition) => {
    expect(
      check(definition, { status: "active", value: "idle" }).canHandle,
    ).toBeNull();
  });
  it.each([
    undefined,
    { status: "active" },
    { status: "active", value: null },
    { status: "unknown", value: "idle" },
  ])("snapshot %j", (snapshot) => {
    expect(check({ states: { idle: {} } }, snapshot).canHandle).toBeNull();
  });
  it("does not invent the initial child for a partial snapshot", () => {
    expect(
      check(
        {
          initial: "parent",
          states: {
            parent: {
              initial: "child",
              states: { child: { on: { GO: effect } } },
            },
          },
        },
        { status: "active", value: "parent" },
      ).canHandle,
    ).toBeNull();
  });
  it("requires all parallel regions", () => {
    expect(
      check(
        {
          type: "parallel",
          states: { left: {}, right: { on: { GO: effect } } },
        },
        { status: "active", value: { left: {} } },
      ).canHandle,
    ).toBeNull();
  });
  it("requires on/states on serialized nodes", () => {
    const actor = createActor(createMachine({ on: { GO: effect } })).start();
    const definition = serialized(actor.logic.toJSON());
    delete definition.on;
    expect(check(definition, actor.getSnapshot()).canHandle).toBeNull();
    actor.stop();
  });
  it.each([null, 42, { target: 42 }, { actions: 42 }, [null]])(
    "malformed selected transition %j",
    (GO) => {
      expect(
        check({ on: { GO } }, { status: "active", value: {} }).canHandle,
      ).toBeNull();
    },
  );
  it("does not interpret the empty event type as always", () => {
    expect(
      check({ always: effect, on: {} }, { status: "active", value: {} }, ""),
    ).toMatchObject({ canHandle: null, reason: "unsupported_event" });
  });
  it.each(["stopped", "error"])("inactive %s snapshot", (status) => {
    expect(check({ on: { GO: effect } }, { status, value: {} })).toMatchObject({
      canHandle: false,
      reason: "actor_inactive",
    });
  });
});
