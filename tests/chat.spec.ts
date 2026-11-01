import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { centre } from './helpers';

const resume = JSON.parse(readFileSync('src/content/resume.json', 'utf8'));
const firstName: string = resume.identity.name.split(' ')[0];

const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
type Reply = { tokens?: string[]; meta?: unknown; error?: string };

/** Mocks /api/twin and records each request body. */
async function mockTwin(page: Page, reply: Reply | ((body: { messages: { content: string }[] }) => Reply)) {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  await page.route('**/api/twin', async (route: Route) => {
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 204 });
    const body = route.request().postDataJSON();
    bodies.push(body);
    const r = typeof reply === 'function' ? reply(body) : reply;
    const events: [string, unknown][] = r.error
      ? [['error', { code: r.error }]]
      : [...(r.tokens ?? []).map((t): [string, unknown] => ['token', { t }]), ['meta', r.meta ?? { cite: [], followups: [], action: null, unknown: false }], ['done', {}]];
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse(events) });
  });
  return bodies;
}

const askInline = async (page: Page, q: string) => {
  await page.locator('#twin-input').fill(q);
  await page.locator('#twin-input').press('Enter');
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important')),
  );
});

test('FAQ chip answers instantly from local data, with no API call', async ({ page }) => {
  const bodies = await mockTwin(page, { tokens: ['nope'] });
  await page.goto('/');
  await page.locator('label[for="twin-q-1"]').click();
  const log = page.locator('[data-twin-log]');
  await expect(log.locator('.bubble--user')).toHaveText(new RegExp(resume.faq[1].q.replace(/[?]/g, '\\?')));
  await expect(log.locator('.bubble--twin').last()).toContainText(resume.faq[1].a.slice(0, 30));
  await expect(page.locator('.twin')).toHaveClass(/has-log/);
  expect(bodies).toHaveLength(0);
});

test('streams an answer, keeps meta out of the text, cites → Journey pulse, announces once', async ({ page }) => {
  await mockTwin(page, {
    tokens: ['At Spidra I ', 'led the **MCP** server launch', ' so AI assistants can pull live web data.'],
    meta: { cite: ['exp-1'], followups: ['What did you ship there?'], action: null, unknown: false },
  });
  await page.goto('/');
  await askInline(page, 'What do you do at Spidra?');
  const answer = page.locator('[data-twin-log] .bubble--twin').last();
  await expect(answer).toContainText('led the MCP server launch');
  await expect(answer.locator('strong')).toHaveText('MCP');
  await expect(page.locator('[data-twin-status]')).toContainText('At Spidra I led');
  await expect(page.locator('.twin [data-twin-orb]')).toHaveAttribute('data-state', 'answered');
  await expect(page.locator('[data-twin-log]').getByRole('button', { name: 'What did you ship there?' })).toBeVisible();

  await page.locator('[data-twin-log]').getByRole('button', { name: /From: Product Manager @ Spidra/ }).click();
  await expect(page.locator('#exp-1 .stop__card')).toHaveClass(/is-pulse/);
});

test('name privacy: the visitor typing the owner name sends {{NAME}}; answers expand placeholders', async ({ page }) => {
  const bodies = await mockTwin(page, { tokens: ["I'm Harnie, {{", 'NAME}}', "'s AI twin."] });
  await page.goto('/');
  await askInline(page, `Is ${firstName} open to remote roles?`);
  await expect(page.locator('[data-twin-log] .bubble--twin').last()).toContainText(`I'm Harnie, ${resume.identity.name}'s AI twin.`);
  const sent = JSON.stringify(bodies[0]);
  expect(sent).toContain('{{NAME}}');
  expect(sent.toLowerCase()).not.toContain(firstName.toLowerCase());
  await expect(page.locator('[data-twin-log] .bubble--user')).toContainText(firstName);
});

