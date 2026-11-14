import { defineConfig } from "@playwright/test";

const useSystemChrome = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "true";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./.tmp/playwright-test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.PLUGINMAX_WEB_BASE_URL ?? "http://127.0.0.1:4411",
    channel: useSystemChrome ? "chrome" : undefined,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
