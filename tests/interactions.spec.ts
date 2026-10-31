import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { centre, settle } from './helpers';

const resume = JSON.parse(readFileSync('src/content/resume.json', 'utf8'));

const translateOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const [x = '0', y = '0'] = getComputedStyle(el).translate.split(' ');
    return { x: parseFloat(x) || 0, y: parseFloat(y) || 0 };
  });

const centreOf = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Playwright scrolls targets into view; with the site's smooth scrolling the page would still be moving under the mouse.
  await page.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important')),
  );
});

test.describe('hero clay', () => {
  test('pointer parallax moves objects by depth, max 16px', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const stage = (await page.locator('.hero-stage').boundingBox())!;
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await page.mouse.move(stage.x + stage.width - 2, stage.y + 2, { steps: 8 });
    await page.waitForTimeout(900);
    const bubble = await translateOf(page, '.obj--bubble > div');
    const ring = await translateOf(page, '.obj--ring > div');
    expect(bubble.x).toBeGreaterThan(8);
    expect(Math.hypot(bubble.x, bubble.y)).toBeLessThanOrEqual(16 * Math.SQRT2 + 0.5);
    expect(Math.abs(ring.x)).toBeLessThan(Math.abs(bubble.x));
  });

  test('grab and throw: dragged object follows, then springs home', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const from = await centreOf(page, '.obj--bubble');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 140, from.y + 60, { steps: 6 });
    const held = await translateOf(page, '.obj--bubble > div');
    expect(held.x).toBeLessThan(-100);
    await page.mouse.up();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(2500);
    const home = await translateOf(page, '.obj--bubble > div');
    expect(Math.hypot(home.x, home.y)).toBeLessThan(1);
  });

  test('tap squishes the clay and puffs dust', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.locator('.obj--ring').click();
    const running = await page.evaluate(() => ({
      squish: document.querySelector('.obj--ring .clay')!.getAnimations().length,
      puffs: [...document.querySelectorAll('.puff')].filter((p) => p.getAnimations().length).length,
    }));
    expect(running.squish).toBeGreaterThan(0);
    expect(running.puffs).toBe(5);
  });

  test('About card hover makes the matching hero object glance at it', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1440, height: 1600 });
    await settle(page);
    await centre(page, 'about');
    await page.waitForTimeout(300);
    const card = await centreOf(page, '.about__card[data-glance="mint"]');
    await page.mouse.move(card.x, card.y, { steps: 3 });
    const rotate = await page.locator('.obj--sparkle .clay').evaluate((el) => el.style.rotate);
    expect(rotate).toMatch(/deg$/);
  });
});

test('About cards tilt toward the pointer (±6°)', async ({ page }) => {
  await page.goto('/');
  await centre(page, 'about');
  await settle(page);
  const card = page.locator('.about__card').first();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width - 2, box.y + 2, { steps: 4 });
  await page.waitForTimeout(100);
  const tilt = await card.evaluate((el) => [el.style.getPropertyValue('--rx'), el.style.getPropertyValue('--ry')].map(parseFloat));
  expect(tilt[1]).toBeGreaterThan(4);
  expect(Math.abs(tilt[0])).toBeLessThanOrEqual(6);
  expect(Math.abs(tilt[1])).toBeLessThanOrEqual(6);
});

