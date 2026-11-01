// Responsive QA (qa-responsive skill): every viewport × theme × motion, with layout assertions,
// axe, and screenshots in qa/screens. `npm run test:responsive` (QA_SHOTS=0 skips screenshots).
import { test, expect, devices, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { settle } from './helpers';

const VIEWPORTS: [number, number][] = [
  [320, 568], [360, 800], [375, 667], [390, 844], [430, 932], [844, 390],
  [768, 1024], [820, 1180], [1024, 768], [1280, 800], [1440, 900], [1920, 1080],
];
const THEMES = ['light', 'dark'] as const;
const MOTIONS = ['normal', 'reduced'] as const;
const PAGES = [
  { name: 'home', path: '/' },
  { name: 'resume', path: '/resume/' },
  { name: '404', path: '/missing-page' },
  { name: 'career', path: '/career' },
  { name: 'career-privacy', path: '/career/privacy' },
];
const SECTIONS = ['top', 'about', 'journey', 'blog', 'resume', 'contact'];
const SHOTS = process.env.QA_SHOTS !== '0';
const DIR = 'qa/screens';
mkdirSync(DIR, { recursive: true });

test.describe.configure({ mode: 'parallel' });

/** Every layout rule from the skill, evaluated in the page. Returns human-readable problems. */
async function audit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const vw = innerWidth;
    const vh = innerHeight;
    const label = (el: Element) => {
      const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].slice(0, 2).join('.')} "${text}"`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden], .sr-only');
    };
    const clipsX = (el: Element) => /hidden|clip|auto|scroll/.test(getComputedStyle(el).overflowX) || getComputedStyle(el).contain.includes('paint');

    // 1. No horizontal overflow, and nothing wider than the screen that only the <body> clip hides.
    if (document.documentElement.scrollWidth > vw) problems.push(`overflow: page is ${document.documentElement.scrollWidth}px wide at ${vw}px`);
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || (r.right <= vw + 1 && r.left >= -1)) continue;
      let p = el.parentElement;
      let clipped = false;
      while (p && p !== document.body) {
        if (clipsX(p)) { clipped = true; break; }
        p = p.parentElement;
      }
      if (!clipped && getComputedStyle(el).position !== 'fixed') problems.push(`unclipped overflow: ${label(el)} spans ${Math.round(r.left)}→${Math.round(r.right)}`);
    }

    // 2. Clipped text.
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (!/hidden|clip/.test(cs.overflowX) || el.closest('.sr-only, [aria-hidden="true"]') || el.clientWidth <= 2) continue;
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (ownText && el.scrollWidth > el.clientWidth + 1) problems.push(`clipped text: ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    }

    // 3. Tap targets and 4. input font size.
    const interactive = [...document.querySelectorAll('a[href], button, input:not([type=radio]):not([type=hidden]), select, textarea, summary, [role=tab]'), ...[...document.querySelectorAll<HTMLLabelElement>('label[for]')].filter((l) => /radio|checkbox/.test((document.getElementById(l.htmlFor) as HTMLInputElement | null)?.type ?? ''))]
      .filter((el) => visible(el) && !el.classList.contains('skip-link') && !el.closest('[aria-hidden="true"]'));
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.width < 44 - 0.5 || r.height < 44 - 0.5) problems.push(`tap target ${Math.round(r.width)}×${Math.round(r.height)}: ${label(el)}`);
    }
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (visible(el) && parseFloat(getComputedStyle(el).fontSize) < 16) problems.push(`input font ${getComputedStyle(el).fontSize} (iOS zooms): ${label(el)}`);
    }

    // 5. Overlapping interactive elements (ignoring nesting). Only the part a scroll container actually shows counts:
    // content scrolled out of an overflow:auto panel (e.g. /career's chat log) isn't under the composer.
    const shown = (el: Element) => {
      let r = el.getBoundingClientRect();
      let { left, top, right, bottom } = r;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowY + getComputedStyle(p).overflowX)) continue;
        r = p.getBoundingClientRect();
        left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
      }
      return { left, top, right, bottom };
    };
    for (let i = 0; i < interactive.length; i++) {
      for (let j = i + 1; j < interactive.length; j++) {
        const a = interactive[i], b = interactive[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = shown(a), rb = shown(b);
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 1 && h > 1) problems.push(`overlap: ${label(a)} × ${label(b)}`);
      }
    }

    // 6. Sticky header must not cover anchor targets.
    const header = document.querySelector('.site-header')?.getBoundingClientRect().height ?? 0;
    const padTop = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]:not([href="#"])')) {
      const target = document.getElementById(a.hash.slice(1));
      if (!target) continue;
      const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      if (margin + padTop < header) problems.push(`anchor ${a.hash}: offset ${margin + padTop}px < header ${Math.round(header)}px`);
    }

    // 7. Body text ≥ 16px and ≤ 75ch per line (paragraph-like blocks of real prose).
    const zero = (font: string) => {
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = font;
      return c.measureText('0').width;
    };
    for (const el of document.querySelectorAll('p, li, dd')) {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
      // <small> marks fine print (captions), which the body-text rule doesn't cover.
      const text = [...el.childNodes].filter((n) => !(n instanceof HTMLElement && n.tagName === 'SMALL')).map((n) => n.textContent).join('').trim();
      const cs = getComputedStyle(el);
      if (text.length >= 60 && parseFloat(cs.fontSize) < 16) problems.push(`body text ${cs.fontSize}: ${label(el)}`);
      if (text.length >= 120) {
        const ch = el.clientWidth / zero(`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`);
        if (ch > 75.5) problems.push(`line length ${Math.round(ch)}ch: ${label(el)}`);
      }
    }

    // 8. The headline is visible without scrolling (landscape phones especially).
    const h1 = document.querySelector('h1')?.getBoundingClientRect();
    if (h1 && h1.bottom > vh + 1) problems.push(`headline needs scrolling: bottom ${Math.round(h1.bottom)} > ${vh}`);

    return [...new Set(problems)];
  });
}

