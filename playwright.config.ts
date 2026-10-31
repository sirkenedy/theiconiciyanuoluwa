import { defineConfig, devices } from '@playwright/test';

const PORT = 4323;

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  reporter: 'list',
  // Motion and physics tests are timing-sensitive; more workers starve them of CPU.
  workers: 2,
  use: { baseURL: `http://localhost:${PORT}`, ...devices['Desktop Chrome'] },
  webServer: {
    command: `PORT=${PORT} node scripts/serve-static.mjs`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
});
