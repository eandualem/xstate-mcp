import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/inspection-policy.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
});