// Contrast is judged on the resting design: elements caught half-way through a scroll-driven fade-in at load
// (which depends on viewport height) aren't a colour problem, so axe runs on the static, reduced-motion rendering.
async function axe(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map((v) => `axe ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(', ')}`);
}

async function shoot(page: Page, file: string, sections: boolean) {
  if (!SHOTS) return;
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  // content-visibility skips painting off-screen sections, which a full-page capture would show as blank.
  // /career's CSP refuses injected styles (as it should); it has no .cv-auto sections anyway.
  const style = await page.addStyleTag({ content: '.cv-auto{content-visibility:visible!important}' }).catch(() => null);
  await page.screenshot({ path: `${DIR}/${file}.jpg`, fullPage: true, type: 'jpeg', quality: 70 });
  await style?.evaluate((el) => (el as Element).remove());
  if (!sections) return;
  for (const id of SECTIONS) {
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (el) scrollTo({ top: el.getBoundingClientRect().top + scrollY - 70, behavior: 'instant' });
    }, id);
    await page.waitForTimeout(160);
    await page.screenshot({ path: `${DIR}/${file}--${id}.jpg`, type: 'jpeg', quality: 70 });
  }
}

for (const pg of PAGES) {
  for (const [w, h] of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const motion of MOTIONS) {
        test(`${pg.name} ${w}x${h} ${theme} ${motion}`, async ({ page }) => {
          await page.setViewportSize({ width: w, height: h });
          await page.emulateMedia({ colorScheme: theme, reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
          await page.goto(pg.path);
          await settle(page);
          const layout = await audit(page);
          await shoot(page, `${pg.name}-${w}x${h}-${theme}-${motion}`, pg.name === 'home' && motion === 'normal');
          const problems = [...layout, ...(await axe(page))];
          expect(problems, `${pg.name} ${w}x${h} ${theme} ${motion}`).toEqual([]);
        });
      }
    }
  }
}

// Mid-scroll: scroll-driven entrances and the hero scatter move things sideways; the page must never widen.
for (const [w, h] of VIEWPORTS) {
  test(`home ${w}x${h} mid-scroll stays within the screen`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    const widest = await page.evaluate(async () => {
      let max = 0;
      for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 4) {
        scrollTo({ top: y, behavior: 'instant' });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        max = Math.max(max, document.documentElement.scrollWidth - innerWidth);
      }
      return max;
    });
    expect(widest).toBe(0);
  });
}

