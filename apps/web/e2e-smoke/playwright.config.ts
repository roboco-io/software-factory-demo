import { defineConfig, devices } from "@playwright/test";

// 프로덕션 읽기 전용 스모크 전용 설정. 로컬 서버를 띄우지 않고 E2E_BASE_URL만 검사한다.
const raw = process.env.E2E_BASE_URL;
if (!raw) throw new Error("E2E_BASE_URL is required for the production smoke");
const baseURL = raw.endsWith("/") ? raw : `${raw}/`;

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 1,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
