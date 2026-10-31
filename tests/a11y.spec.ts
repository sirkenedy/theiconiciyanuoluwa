import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { settle } from './helpers';

const resume = JSON.parse(readFileSync('src/content/resume.json', 'utf8'));

const WIDTHS = [390, 768, 1024, 1440];

async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) {
      scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    scrollTo(0, 0);
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of WIDTHS) {
    test(`axe: 0 violations, ${theme}, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/');
      await settle(page);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
    });
  }
}

test('no console errors or warnings on load and full scroll', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && messages.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await scrollThrough(page);
  expect(messages).toEqual([]);
});

test('no theme flash: stored dark theme is applied before first paint', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/', { waitUntil: 'commit' });
  const firstBodyBg = await page.evaluate(
    () =>
      new Promise<[string | undefined, string]>((resolve) => {
        const read = () => resolve([document.documentElement.dataset.theme, getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()]);
        document.body ? read() : document.addEventListener('DOMContentLoaded', read, { once: true });
      }),
  );
  expect(firstBodyBg).toEqual(['dark', '#16121a']);
});

test('theme toggle: click switches, Shift+click returns to System', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  const toggle = page.locator('[data-theme-toggle]');
  await expect(toggle).toHaveAttribute('aria-label', /System \(light\)/);
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#16121a');
  await toggle.click({ modifiers: ['Shift'] });
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBeNull();
  await toggle.click({ button: 'right' });
  await expect(toggle).toHaveAttribute('aria-label', /System/);
});

test('reduced motion: content visible and static', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  expect(running).toBe(0);
  for (const sel of ['h1', '#about h2', '#contact h2', 'footer']) await expect(page.locator(sel)).toBeVisible();
  const hidden = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((el) => !el.closest('[aria-hidden="true"]') && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) < 1).length);
  expect(hidden).toBe(0);
});

test.describe('JavaScript disabled', () => {
  test.use({ javaScriptEnabled: false });
  test('content readable and nav links resolve', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible();
    const hrefs = await page.locator('nav a[href^="#"], footer a[href^="#"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
    for (const href of new Set(hrefs)) expect(await page.locator(href).count(), href).toBe(1);
  });

  test('FAQ chips show answers without JS', async ({ page }) => {
    await page.goto('/');
    const answers = page.locator('.twin__answer');
    await expect(answers.nth(0)).toBeVisible();
    await expect(answers.nth(1)).toBeHidden();
    await page.locator('label[for="twin-q-1"]').click();
    await expect(answers.nth(1)).toBeVisible();
    await expect(answers.nth(0)).toBeHidden();
  });

  test('journey highlights are readable via <details>', async ({ page }) => {
    await page.goto('/');
    const first = page.locator('#exp-1 details');
    await first.locator('summary').click();
    await expect(first.locator('li').first()).toBeVisible();
  });
});

test('fonts: two WOFF2 files, only the display font preloaded', async ({ page }) => {
  const fonts: string[] = [];
  page.on('response', (r) => r.url().endsWith('.woff2') && fonts.push(new URL(r.url()).pathname));
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  expect(new Set(fonts).size).toBe(2);
  const preloads = await page.locator('link[rel="preload"][as="font"]').evaluateAll((ls) => ls.map((l) => l.getAttribute('href')));
  expect(preloads).toEqual(['/fonts/bricolage-800-latin.woff2']);
});

test('mobile menu opens as a bottom sheet and closes on navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.nav__links')).toBeHidden();
  await page.getByRole('button', { name: 'Open menu' }).click();
  const sheet = page.locator('#mobile-menu');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('link', { name: 'Journey' }).click();
  await expect(sheet).toBeHidden();
});

test('touch targets ≥ 44px', async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('a, button')]
        .filter((el) => (el as HTMLElement).offsetParent && !el.classList.contains('skip-link'))
        .map((el) => [el.textContent?.trim() || el.getAttribute('aria-label'), el.getBoundingClientRect()] as const)
        .filter(([, r]) => r.width < 44 || r.height < 44)
        .map(([n, r]) => `${n} ${r.width}x${r.height}`),
    );
    expect(small, `at ${width}px`).toEqual([]);
  }
});

test('every résumé item renders with its id, oldest stop first', async ({ page }) => {
  await page.goto('/');
  for (const item of [...resume.experience, ...resume.writing]) await expect(page.locator(`#${item.id}`)).toHaveCount(1);
  const order = await page.locator('.track > li').evaluateAll((lis) => lis.map((li) => li.id));
  expect(order).toEqual(resume.experience.map((e: { id: string }) => e.id).reverse());
  await expect(page.locator('h1')).toHaveCount(1);
});

test('placeholders are visibly marked', async ({ page }) => {
  await page.goto('/');
  const texts = await page.locator('.placeholder').allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  for (const t of texts) expect(t).toMatch(/^\[.+\]$/);
});

test('nav anchors land below the sticky header despite content-visibility', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  for (const [name, id] of [['Résumé', 'resume'], ['Journey', 'journey'], ['About', 'about']]) {
    await page.locator('.nav__links').getByRole('link', { name }).click();
    await page.waitForTimeout(150);
    const top = await page.locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().top);
    expect(top, id).toBeGreaterThanOrEqual(60);
    expect(top, id).toBeLessThanOrEqual(120);
  }
});
