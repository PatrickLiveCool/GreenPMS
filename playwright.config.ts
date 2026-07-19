import { defineConfig, devices } from "@playwright/test";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {})
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ],
  webServer: [
    {
      command: "npm run start -w @qintopia/api",
      url: "http://127.0.0.1:4100/health/ready",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: e2eDatabaseUrl,
        PORT: "4100",
        WEB_ORIGIN: "http://127.0.0.1:4173",
        LOG_LEVEL: "warn",
        LOGIN_RATE_LIMIT_MAX: "1000"
      }
    },
    {
      command: "npm run preview -w @qintopia/web -- --host 127.0.0.1",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