// Real device descriptors: touch, device pixel ratio, mobile viewport.
for (const name of ['iPhone 15', 'Pixel 7', 'iPad Mini'] as const) {
  test.describe(name, () => {
    const { defaultBrowserType: _ignored, ...device } = devices[name];
    test.use(device);

    test(`${name}: layout + axe`, async ({ page }) => {
      await page.goto('/');
      await settle(page);
      const layout = await audit(page);
      await shoot(page, `device-${name.replace(/\s+/g, '-').toLowerCase()}`, true);
      const problems = [...layout, ...(await axe(page))];
      expect(problems).toEqual([]);
    });

    test(`${name}: chat dock + sheet fit the screen and never cover the footer`, async ({ page }) => {
      await page.route('**/api/twin', (r) =>
        r.request().method() === 'HEAD'
          ? r.fulfill({ status: 204 })
          : r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: token\ndata: {"t":"Hello!"}\n\nevent: meta\ndata: {"cite":[],"followups":[],"action":null,"unknown":false}\n\nevent: done\ndata: {}\n\n' }),
      );
      await page.goto('/');
      if (await page.locator('.twin').isVisible()) {
        await page.locator('#twin-input').fill('hi');
        await page.locator('#twin-input').press('Enter');
        await expect(page.locator('[data-twin-log] .bubble--twin')).toContainText('Hello!');
      } else {
        // Phones: no inline card; Harnie is the floating button, which opens the sheet (loading the island if needed).
        // It steps aside while the hero buttons fill its lane, so scroll them past first.
        await page.evaluate(() => scrollTo({ top: 400, behavior: 'instant' }));
        await page.locator('.twin-launcher').first().click();
        await expect(page.locator('[data-twin-fab]')).toHaveCount(0);
        await expect(page.locator('.twin-panel .twin-starter').first()).toBeVisible();
        await page.locator('#twin-panel-input').fill('hi');
        await page.locator('#twin-panel-input').press('Enter');
        await expect(page.locator('.twin-panel .bubble--twin')).toContainText('Hello!');
        await page.keyboard.press('Escape');
        await expect(page.locator('.twin-panel')).toHaveCount(0);
      }
      await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      const launcher = page.locator('.twin-launcher');
      await expect(launcher).toBeVisible();
      await page.waitForTimeout(900);
      const covered = await page.evaluate(() => {
        const l = document.querySelector('.twin-launcher')!.getBoundingClientRect();
        return [...document.querySelectorAll('.site-footer a')].filter((a) => {
          const r = a.getBoundingClientRect();
          return r.right > l.left && r.left < l.right && r.bottom > l.top && r.top < l.bottom;
        }).map((a) => a.textContent?.trim() || a.getAttribute('aria-label'));
      });
      expect(covered, 'footer links under the dock orb').toEqual([]);

      await launcher.click();
      const panel = page.locator('.twin-panel');
      await expect(panel).toBeVisible();
      await panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const fit = await page.evaluate(() => {
        const p = document.querySelector('.twin-panel')!.getBoundingClientRect();
        const input = document.querySelector<HTMLInputElement>('#twin-panel-input')!;
        const i = input.getBoundingClientRect();
        return { top: p.top, bottom: p.bottom, inputBottom: i.bottom, vh: innerHeight, inputFont: parseFloat(getComputedStyle(input).fontSize) };
      });
      expect(fit.top).toBeGreaterThanOrEqual(0);
      expect(fit.bottom).toBeLessThanOrEqual(fit.vh + 1);
      expect(fit.inputBottom).toBeLessThanOrEqual(fit.vh);
      expect(fit.inputFont).toBeGreaterThanOrEqual(16);
      if (SHOTS) await page.screenshot({ path: `${DIR}/device-${name.replace(/\s+/g, '-').toLowerCase()}--chat.jpg`, type: 'jpeg', quality: 70 });
    });
  });
}