test('history: only the last 6 messages are sent', async ({ page }) => {
  const bodies = await mockTwin(page, { tokens: ['ok'] });
  await page.goto('/');
  for (let i = 1; i <= 5; i++) {
    await askInline(page, `question ${i}`);
    await expect(page.locator('[data-twin-log] .bubble--twin').nth(i - 1)).toHaveText(/ok/);
    await expect(page.locator('.twin [data-twin-orb]')).toHaveAttribute('data-state', 'answered');
  }
  const last = bodies.at(-1)!.messages;
  expect(last).toHaveLength(6);
  expect(last.at(-1)).toEqual({ role: 'user', content: 'question 5' });
});

test('unknown → tilted orb and an email offer', async ({ page }) => {
  await mockTwin(page, { tokens: ["That's not something I can answer from my résumé."], meta: { cite: [], followups: [], action: 'email', unknown: true } });
  await page.goto('/');
  await askInline(page, 'Where did you go to high school?');
  await expect(page.locator('.twin [data-twin-orb]')).toHaveAttribute('data-state', 'unknown');
  const email = page.locator('[data-twin-log]').getByRole('link', { name: /email me/i });
  await expect(email).toHaveAttribute('href', new RegExp(`^mailto:${resume.identity.email}`));
});

test('rate limited → dimmed orb, local FAQ fallback and email CTA', async ({ page }) => {
  await mockTwin(page, { error: 'rate_limited' });
  await page.goto('/');
  await askInline(page, 'What do you build?');
  const reply = page.locator('[data-twin-log] .bubble--twin').last();
  await expect(reply).toContainText('taking a breather');
  await expect(reply).toContainText(resume.faq[0].a.slice(0, 25));
  await expect(page.locator('.twin [data-twin-orb]')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('[data-twin-log]').getByRole('link', { name: /email me/i })).toBeVisible();
});

test('download_resume action triggers the résumé download', async ({ page }) => {
  await mockTwin(page, { tokens: ['Sure — here it is.'], meta: { cite: [], followups: [], action: 'download_resume', unknown: false } });
  await page.goto('/');
  await askInline(page, 'Can I get your CV?');
  const download = page.waitForEvent('download');
  await page.locator('[data-twin-log]').getByRole('button', { name: 'Download résumé' }).click();
  expect((await download).suggestedFilename()).toBe(resume.identity.resume_pdf.split('/').at(-1));
});

test('docks into a non-modal panel when the card scrolls away; Esc returns focus; page keeps scrolling', async ({ page }) => {
  await mockTwin(page, { tokens: ['Hello!'] });
  await page.goto('/');
  await askInline(page, 'hi');
  await expect(page.locator('[data-twin-log] .bubble--twin')).toContainText('Hello!');
  const launcher = page.getByRole('button', { name: 'Open chat with Harnie' });
  await expect(launcher).toHaveCount(0);

  await centre(page, 'about');
  await expect(launcher).toBeVisible();
  await launcher.click();
  const panel = page.getByRole('dialog', { name: 'Ask Harnie' });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('#twin-panel-input')).toBeFocused();
  await expect(panel.locator('.bubble--twin')).toContainText('Hello!');

  const before = await page.evaluate(() => scrollY);
  await page.mouse.move(300, 400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(before);

  await page.locator('#twin-panel-input').press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open chat with Harnie' })).toBeFocused();

  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.getByRole('button', { name: /chat with Harnie/ })).toHaveCount(0);
});

test('conversation survives a reload in the dock without shifting the hero', async ({ page }) => {
  await mockTwin(page, { tokens: ['Remember me.'] });
  await page.goto('/');
  await askInline(page, 'hello');
  await expect(page.locator('[data-twin-log] .bubble--twin')).toContainText('Remember me.');
  await page.reload();
  await page.evaluate(() => (window as unknown as { __shifts: number }).__shifts = 0);
  await page.evaluate(() =>
    new PerformanceObserver((l) => l.getEntries().forEach((e) => ((window as unknown as { __shifts: number }).__shifts += (e as unknown as { value: number }).value))).observe({ type: 'layout-shift' }),
  );
  const launcher = page.getByRole('button', { name: 'Open chat with Harnie' });
  await expect(launcher).toBeVisible({ timeout: 8000 });
  await expect(page.locator('[data-twin-log] .bubble')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __shifts: number }).__shifts)).toBeLessThan(0.001);
  await launcher.click();
  await expect(page.getByRole('dialog').locator('.bubble--twin')).toContainText('Remember me.');
});

