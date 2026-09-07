import { createActor, type ActorRefFrom } from "xstate";
import { workspaceMachine, documentMachine } from "./model.js";
import { createDemoInspector, type ConnectionState } from "./demo-inspector.js";
import "./style.css";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}
const title = element<HTMLInputElement>("title");
const body = element<HTMLTextAreaElement>("body");
const save = element<HTMLButtonElement>("save");
const retry = element<HTMLButtonElement>("retry");
const connectionToggle = element<HTMLButtonElement>("connection-toggle");
let paused = false;
function showConnection(state: ConnectionState) {
  element("connection-label").textContent = `Inspection ${state}`;
  element("connection-dot").dataset.state = state;
}
const inspector = import.meta.env.DEV
  ? createDemoInspector(showConnection)
  : undefined;
const workspace = createActor(workspaceMachine, {
  id: "workspace",
  ...(inspector ? { inspect: inspector.inspect } : {}),
});
workspace.start(); // Intentionally starts before the WebSocket connects.
const documentActor = workspace.system.get("document") as ActorRefFrom<
  typeof documentMachine
>;
const listeners = new AbortController();
const subscription = documentActor.subscribe((snapshot) => {
  const state = String(snapshot.value);
  const context = snapshot.context;
  if (title.value !== context.title) title.value = context.title;
  if (body.value !== context.body) body.value = context.body;
  const busy = snapshot.matches("loading") || snapshot.matches("saving");
  title.disabled = busy;
  body.disabled = busy;
  save.disabled = !snapshot.can({ type: "SAVE" });
  save.innerHTML = snapshot.matches("saving")
    ? 'Saving <span aria-hidden="true">↻</span>'
    : 'Save note <span aria-hidden="true">↗</span>';
  element("title-count").textContent = `${context.title.length} / 120`;
  element("preview-title").textContent = context.title || "Your next good idea";
  element("preview-body").textContent =
    context.body || "Your story will appear here.";
  element("error-panel").hidden =
    !snapshot.matches("error") && !snapshot.matches("loadError");
  element("error-message").textContent = context.error ?? "";
  retry.disabled = !snapshot.can({ type: "RETRY" });
  element("success-panel").hidden = !snapshot.matches("saved");
  const labels: Record<string, string> = {
    loading: "Loading draft",
    editing: "Unsaved changes",
    saving: "Saving your note",
    saved: "All changes saved",
    error: "Save needs a retry",
    loadError: "Load needs a retry",
  };
  element("draft-status").textContent = labels[state] ?? state;
  element("draft-status").dataset.state = state;
  element("save-detail").textContent = snapshot.matches("saved")
    ? `Revision ${context.revision} · saved in memory`
    : snapshot.matches("saving")
      ? "Sending to the local demo service…"
      : "Unsaved draft · local demo";
  element("actor-state").textContent = `document · ${state}`;
  element("attempt-count").textContent =
    `${context.attempts} save ${context.attempts === 1 ? "attempt" : "attempts"}`;
});

title.addEventListener(
  "input",
  () => documentActor.send({ type: "CHANGE_TITLE", value: title.value }),
  { signal: listeners.signal },
);
body.addEventListener(
  "input",
  () => documentActor.send({ type: "CHANGE_BODY", value: body.value }),
  { signal: listeners.signal },
);
save.addEventListener("click", () => documentActor.send({ type: "SAVE" }), {
  signal: listeners.signal,
});
retry.addEventListener("click", () => documentActor.send({ type: "RETRY" }), {
  signal: listeners.signal,
});
connectionToggle.addEventListener(
  "click",
  () => {
    paused = !paused;
    if (paused) inspector?.pause();
    else inspector?.resume();
    connectionToggle.textContent = paused
      ? "Reconnect inspection"
      : "Disconnect inspection";
  },
  { signal: listeners.signal },
);
if (inspector) inspector.connect();
else {
  showConnection("disconnected");
  connectionToggle.hidden = true;
  element("connection-label").textContent = "Inspection disabled in production";
}

function dispose() {
  listeners.abort();
  subscription.unsubscribe();
  inspector?.dispose();
  workspace.stop();
}
window.addEventListener("pagehide", dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
