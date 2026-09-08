import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { finishDemoRun } from "./teardown.js";

test("cleanup failures and unavailable provenance still produce a transcript", async ({}, info) => {
  const attempts: string[] = [];
  const file = info.outputPath("failure-transcript.json");
  const teardown = await finishDemoRun({
    closeClient: async () => {
      attempts.push("client");
      throw new Error("Client close failed");
    },
    closeTransport: async () => {
      attempts.push("transport");
    },
    closeVite: async () => {
      attempts.push("vite");
      throw new Error("Vite close failed");
    },
    probePort: async () => {
      attempts.push("probe");
      throw new Error("EADDRINUSE");
    },
    sourceCommit: () => {
      throw new Error("git unavailable");
    },
    writeTranscript: async (observations) => {
      attempts.push("transcript");
      await writeFile(file, JSON.stringify(observations));
    },
  });
  expect(attempts).toEqual([
    "client",
    "transport",
    "vite",
    "probe",
    "transcript",
  ]);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    cleanup: {
      client: { status: "rejected", error: "Client close failed" },
      transport: { status: "fulfilled" },
      vite: { status: "rejected", error: "Vite close failed" },
    },
    portReleased: false,
    portProbe: { status: "rejected", error: "EADDRINUSE" },
    sourceCommit: { status: "rejected", error: "git unavailable" },
  });
  expect(teardown.portReleased).toBe(false);
});
