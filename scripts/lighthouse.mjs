// Lighthouse mobile (default Moto G Power + slow 4G simulation), 3 runs, median per metric.
import { mkdirSync, writeFileSync } from 'node:fs';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from '@playwright/test';
import { startServer } from './serve-static.mjs';

const RUNS = Number(process.env.LH_RUNS) || 3;
// /career registers a device on load: give it the in-memory Upstash fake (as production has Redis), no secrets needed.
const fakeRedis = (process.env.LH_PATH ?? '/').startsWith('/career') ? await (await import('../tests/fake-upstash.mjs')).startFakeUpstash() : null;
if (fakeRedis) Object.assign(process.env, { UPSTASH_REDIS_REST_URL: fakeRedis.url, UPSTASH_REDIS_REST_TOKEN: (await import('../tests/fake-upstash.mjs')).FAKE_TOKEN });
const server = await startServer(4322);
const url = `http://localhost:${server.address().port}${process.env.LH_PATH ?? '/'}`;
const chrome = await chromeLauncher.launch({
  chromePath: process.env.CHROME_PATH || chromium.executablePath(),
  chromeFlags: ['--headless=new', '--no-first-run'],
});

const runs = [];
try {
  for (let i = 0; i < RUNS; i++) {
    const { lhr } = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });
    runs.push(lhr);
  }
} finally {
  chrome.kill();
  server.close();
  fakeRedis?.server.close();
}

mkdirSync('reports', { recursive: true });
writeFileSync('reports/lighthouse-last.json', JSON.stringify(runs.at(-1)));

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const score = (id) => median(runs.map((r) => Math.round(r.categories[id].score * 100)));
const audit = (id) => median(runs.map((r) => r.audits[id].numericValue));

const rows = [
  ['Performance', '≥ 98', score('performance'), (v) => v >= 98],
  ['Accessibility', '100', score('accessibility'), (v) => v === 100],
  ['Best Practices', '100', score('best-practices'), (v) => v === 100],
  ['SEO', '100', score('seo'), (v) => v === 100],
  ['LCP', '≤ 1.8 s', audit('largest-contentful-paint'), (v) => v <= 1800, (v) => `${(v / 1000).toFixed(2)} s`],
  ['CLS', '≤ 0.02', audit('cumulative-layout-shift'), (v) => v <= 0.02, (v) => v.toFixed(3)],
  ['TBT', '≤ 100 ms', audit('total-blocking-time'), (v) => v <= 100, (v) => `${Math.round(v)} ms`],
  ['FCP', '—', audit('first-contentful-paint'), () => true, (v) => `${(v / 1000).toFixed(2)} s`],
];
console.log(`Lighthouse mobile ${process.env.LH_PATH ?? '/'}, median of ${RUNS}\n| Check | Budget | Result | Pass |\n|---|---|---|---|`);
for (const [name, budget, value, ok, fmt = String] of rows) console.log(`| ${name} | ${budget} | ${fmt(value)} | ${ok(value) ? '✅' : '❌'} |`);

const failing = runs.at(-1);
for (const cat of Object.values(failing.categories)) {
  for (const ref of cat.auditRefs) {
    const a = failing.audits[ref.id];
    if (ref.weight > 0 && a.score !== null && a.score < 1) console.log(`  ↳ ${cat.title}: ${a.title} (${a.displayValue ?? a.score})`);
  }
}
process.exit(rows.every(([, , v, ok]) => ok(v)) ? 0 : 1);
