import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  dts: true,
  format: "esm",
  outDir: "lib",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  external: ["@pluginmax/shared", "zod"],
});
