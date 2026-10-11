import { defineConfig, devices } from "@playwright/test";

const external = process.env.E2E_BASE_URL;
const root = new URL("../..", import.meta.url).pathname;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: external ?? "http://localhost:4173/", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: external
    ? undefined
    : [
        {
          command:
            "rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply sfd-prod --local && pnpm exec wrangler dev --port 8787 --var JWT_SECRET:e2e-local",
          cwd: `${root}apps/api`,
          url: "http://localhost:8787/api/health",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "pnpm build && pnpm preview",
          cwd: `${root}apps/web`,
          env: { VITE_API_BASE: "http://localhost:8787/api" },
          url: "http://localhost:4173/",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
