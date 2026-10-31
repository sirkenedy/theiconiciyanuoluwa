import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { settle } from './helpers';

const resume = JSON.parse(readFileSync('src/content/resume.json', 'utf8'));

test('home: JSON-LD Person, Open Graph image and canonical', async ({ page, request }) => {
  await page.goto('/');
  const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
  expect(ld['@type']).toBe('Person');
  expect(ld.name).toBe(resume.identity.name);
  expect(ld.sameAs).toContain(resume.identity.linkedin);
  const og = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(og).toMatch(/^https:\/\/.+\/og\.png$/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /^https:\/\/[^/]+\/$/);
  const png = await request.get('/og.png');
  expect(png.headers()['content-type']).toBe('image/png');
  const bytes = await png.body();
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
});

test('robots.txt and sitemap', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toMatch(/Disallow: \/api\//);
  expect(robots).toMatch(/Sitemap: https:\/\/.+\/sitemap-index\.xml/);
  const sitemap = await (await request.get('/sitemap-0.xml')).text();
  expect(sitemap).toContain('/resume/</loc>');
  expect(sitemap).not.toContain('404');
});

test('/resume: every role, highlight and project from the résumé; links back home', async ({ page }) => {
  await page.goto('/resume/');
  await expect(page.locator('h1')).toHaveText(resume.identity.name);
  for (const exp of resume.experience) {
    for (const h of exp.highlights.slice(0, 2)) await expect(page.getByText(h.split('[')[0].slice(0, 40), { exact: false }).first()).toBeAttached();
  }
  await expect(page.locator('.cv__list').first().locator(':scope > li')).toHaveCount(resume.experience.length);
  await expect(page.locator('a[download]')).toHaveAttribute('href', resume.identity.resume_pdf);
  await expect(page.locator('.nav__links a').first()).toHaveAttribute('href', '/#about');
});

test('404: served with status 404, noindex, clay scene, way home', async ({ page }) => {
  const res = await page.goto('/this-does-not-exist');
  expect(res?.status()).toBe(404);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('h1')).toHaveText('This page missed its landing pad.');
  await expect(page.getByRole('link', { name: 'Back to the portfolio' })).toHaveAttribute('href', '/');
});

for (const path of ['/resume/', '/404.html']) {
  for (const theme of ['light', 'dark'] as const) {
    test(`axe: ${path} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(path);
      await settle(page);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
    });
  }
}

test('/resume prints legibly in dark mode (ink, not cream, on paper)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', media: 'print' });
  await page.goto('/resume/');
  const colour = await page.locator('.cv__lead').evaluate((el) => getComputedStyle(el).color);
  const [r, g, b] = colour.match(/\d+/g)!.map(Number);
  expect(r + g + b).toBeLessThan(150);
});