test('a question sent while an answer is in progress is kept, not lost', async ({ page }) => {
  await page.route('**/api/twin', async (route) => {
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 204 });
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse([['token', { t: 'first' }], ['meta', { cite: [], followups: [], action: null, unknown: false }], ['done', {}]]) });
  });
  await page.goto('/');
  await askInline(page, 'one');
  await askInline(page, 'two');
  await expect(page.locator('#twin-input')).toHaveValue('two');
  await expect(page.locator('[data-twin-log] .bubble--user')).toHaveCount(1);
});

test('stop aborts a slow answer', async ({ page }) => {
  await page.route('**/api/twin', async (route) => {
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 204 });
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse([['token', { t: 'late' }], ['done', {}]]) }).catch(() => {});
  });
  await page.goto('/');
  await askInline(page, 'slow?');
  await expect(page.locator('.twin [data-twin-orb]')).toHaveAttribute('data-state', 'thinking');
  await page.getByRole('button', { name: 'Stop answering' }).click();
  await expect(page.locator('.twin [data-twin-orb]')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#twin-input')).toBeEnabled();
});

test('the chat island is not loaded before idle or intent, then loads', async ({ page }) => {
  const chunks: string[] = [];
  page.on('request', (r) => /\/_astro\/(index|preact)/.test(r.url()) && chunks.push(r.url()));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(chunks).toHaveLength(0);
  await page.locator('#twin-input').focus();
  await expect.poll(() => chunks.length).toBeGreaterThan(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe: 0 violations with a conversation and the docked panel open (${theme})`, async ({ page }) => {
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await mockTwin(page, { tokens: ['At Spidra I lead product.'], meta: { cite: ['exp-1', 'proj-1'], followups: ['What next?'], action: 'email', unknown: false } });
    await page.goto('/');
    await askInline(page, 'Spidra?');
    await expect(page.locator('.twin [data-twin-orb]')).toHaveAttribute('data-state', 'answered');
    expect((await new AxeBuilder({ page }).include('.twin').analyze()).violations.map((v) => v.id)).toEqual([]);
    await centre(page, 'about');
    await page.getByRole('button', { name: 'Open chat with Harnie' }).click();
    const { violations } = await new AxeBuilder({ page }).include('.twin-dock').analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
  });
}

test('desktop: the floating Harnie button appears once the chat card header scrolls away, before any chat, with a career coach link', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.twin-launcher')).toHaveCount(0); // the card itself is on screen
  await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  const launcher = page.locator('.twin-launcher');
  await expect(launcher).toBeVisible();
  const peek = page.getByRole('navigation', { name: 'Chat with Harnie or the career coach' });
  await expect(peek.getByRole('link', { name: /career coach/ })).toHaveAttribute('href', '/career');
  await expect(peek.getByRole('button', { name: /Ask Harnie/ })).toBeVisible(); // shown on arrival
  await launcher.click();
  await expect(page.locator('.twin-panel .twin-mode a[href="/career"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('.twin-launcher')).toHaveCount(0); // back in the hero: the card is the chat again
});

test('phone: after tapping a starter in the panel, focus stays in the panel and Escape still closes it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => scrollTo({ top: 600, behavior: 'instant' }));
  await page.locator('.twin-launcher').first().click();
  await page.locator('.twin-panel .twin-starter').first().click();
  await expect(page.locator('#twin-panel-input')).toBeFocused();
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await expect(page.locator('.twin-panel')).toHaveCount(0);
});