test.describe('journey', () => {
  test('drag scrubs the road; keys step between milestones; snap lands on a stop', async ({ page }) => {
    await page.goto('/');
    await centre(page, 'journey');
    await page.waitForTimeout(800);
    const before = await page.evaluate(() => scrollY);
    const wrap = (await page.locator('.track-wrap').boundingBox())!;
    await page.mouse.move(wrap.x + wrap.width * 0.7, wrap.y + 300);
    await page.mouse.down();
    await page.mouse.move(wrap.x + wrap.width * 0.3, wrap.y + 300, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(before + 50);

    const centred = () =>
      page.locator('.track > li').evaluateAll((lis) => {
        const mid = innerWidth / 2;
        const d = lis.map((li) => Math.abs(li.getBoundingClientRect().left + li.getBoundingClientRect().width / 2 - mid));
        return { index: d.indexOf(Math.min(...d)), off: Math.min(...d) };
      });
    // After a drag the road settles on a milestone: centred, or pinned at either end of the road.
    const settledOnStop = await page.evaluate(() => {
      const track = document.querySelector<HTMLElement>('.track')!;
      const x = new DOMMatrix(getComputedStyle(track).transform).m41;
      const minX = Math.min(0, innerWidth * 0.92 - track.offsetWidth);
      const targets = [...track.children].map((li) => {
        const el = li as HTMLElement;
        return Math.max(minX, Math.min(0, innerWidth / 2 - (el.offsetLeft + el.offsetWidth / 2)));
      });
      return Math.min(...targets.map((t) => Math.abs(t - x)));
    });
    expect(settledOnStop).toBeLessThan(4);

    const road = () => page.locator('.track').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
    await page.locator('.track-wrap').focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(900);
    const start = await road();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(900);
    const afterRight = await centred();
    expect(await road()).toBeLessThan(start - 50);
    expect(afterRight.off).toBeLessThan(40);
    await page.keyboard.press('End');
    await page.waitForTimeout(900);
    const last = await page.locator('.track > li').last().boundingBox();
    expect(last!.x + last!.width).toBeLessThanOrEqual(1440);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(900);
    expect((await centred()).off).toBeLessThan(40);
  });

  test('slow wheel scrolling passes through the road without being snapped back', async ({ page }) => {
    await page.goto('/');
    await centre(page, 'about');
    await page.mouse.move(700, 500);
    const end = await page.locator('#blog').evaluate((el) => el.getBoundingClientRect().top + scrollY);
    for (let i = 0; i < 80 && (await page.evaluate(() => scrollY)) < end; i++) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(260);
    }
    expect(await page.evaluate(() => scrollY)).toBeGreaterThanOrEqual(end - 100);
  });

  test('clicking a stop expands its highlights', async ({ page }) => {
    await page.goto('/');
    await centre(page, 'journey');
    await page.keyboard.press('Home');
    await page.locator('.track-wrap').focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(900);
    const oldest = resume.experience.at(-1).id;
    await page.locator(`#${oldest} .stop__title`).click();
    await expect(page.locator(`#${oldest} details`)).toHaveAttribute('open', '');
    await expect(page.locator(`#${oldest} details li`).first()).toBeVisible();
  });

  test('journey:focus deep link scrolls to the stop and pulses it', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('journey:focus', { detail: { id: 'exp-3' } })));
    await expect(page.locator('#exp-3 .stop__card')).toHaveClass(/is-pulse/);
    await page.waitForTimeout(1500);
    const off = await page.locator('#exp-3').evaluate((li) => Math.abs(li.getBoundingClientRect().left + li.getBoundingClientRect().width / 2 - innerWidth / 2));
    expect(off).toBeLessThan(60);
  });
});

test.describe('reactions', () => {
  test('toggle with confetti, persist per visitor, local-only without Redis', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => r.url().includes('/api/react') && posts.push(r.method()));
    await page.goto('/');
    await centre(page, 'blog');
    await settle(page);
    const love = page.locator('[data-rx="post-1:love"]');
    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(love).toHaveAttribute('aria-label', 'Love, 1');
    const flying = await page.evaluate(() => [...document.querySelectorAll('.confetti__piece')].filter((p) => p.getAnimations().length).length);
    expect(flying).toBeGreaterThanOrEqual(6);
    expect(flying).toBeLessThanOrEqual(8);

    await page.reload();
    await expect(page.locator('[data-rx="post-1:love"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-rx="post-1:love"]').click();
    await expect(page.locator('[data-rx="post-1:love"]')).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(800);
    expect(posts).toContain('GET');
    expect(posts).not.toContain('POST');
    expect(await page.evaluate(() => localStorage.getItem('rx-visitor'))).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('with Redis: optimistic count, one batched debounced write', async ({ page }) => {
    const bodies: unknown[] = [];
    await page.route('**/api/react', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { enabled: true, counts: { 'site:love': 41, 'site:hire': 7 } } });
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { enabled: true, counts: { 'site:love': 42, 'site:hire': 8 } } });
    });
    await page.goto('/');
    await page.waitForResponse('**/api/react');
    await centre(page, 'contact');
    const love = page.locator('[data-rx="site:love"]');
    await expect(love.locator('[data-count]')).toHaveText('41');
    await love.click();
    await page.locator('[data-rx="site:hire"]').click();
    await expect(love.locator('[data-count]')).toHaveText('42');
    await page.waitForTimeout(900);
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { changes: unknown[] }).changes).toEqual([
      { key: 'site:love', on: true },
      { key: 'site:hire', on: true },
    ]);
  });
});

