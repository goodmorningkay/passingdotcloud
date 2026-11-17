import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: "./tests/e2e/setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        channel:
          process.env.PLAYWRIGHT_CHANNEL ||
          (process.platform === "win32" ? "chrome" : undefined),
      },
    },
    {
      name: "webkit-iphone",
      testMatch: ["pwa.spec.ts", "prefetch.spec.ts"],
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit",
      },
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${process.env.PASSING_E2E_WEB_PORT ?? "3000"}`,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    trace: "off",
    screenshot: "only-on-failure",
  },
});
