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
    zod: fileURLToPath(
      new URL("../../packages/shared/node_modules/zod/index.js", import.meta.url),
    ),
  },
  deps: {
    alwaysBundle: [/^@pluginmax\//, /^zod$/],
    dts: { neverBundle: ["zod"] },
  },
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  outDir: "lib",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
