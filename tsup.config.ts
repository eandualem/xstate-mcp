import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
});
