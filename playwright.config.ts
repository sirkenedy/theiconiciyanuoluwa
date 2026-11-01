import { defineConfig, devices } from '@playwright/test';

const PORT = 4323;
const REDIS_PORT = 4329;
const CLAUDE_PORT = 4331;
// A second Career Coach server: Cloudflare's official always-pass Turnstile test keys and a $0 budget (breather state).
const LOCKED_PORT = 4325;
const LOCKED_REDIS = 4330;

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  reporter: 'list',
  // Motion and physics tests are timing-sensitive; more workers starve them of CPU.
  workers: 2,
  use: { baseURL: `http://localhost:${PORT}`, ...devices['Desktop Chrome'] },
  // The Career Coach specs share one fake Claude (and its request log, which each test resets) and one fake Redis, so
  // they run one at a time; everything else stays parallel.
  projects: [
    { name: 'site', testIgnore: /career\..*\.spec\.ts/ },
    { name: 'career', testMatch: /career\..*\.spec\.ts/, workers: 1 },
  ],
  // Career Coach routes run through the built Vercel function against an in-memory Upstash and a fake Claude API
  // (tests/fake-upstash.mjs, tests/fake-claude.mjs): no key, no network, no cost.
  webServer: [
    {
      command: `node tests/fake-upstash.mjs ${REDIS_PORT}`,
      port: REDIS_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `node tests/fake-claude.mjs ${CLAUDE_PORT}`,
      port: CLAUDE_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `node tests/fake-upstash.mjs ${LOCKED_REDIS}`,
      port: LOCKED_REDIS,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `PORT=${LOCKED_PORT} PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000BB TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA CAREER_DAILY_BUDGET_USD=0 ANTHROPIC_API_KEY=test-key ANTHROPIC_BASE_URL=http://127.0.0.1:${CLAUDE_PORT} UPSTASH_REDIS_REST_URL=http://localhost:${LOCKED_REDIS} UPSTASH_REDIS_REST_TOKEN=test-token node scripts/serve-static.mjs`,
      url: `http://localhost:${LOCKED_PORT}/career/privacy/`, // a static page: ready as soon as the server is
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `PORT=${PORT} ANTHROPIC_API_KEY=test-key ANTHROPIC_BASE_URL=http://127.0.0.1:${CLAUDE_PORT} UPSTASH_REDIS_REST_URL=http://localhost:${REDIS_PORT} UPSTASH_REDIS_REST_TOKEN=test-token node scripts/serve-static.mjs`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
