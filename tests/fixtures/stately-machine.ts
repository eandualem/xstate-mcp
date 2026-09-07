import { assign, createMachine, sendTo, setup } from "xstate";

const workerMachine = createMachine({
  id: "workerMachine",
  context: { count: 0 },
  initial: "idle",
  states: {
    idle: {
      on: {
        PING: {
          target: "working",
          actions: assign({ count: ({ context }) => context.count + 1 }),
        },
      },
    },
    working: {},
  },
});

export const statelyMachine = setup({
  actors: { worker: workerMachine },
}).createMachine({
  id: "inspectionFixture",
  initial: "running",
  states: {
    running: {
      invoke: { id: "worker", src: "worker" },
      on: {
        PING: {
          actions: sendTo("worker", { type: "PING", message: "from parent" }),
        },
      },
    },
  },
});
