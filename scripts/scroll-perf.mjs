// Scroll + interaction responsiveness under mobile-class CPU (4× throttle, 412×823).
// Wheel-scrolls the whole page while the choreography runs and interacts mid-animation, then reports
// INP (worst interaction, from Event Timing), long tasks and frame times. Exits non-zero on budget failure.
import { chromium } from '@playwright/test';
import { startServer } from './serve-static.mjs';

const CPU_THROTTLE = Number(process.env.CPU_THROTTLE) || 4;
const server = await startServer(4324);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75 });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

await page.addInitScript(() => {
  const w = window;
  w.__perf = { events: [], longTasks: [], frames: [] };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.interactionId) w.__perf.events.push({ id: e.interactionId, name: e.name, duration: e.duration });
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__perf.longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
  let last = 0;
  const tick = (t) => {
    if (last && w.__perf.recording) w.__perf.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForTimeout(1500);
const done = new Set();
await page.mouse.move(206, 500);
await page.evaluate(() => { window.__perf.recording = true; window.__perf.scrollStart = performance.now(); });
await page.locator('.obj--ring').click();
done.add('clay-tap');

const visible = async (selector) => {
  const box = await page.locator(selector).first().boundingBox();
  return box && box.y > 90 && box.y + box.height < 800 ? box : null;
};
const interactAt = async (key, selector, action) => {
  if (done.has(key) || !(await visible(selector))) return;
  done.add(key);
  await action();
};

for (let i = 0; i < 400; i++) {
  await page.mouse.wheel(0, 90);
  await page.waitForTimeout(16);
  await interactAt('chip', 'label[for="twin-q-2"]', () => page.locator('label[for="twin-q-2"]').click());
  await interactAt('details', '#exp-3 summary', () => page.locator('#exp-3 summary').click());
  await interactAt('reaction', '[data-rx="post-1:love"]', () => page.locator('[data-rx="post-1:love"]').click());
  await interactAt('theme', '#blog .post', () => page.locator('[data-theme-toggle]').click());
  await interactAt('theme-back', '#resume .paper', () => page.locator('[data-theme-toggle]').click());
  const atEnd = await page.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 2);
  if (atEnd) break;
}
await page.evaluate(() => { window.__perf.recording = false; window.__perf.scrollEnd = performance.now(); });
await page.getByRole('button', { name: 'Open menu' }).click();
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

const perf = await page.evaluate(() => window.__perf);
await browser.close();
server.close();

const byInteraction = new Map();
for (const e of perf.events) byInteraction.set(e.id, Math.max(byInteraction.get(e.id) ?? 0, e.duration));
const durations = [...byInteraction.values()].sort((a, b) => b - a);
const inp = durations[0] ?? 0;
const scrollLong = perf.longTasks.filter((t) => t.start >= perf.scrollStart && t.start <= perf.scrollEnd);
const frames = [...perf.frames].sort((a, b) => a - b);
const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] ?? 0;
const jank = frames.filter((f) => f > 50).length;

const rows = [
  [`INP (worst of ${durations.length} interactions)`, '≤ 150 ms', `${Math.round(inp)} ms`, inp <= 150],
  ['Long tasks while scrolling', '0 over 50 ms', `${scrollLong.length}${scrollLong.length ? ` (max ${Math.round(Math.max(...scrollLong.map((t) => t.duration)))} ms)` : ''}`, scrollLong.length === 0],
  ['Frame time p50 / p95', '—', `${pct(0.5).toFixed(1)} / ${pct(0.95).toFixed(1)} ms`, true],
  ['Frames over 50 ms', '—', `${jank} of ${frames.length}`, true],
  ['Interactions exercised', 'tap, chip, details, reaction, theme ×2, menu', [...done, 'menu'].join(', '), done.size === 6],
];
console.log(`Scroll + interaction, ${CPU_THROTTLE}× CPU throttle, 412×823\n| Check | Budget | Result | Pass |\n|---|---|---|---|`);
for (const [check, budget, result, ok] of rows) console.log(`| ${check} | ${budget} | ${result} | ${ok ? '✅' : '❌'} |`);
process.exit(rows.every((r) => r[3]) ? 0 : 1);
