import { test, expect } from "./harness.js";
import { preview } from "vite";
import { resolve } from "node:path";
const revisedTitle = "A calmer place for your next idea";

test("persisted pagehide keeps the editor live until ordinary pagehide disposes it", async ({
  page,
  demo,
}) => {
  await page.goto(demo.url);
  const { document } = await demo.discover("cached-tab");
  await demo.waitState(document.sessionId, "editing");
  for (const title of [
    "Draft after first restore",
    "Draft after second restore",
  ]) {
    await page.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    });
    await page.getByLabel("TITLE", { exact: true }).fill(title);
    await expect(page.locator("#preview-title")).toHaveText(title);
    await expect
      .poll(
        async () =>
          (
            await demo.call("get_actor_state", {
              sessionId: document.sessionId,
            })
          ).context,
      )
      .toMatchObject({ title });
  }
  demo.record("browser-lifecycle", {
    observation:
      "Synthetic persisted pagehide/pageshow pairs retain the same live actor and editable draft",
  });
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: false }),
    );
  });
  await expect.poll(async () => (await demo.actors()).length).toBe(0);
  await page.close();
});

test("real MCP loop: inspect, fail, reject, retry, and verify the UI", async ({
  page,
  demo,
}, info) => {
  const frames: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => frames.push(String(frame.payload))),
  );
  await page.goto(demo.url);
  await expect(page.getByLabel("TITLE", { exact: true })).toHaveValue(
    "A little room for good ideas",
  );
  await expect(page.locator("#connection-label")).toHaveText(
    "Inspection connected",
  );
  const { root, document } = await demo.discover("tab-1");
  expect((await demo.call("get_actor_tree")).tree).toMatchObject([
    {
      sessionId: root.sessionId,
      children: [{ sessionId: document.sessionId }],
    },
  ]);
  for (const sessionId of [root.sessionId, document.sessionId])
    expect(
      (await demo.call("get_machine_definition", { sessionId })).definition,
    ).toHaveProperty("states");
  await demo.waitState(document.sessionId, "editing");
  await demo.screenshot(
    page,
    info.outputPath("01-editor.png"),
    "Loaded document actor matches editable UI",
  );
  await page.getByLabel("TITLE", { exact: true }).fill(revisedTitle);
  await expect(page.locator("#preview-title")).toHaveText(revisedTitle);
  demo.record("browser-action", { action: "Edit title", value: revisedTitle });
  const baseline = await demo.call("get_actor_state", {
    sessionId: document.sessionId,
  });
  expect(
    await demo.call("can_handle_event", {
      sessionId: document.sessionId,
      eventType: "SAVE",
    }),
  ).toMatchObject({
    canHandle: null,
    reason: expect.any(String),
  });
  expect(
    (
      await demo.call("send_event", {
        target: document.sessionId,
        event: { type: "SAVE" },
      })
    ).success,
  ).toBe(true);
  await demo.waitEvent(document.sessionId, "SAVE", baseline.cursor);
  const failure = await demo.waitState(
    document.sessionId,
    "error",
    baseline.cursor,
  );
  expect(failure.context).toMatchObject({
    title: revisedTitle,
    attempts: 1,
    saved: null,
  });
  await expect(page.getByRole("alert")).toContainText(
    "Your draft hasn’t been saved yet",
  );
  await expect(page.getByLabel("TITLE", { exact: true })).toHaveValue(
    revisedTitle,
  );
  await demo.screenshot(
    page,
    info.outputPath("02-save-error.png"),
    "MCP confirms failed save; draft and retry remain visible",
  );
  expect(
    (
      await demo.call(
        "send_event",
        { target: document.sessionId, event: { type: "DELETE_EVERYTHING" } },
        true,
      )
    ).success,
  ).toBe(false);
  expect(
    (await demo.waitState(document.sessionId, "error")).context,
  ).toMatchObject({ attempts: 1 });
  expect(
    (
      await demo.call("send_event", {
        target: document.sessionId,
        event: { type: "RETRY" },
      })
    ).success,
  ).toBe(true);
  await demo.waitEvent(document.sessionId, "RETRY", failure.cursor);
  const saved = await demo.waitState(
    document.sessionId,
    "saved",
    failure.cursor,
  );
  expect(saved.context).toMatchObject({
    title: revisedTitle,
    attempts: 2,
    revision: 1,
    saved: { title: revisedTitle },
  });
  await expect(page.locator("#success-panel")).toContainText(
    "Saved. Ready for what’s next",
  );
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.locator("#draft-status")).toHaveText("All changes saved");
  await demo.screenshot(
    page,
    info.outputPath("03-recovered.png"),
    "Retry accepted through MCP; saved snapshot and rendered success agree",
  );
  const history = await demo.call("get_event_history", {
    sessionId: document.sessionId,
    limit: 50,
  });
  expect(
    (history.events as { event: { type: string } }[]).map(
      (record) => record.event.type,
    ),
  ).toEqual(expect.arrayContaining(["CHANGE_TITLE", "SAVE", "RETRY"]));
  expect(
    JSON.stringify(
      await demo.call("get_state_timeline", { sessionId: document.sessionId }),
    ),
  ).toContain('"saved"');
  const resource = await demo.client.readResource({
    uri: `xstate://actor/${document.sessionId}/snapshot`,
  });
  demo.record("resource", { result: resource });
  expect(JSON.stringify(resource)).toContain(revisedTitle);
  const prompt = await demo.client.getPrompt({
    name: "debug_actor",
    arguments: { sessionId: document.sessionId },
  });
  demo.record("prompt", { name: "debug_actor", result: prompt });
  expect(JSON.stringify(prompt)).toContain(revisedTitle);
  expect(frames.join("\n")).not.toContain("fixture-only-never-transfer-17");
  expect(JSON.stringify(demo.rows)).not.toContain(
    "fixture-only-never-transfer-17",
  );
  expect(pageErrors).toEqual([]);
  await page.close();
  await expect.poll(async () => (await demo.actors()).length).toBe(0);
});

