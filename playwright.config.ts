import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./.tmp/playwright-test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.PLUGINMAX_WEB_BASE_URL ?? "http://127.0.0.1:4411",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
