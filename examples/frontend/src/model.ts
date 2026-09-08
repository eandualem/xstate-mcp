import { assign, fromPromise, setup } from "xstate";

export interface Draft {
  title: string;
  body: string;
}
export interface DocumentContext extends Draft {
  saved: Draft | null;
  attempts: number;
  revision: number;
  error: string | null;
  // Deliberate fixture secret: inspection must never transfer this raw value.
  draftAccessToken: string;
}
export type DocumentEvent =
  | { type: "CHANGE_TITLE"; value: string }
  | { type: "CHANGE_BODY"; value: string }
  | { type: "SAVE" }
  | { type: "RETRY" };

const initialDraft = {
  title: "A little room for good ideas",
  body: "Today, we’re introducing a calmer place to collect your thoughts.\n\nStart with a small idea. Give it a clear title. Make something worth sharing.",
};

function delay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Demo service cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export const documentMachine = setup({
  types: { context: {} as DocumentContext, events: {} as DocumentEvent },
  actors: {
    loadDraft: fromPromise<Draft>(async ({ signal }) => {
      await delay(signal, 180);
      return initialDraft;
    }),
    saveDraft: fromPromise<Draft, Draft & { attempt: number }>(
      async ({ input, signal }) => {
        await delay(signal, 350);
        if (input.attempt === 1)
          throw new Error("Intentional deterministic demo failure");
        return { title: input.title, body: input.body };
      },
    ),
  },
  guards: { hasTitle: ({ context }) => context.title.trim().length > 0 },
  actions: {
    changeTitle: assign({
      title: ({ event, context }) =>
        event.type === "CHANGE_TITLE" ? event.value : context.title,
      error: null,
    }),
    changeBody: assign({
      body: ({ event, context }) =>
        event.type === "CHANGE_BODY" ? event.value : context.body,
      error: null,
    }),
  },
}).createMachine({
  id: "document",
  initial: "loading",
  context: {
    title: "",
    body: "",
    saved: null,
    attempts: 0,
    revision: 0,
    error: null,
    draftAccessToken: "fixture-only-never-transfer-17",
  },
  states: {
    loading: {
      invoke: {
        id: "loadDraft",
        src: "loadDraft",
        onDone: {
          target: "editing",
          actions: assign(({ event }) => event.output),
        },
        onError: {
          target: "loadError",
          actions: assign({
            error: "The demo draft could not load. Try again.",
          }),
        },
      },
    },
    loadError: { on: { RETRY: "loading" } },
    editing: {
      on: {
        CHANGE_TITLE: { actions: "changeTitle" },
        CHANGE_BODY: { actions: "changeBody" },
        SAVE: { target: "saving", guard: "hasTitle" },
      },
    },
    saving: {
      entry: assign({
        attempts: ({ context }) => context.attempts + 1,
        error: null,
      }),
      invoke: {
        id: "saveDraft",
        src: "saveDraft",
        input: ({ context }) => ({
          title: context.title,
          body: context.body,
          attempt: context.attempts,
        }),
        onDone: {
          target: "saved",
          actions: assign({
            saved: ({ event }) => event.output,
            revision: ({ context }) => context.revision + 1,
            error: null,
          }),
        },
        onError: {
          target: "error",
          actions: assign({
            error:
              "The demo service declined this save. Your draft is still here.",
          }),
        },
      },
    },
    error: {
      on: {
        RETRY: "saving",
        CHANGE_TITLE: { target: "editing", actions: "changeTitle" },
        CHANGE_BODY: { target: "editing", actions: "changeBody" },
      },
    },
    saved: {
      on: {
        CHANGE_TITLE: { target: "editing", actions: "changeTitle" },
        CHANGE_BODY: { target: "editing", actions: "changeBody" },
      },
    },
  },
});

export const workspaceMachine = setup({
  actors: { document: documentMachine },
}).createMachine({
  id: "workspace",
  initial: "open",
  states: {
    open: { invoke: { id: "document", src: "document", systemId: "document" } },
  },
});
