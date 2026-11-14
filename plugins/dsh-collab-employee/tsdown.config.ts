import { defineConfig } from "tsdown";
import { fileURLToPath } from "node:url";

export default defineConfig({
  alias: {
    "@pluginmax/contracts": fileURLToPath(
      new URL("../../packages/contracts/src/index.ts", import.meta.url),
    ),
    "@pluginmax/shared": fileURLToPath(
      new URL("../../packages/shared/src/index.ts", import.meta.url),
    ),
  },
  deps: {
    alwaysBundle: [/^@pluginmax\//],
    neverBundle: ["zod"],
  },
  entry: ["src/index.ts"],
  dts: true,
  format: "esm",
  outDir: "lib",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
