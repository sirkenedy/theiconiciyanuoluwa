import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { centre, settle } from './helpers';

const ALLOWED = new Set(['transform', 'opacity', 'scale', 'offset', 'easing', 'composite', 'computedOffset']);

async function forceFallback(context: BrowserContext) {
  await context.addInitScript(() => {
    const native = CSS.supports.bind(CSS);
    CSS.supports = ((...args: [string, string?]) =>
      args.join(' ').includes('animation-timeline') ? false : native(...(args as [string]))) as typeof CSS.supports;
  });
}

async function scrollToBottom(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y <= document.documentElement.scrollHeight; y += innerHeight / 3) {
      scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 60));
    }
  });
}

test('only transform/opacity are animated (clip-path only on the heading reveal)', async ({ page }) => {
  await page.goto('/');
  await scrollToBottom(page);
  const offenders = await page.evaluate((allowed) => {
    const bad: string[] = [];
    for (const a of document.getAnimations()) {
      const effect = a.effect as KeyframeEffect | null;
      const target = effect?.target as Element | undefined;
      for (const frame of effect?.getKeyframes() ?? []) {
        for (const prop of Object.keys(frame)) {
          if (allowed.includes(prop)) continue;
          if (prop === 'clipPath' && target?.classList.contains('reveal') && target.querySelector('h2')) continue;
          bad.push(`${(a as CSSAnimation).animationName ?? 'transition'} → ${prop} on .${target?.className}`);
        }
      }
    }
    return [...new Set(bad)];
  }, [...ALLOWED]);
  expect(offenders).toEqual([]);
});

test('scroll-driven timelines drive the choreography in Chromium', async ({ page }) => {
  await page.goto('/');
  await scrollToBottom(page);
  const kinds = await page.evaluate(() => {
    const names = new Set<string>();
    for (const a of document.getAnimations()) {
      if (a.timeline && a.timeline !== document.timeline) names.add((a as CSSAnimation).animationName);
    }
    return [...names].sort();
  });
  for (const name of ['grow', 'ride', 'landL', 'landR', 'landU', 'landS', 'reveal', 'rise', 'fromL', 'fromT', 'fromB', 'fromR', 'fanL', 'fanC', 'fanR', 'slide', 'roll', 'flip', 'mqL', 'mqR', 'exA', 'exT']) {
    expect(kinds, name).toContain(name);
  }
  await expect(page.locator('html')).not.toHaveClass(/no-sda/);
});

test('every section ends fully revealed once scrolled into view', async ({ page }) => {
  await page.goto('/');
  for (const id of ['about', 'blog', 'resume', 'contact']) {
    await centre(page, id);
    await page.waitForTimeout(100);
    const faded = await page.locator(`#${id} :is(.reveal, .rise, .from-l, .from-r, .from-t, .from-b, .fan-l, .fan-c, .fan-r, .flip)`).evaluateAll((els) =>
      els.filter((el) => {
        const r = el.getBoundingClientRect();
        // Reference ranges finish by cover 38–45%, i.e. once an element's top passes the middle of the viewport.
        const inView = r.top < innerHeight * 0.5 && r.bottom > innerHeight * 0.1;
        return inView && Number(getComputedStyle(el).opacity) < 0.98;
      }).length,
    );
    expect(faded, id).toBe(0);
  }
});

test('hero headline never fades (LCP-safe)', async ({ page }) => {
  await page.goto('/');
  const opacities = await page.locator('.hero__title span').evaluateAll((spans) => spans.map((s) => getComputedStyle(s).opacity));
  expect(opacities).toEqual(['1', '1', '1']);
});

test('idle floats pause off-screen', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await expect(page.locator('#top')).toHaveAttribute('data-offscreen', '');
  const state = await page.locator('#top .f1').first().evaluate((el) => getComputedStyle(el).animationPlayState);
  expect(state).toBe('paused');
});

test.describe('fallback (no scroll-driven animations)', () => {
  test('entrances play on entry, Journey and progress scrub from rAF', async ({ context, page }) => {
    await forceFallback(context);
    const chunks: string[] = [];
    page.on('response', (r) => r.url().includes('motion-fallback') && chunks.push(r.url()));
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/no-sda/);
    await scrollToBottom(page);
    expect(chunks.length).toBe(1);
    const pending = await page.locator(':is(.land-l, .land-r, .land-u, .land-s, .reveal, .rise, .from-l, .from-r, .from-t, .from-b, .fan-l, .fan-c, .fan-r, .flip):not(.is-in)').count();
    expect(pending).toBe(0);
    for (const id of ['about', 'blog', 'resume', 'contact']) {
      await centre(page, id);
      await settle(page);
      const hidden = await page.locator(`#${id} .is-in`).evaluateAll((els) => els.filter((el) => Number(getComputedStyle(el).opacity) < 0.98).map((el) => el.className));
      expect(hidden, id).toEqual([]);
    }
    await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(100);
    expect(Number(await page.locator('.progress').evaluate((el) => el.style.getPropertyValue('--p')))).toBeGreaterThan(0.95);
    expect(Number(await page.locator('#journey').evaluate((el) => el.style.getPropertyValue('--jp')))).toBe(1);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('no fallback, no choreography, Journey scrolls natively', async ({ context, page }) => {
    await forceFallback(context);
    await page.goto('/');
    await expect(page.locator('html')).not.toHaveClass(/no-sda/);
    await scrollToBottom(page);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await page.locator('.track-wrap').evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
  });
});