test('résumé download: card folds into a paper plane, then the file downloads', async ({ page }) => {
  await page.goto('/');
  await centre(page, 'resume');
  await settle(page);
  const download = page.waitForEvent('download');
  await page.locator('[data-plane-download]').click();
  const flying = await page.evaluate(() => ({
    paper: document.querySelector('[data-plane-paper]')!.getAnimations().length,
    plane: document.querySelector('[data-plane]')!.getAnimations().length,
  }));
  expect(flying.paper).toBeGreaterThan(0);
  expect(flying.plane).toBeGreaterThan(0);
  expect((await download).suggestedFilename()).toBe(resume.identity.resume_pdf.split('/').at(-1));
});

test.describe('contact', () => {
  test('copy email shows a clay toast', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await centre(page, 'contact');
    await page.getByRole('button', { name: 'Copy email' }).click();
    await expect(page.locator('[data-toast]')).toHaveText('Email copied');
    await expect(page.locator('[data-toast]')).toHaveClass(/is-on/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(resume.identity.email);
  });

  test('social cards pull toward the pointer by at most 6px', async ({ page }) => {
    await page.goto('/');
    await centre(page, 'contact');
    await settle(page);
    const box = (await page.locator('.channels > li').first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width - 1, box.y + box.height - 1, { steps: 5 });
    await page.waitForTimeout(800);
    const t = await translateOf(page, '[data-magnetic]');
    expect(t.x).toBeGreaterThan(3);
    expect(Math.max(Math.abs(t.x), Math.abs(t.y))).toBeLessThanOrEqual(6.2);
  });
});

test('header: active nav pill follows the section in view', async ({ page }) => {
  await page.goto('/');
  await centre(page, 'journey');
  const link = page.locator('.nav__links a[href="#journey"]');
  await expect(link).toHaveAttribute('aria-current', 'true');
  await page.waitForTimeout(500);
  const aligned = await page.evaluate(() => {
    const pill = document.querySelector('.nav__pill')!.getBoundingClientRect();
    const a = document.querySelector('.nav__links a[href="#journey"]')!.getBoundingClientRect();
    return Math.abs(pill.left - a.left) + Math.abs(pill.width - a.width);
  });
  expect(aligned).toBeLessThan(1);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('no parallax, no plane (direct download), Journey keys scroll natively', async ({ page }) => {
    await page.goto('/');
    const stage = (await page.locator('.hero-stage').boundingBox())!;
    await page.mouse.move(stage.x + 10, stage.y + 10);
    await page.mouse.move(stage.x + stage.width - 10, stage.y + 10, { steps: 5 });
    await page.waitForTimeout(300);
    expect(Math.abs((await translateOf(page, '.obj--bubble > div')).x)).toBe(0);

    await centre(page, 'journey');
    await page.locator('.track-wrap').focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    expect(await page.locator('.track-wrap').evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);

    await centre(page, 'resume');
    const download = page.waitForEvent('download');
    await page.locator('[data-plane-download]').click();
    expect(await page.locator('[data-plane]').evaluate((el) => el.getAnimations().length)).toBe(0);
    await download;
  });
});