test("refresh, reconnect and two tabs keep actor state isolated", async ({
  page,
  context,
  demo,
}, info) => {
  await page.goto(demo.url);
  const first = await demo.discover("tab-1");
  await demo.waitState(first.document.sessionId, "editing");
  await page
    .getByLabel("TITLE", { exact: true })
    .fill("Kept while inspection reconnects");
  await page
    .getByRole("button", { name: "Disconnect inspection", exact: true })
    .click();
  await expect.poll(async () => (await demo.actors()).length).toBe(0);
  await page
    .getByLabel("TITLE", { exact: true })
    .fill("Edited while disconnected");
  await page
    .getByRole("button", { name: "Reconnect inspection", exact: true })
    .click();
  const reconnected = await demo.discover("tab-1-reconnected");
  expect(reconnected.document.sessionId).not.toBe(first.document.sessionId);
  expect(reconnected.document.connectionId).not.toBe(
    first.document.connectionId,
  );
  expect(
    (await demo.waitState(reconnected.document.sessionId, "editing")).context,
  ).toMatchObject({ title: "Edited while disconnected" });
  await demo.screenshot(
    page,
    info.outputPath("04-reconnected.png"),
    "Live actors replay their latest snapshot after reconnect",
  );
  await page.reload();
  await expect
    .poll(async () =>
      (await demo.actors()).some(
        (a) => a.sessionId === reconnected.document.sessionId,
      ),
    )
    .toBe(false);
  const refreshed = await demo.discover("tab-1-refreshed");
  expect(
    (await demo.waitState(refreshed.document.sessionId, "editing")).context,
  ).toMatchObject({ title: "A little room for good ideas", attempts: 0 });
  const secondPage = await context.newPage();
  await secondPage.goto(demo.url);
  const second = await demo.discover("tab-2", [
    refreshed.root.sessionId,
    refreshed.document.sessionId,
  ]);
  expect(second.document.connectionId).not.toBe(
    refreshed.document.connectionId,
  );
  await demo.waitState(second.document.sessionId, "editing");
  expect(second.document.sessionId).not.toBe(refreshed.document.sessionId);
  expect(
    (
      await demo.call(
        "send_event",
        { target: "document", event: { type: "SAVE" } },
        true,
      )
    ).isError,
  ).toBe(true);
  await secondPage.getByLabel("TITLE", { exact: true }).focus();
  await demo.call("send_event", {
    target: second.document.sessionId,
    event: { type: "CHANGE_TITLE", value: "Only the second tab changes" },
  });
  await expect(secondPage.getByLabel("TITLE", { exact: true })).toHaveValue(
    "Only the second tab changes",
  );
  await expect(page.getByLabel("TITLE", { exact: true })).toHaveValue(
    "A little room for good ideas",
  );
  await demo.screenshot(
    secondPage,
    info.outputPath("05-second-tab.png"),
    "Exact actor target changes only the second tab",
  );
  await secondPage.close();
  await expect.poll(async () => (await demo.actors()).length).toBe(2);
  expect((await demo.actors()).map((a) => a.sessionId)).toContain(
    refreshed.document.sessionId,
  );
  await page.close();
  await expect.poll(async () => (await demo.actors()).length).toBe(0);
});

test("mobile recovery works through visible controls and production has no inspector", async ({
  page,
  demo,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(demo.url);
  const { document } = await demo.discover("mobile");
  await demo.waitState(document.sessionId, "editing");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Try saving again" }).click();
  await demo.waitState(document.sessionId, "saved");
  await expect(page.locator("#success-panel")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await demo.screenshot(
    page,
    info.outputPath("06-mobile.png"),
    "Visible retry control also recovers on a narrow viewport",
  );
  const context = page.context();
  await page.close();
  const production = await preview({
    root: resolve(import.meta.dirname, ".."),
    configFile: false,
    preview: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  try {
    const address = production.httpServer.address();
    if (!address || typeof address === "string")
      throw new Error("No production port");
    const prodPage = await context.newPage();
    const sockets: string[] = [];
    prodPage.on("websocket", (socket) => sockets.push(socket.url()));
    await prodPage.goto(`http://127.0.0.1:${address.port}`);
    await expect(prodPage.getByLabel("TITLE", { exact: true })).toHaveValue(
      "A little room for good ideas",
    );
    await expect(prodPage.locator("#connection-label")).toHaveText(
      "Inspection disabled in production",
    );
    expect(sockets).toEqual([]);
    demo.record("production", {
      observation: "Built frontend loads without any WebSocket instrumentation",
    });
    await prodPage.close();
  } finally {
    await new Promise<void>((resolve, reject) =>
      production.httpServer.close((error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
});
