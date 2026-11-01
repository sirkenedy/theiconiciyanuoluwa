// Career Coach phone layout: the composer pinned to the bottom, the AI warning once in the empty state, and the
// hamburger panel that holds the rail (chats, résumé, usage, privacy, delete). Built function + fakes.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PHONES = [
  [430, 932],
  [390, 844],
  [360, 740],
] as const;
const WARNING = 'AI suggestions can be wrong. Review everything before you send it.';

let netSeq = 0;
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.0.${(++netSeq % 250) + 1}-p${test.info().workerIndex}-${Date.now()}` });
});

async function openCareer(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto('/career');
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
}

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

/** The composer's bottom edge sits within the dock's padding of the screen's bottom edge. */
async function expectPinned(page: Page, height: number) {
  const composer = await box(page, '.cc-composer');
  expect(composer.y + composer.height).toBeLessThanOrEqual(height);
  expect(composer.y + composer.height).toBeGreaterThanOrEqual(height - 24);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
}

for (const [width, height] of PHONES) {
  test(`phone ${width}×${height}: composer pinned to the bottom, no line under it, the warning above the upload card, all without scrolling`, async ({ page }) => {
    await openCareer(page, width, height);
    await expectPinned(page, height);
    await expect(page.locator('.cc-disclaimer')).toBeHidden();
    await expect(page.locator('.cc-peek')).toHaveCount(0);

    const warn = page.locator('[data-empty] .cc-empty__warn');
    await expect(warn).toBeVisible();
    await expect(warn).toHaveText(WARNING);
    const w = await box(page, '[data-empty] .cc-empty__warn');
    const drop = await box(page, '.cc-drop');
    const dock = await box(page, '.cc-dock');
    expect(w.y + w.height).toBeLessThanOrEqual(drop.y);
    // The whole upload card (zone + consent) is on screen above the composer, with the log not scrolled.
    expect(drop.y + drop.height).toBeLessThanOrEqual(dock.y);
    expect(await page.locator('[data-log]').evaluate((el) => el.scrollTop)).toBe(0);
  });
}

test('phone: with a conversation the composer stays pinned and the warning is gone', async ({ page }) => {
  for (const [width, height] of PHONES.slice(0, 2)) {
    await openCareer(page, width, height);
    await page.locator('#cc-input').fill('How should I prepare for a product manager interview?');
    await page.locator('#cc-input').press('Enter');
    await expect(page.locator('.cc-msg--coach')).toHaveCount(1);
    await expect(page.locator('[data-empty]')).toBeHidden();
    await expect(page.getByText(WARNING).filter({ visible: true })).toHaveCount(0);
    await expectPinned(page, height);
    await page.locator('[data-new-chat]').evaluate((b: HTMLButtonElement) => b.click());
  }
});

test('phone: the layout follows the visual viewport (keyboard-aware)', async ({ page }) => {
  await openCareer(page, 390, 844);
  expect(await page.locator('[data-cc]').evaluate((el) => el.style.getPropertyValue('--vv-h'))).toBe('844px');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => page.locator('[data-cc]').evaluate((el) => el.style.getPropertyValue('--vv-h'))).toBe('');
});

test('phone: the hamburger opens the panel with chats, résumé, usage, privacy and delete; Escape, close and the scrim close it', async ({ page }) => {
  await openCareer(page, 430, 932);
  const menu = page.getByRole('button', { name: 'Chats, résumé and usage' });
  const rail = page.locator('#cc-rail');
  await expect(menu).toHaveAttribute('aria-controls', 'cc-rail');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(rail).not.toBeInViewport();
  expect(await rail.evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  const size = await menu.boundingBox();
  expect(size!.width).toBeGreaterThanOrEqual(44);
  expect(size!.height).toBeGreaterThanOrEqual(44);

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(rail).toBeInViewport();
  await expect(page.locator('[data-new-chat]')).toBeFocused();
  for (const text of ['New chat', 'Chats', 'Your résumé', 'No résumé yet', 'Today · resets at midnight', 'Saved only on this device', 'Delete everything']) {
    await expect(rail.getByText(text, { exact: false }).first()).toBeInViewport();
  }
  await expect(rail.getByRole('link', { name: 'Privacy' })).toBeVisible();
  await expect(rail.locator('[data-usage="messages"] [data-left]')).toHaveText('10 of 10 left');
  // A modal panel: what's behind it can't be reached.
  expect(await page.locator('#main').evaluate((el) => (el as HTMLElement).inert)).toBe(true);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const { violations } = await new AxeBuilder({ page }).include('#cc-rail').analyze();
    expect(violations.map((v) => `${scheme} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
  }

  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();
  await expect(rail).not.toBeInViewport();
  expect(await page.locator('#main').evaluate((el) => (el as HTMLElement).inert)).toBe(false);

  await menu.click();
  await page.getByRole('button', { name: 'Close the menu' }).click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();

  await menu.click();
  await page.mouse.click(420, 500); // the scrim, right of the panel
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  // "Delete everything" works from the panel.
  await menu.click();
  await rail.getByRole('button', { name: 'Delete everything' }).click();
  await expect(rail.locator('[data-delete-confirm]')).toBeVisible();
  await rail.getByRole('button', { name: 'Cancel' }).click();
});

test('phone: axe passes on the empty state and with the panel closed (light + dark)', async ({ page }) => {
  await openCareer(page, 390, 844);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${scheme} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
  }
});

test('desktop and tablet keep the rail, the line under the composer and no hamburger', async ({ page }) => {
  for (const [width, height] of [[1280, 800], [820, 1180]] as const) {
    await openCareer(page, width, height);
    await expect(page.locator('.cc-menu')).toBeHidden();
    await expect(page.locator('[data-new-chat]')).toBeInViewport();
    await expect(page.locator('.cc-disclaimer')).toBeVisible();
    await expect(page.locator('[data-empty] .cc-empty__warn')).toBeHidden();
    await expect(page.locator('.cc-rail__top')).toBeHidden();
    expect(await page.locator('#main').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  }
});
