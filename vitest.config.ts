import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@pluginmax/contracts": resolve(
        import.meta.dirname,
        "packages/contracts/src/index.ts",
      ),
      "@pluginmax/shared": resolve(
        import.meta.dirname,
        "packages/shared/src/index.ts",
      ),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "plugins/*/src/**/*.test.ts"],
  },
});
