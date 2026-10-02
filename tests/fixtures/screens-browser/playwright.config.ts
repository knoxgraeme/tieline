import { defineConfig } from "@playwright/test";

const port = Number(process.env.ACME_NOTES_PORT ?? "4317");

export default defineConfig({
  testDir: "e2e",
  // Playwright's default only matches *.spec and *.test files.
  testMatch: ["**/*.spec.ts", "**/*.screens.ts"],
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 800, height: 600 },
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "node serve.mjs",
    url: `http://127.0.0.1:${port}/notes`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "screens",
      use: {
        browserName: "chromium",
        ...(process.env.TIELINE_BROWSER_CHANNEL ? { channel: process.env.TIELINE_BROWSER_CHANNEL } : {}),
      },
    },
  ],
});
