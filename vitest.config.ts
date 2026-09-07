import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/fixtures/build-cli.ts"],
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10000,
  },
});
