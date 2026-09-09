import { defineConfig, devices } from '@playwright/test'

// e2e 使用 dev:mock，由浏览器 MSW 提供后端响应。
const PORT = 3014
const BASE_URL = `http://127.0.0.1:${PORT}`
const CI = Boolean(process.env['CI'])

export default defineConfig({
  forbidOnly: CI,
  fullyParallel: true,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: CI ? 'github' : 'list',
  retries: CI ? 1 : 0,
  testDir: 'e2e',
  use: { baseURL: BASE_URL, trace: 'on-first-retry' },
  webServer: {
    command: 'pnpm dev:mock',
    reuseExistingServer: !CI,
    timeout: 60_000,
    url: BASE_URL,
  },
})
