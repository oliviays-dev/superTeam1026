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
      "@pluginmax/application": resolve(
        import.meta.dirname,
        "packages/application/src/index.ts",
      ),
      "@pluginmax/agent-runtime": resolve(
        import.meta.dirname,
        "packages/agent-runtime/src/index.ts",
      ),
      "@pluginmax/config": resolve(
        import.meta.dirname,
        "packages/config/src/index.ts",
      ),
      "@pluginmax/database": resolve(
        import.meta.dirname,
        "packages/database/src/index.ts",
      ),
      "@pluginmax/domain": resolve(
        import.meta.dirname,
        "packages/domain/src/index.ts",
      ),
      "@pluginmax/files": resolve(
        import.meta.dirname,
        "packages/files/src/index.ts",
      ),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
    ],
  },
});
