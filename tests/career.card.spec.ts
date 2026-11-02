// "Share my progress" cards in the browser: the name prompt (pre-filled, remembered), choosing what shows, the live
// preview, the signed link and its page and link preview, counting shares and visits, the phone share sheet.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { seedJobs } from './fixtures-jobs.mjs';

const CLAUDE = 'http://127.0.0.1:4331';

test.beforeEach(async ({ request }) => {
  await seedJobs('http://localhost:4329');
  await request.post(`${CLAUDE}/__reset`);
});

let ipSeq = 0;
async function withProfile(page: Page) {
  // Each test is its own visitor: the per-IP daily caps (20 job cards) would otherwise add up across the run.
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `198.51.100.${(++ipSeq % 250) + 1}-${test.info().workerIndex}-${Date.now()}` });
  await page.goto('/career');
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  await page.locator('.cc-consent').click();
  await page.locator('.cc-drop [data-file]').setInputFiles({
    name: 'resume.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await docx(page),
  });
  await expect(page.locator('.cc-profile')).toHaveCount(1);
}

/** A tiny DOCX built in the page with the same zip format mammoth reads (no fixture file needed). */
async function docx(page: Page): Promise<Buffer> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${['Sample Candidate', 'Product Designer, Example Fintech, 2020 – Present', 'Redesigned the checkout flow used daily by thousands of customers.', 'Ran user research and A/B tests end to end with the growth team.'].map(p).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}


const REDIS = 'http://localhost:4329';
const redisGet = async (key: string) => ((await (await fetch(`${REDIS}/pipeline`, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify([['GET', key]]) })).json()) as { result: string | null }[])[0].result;
const today = () => new Date().toISOString().slice(0, 10);

async function withApplications(page: Page) {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  for (const i of [0, 1]) await page.locator('.cc-job').nth(i).getByLabel(/Application status/).selectOption('applied');
  await page.locator('.cc-job').nth(0).getByLabel(/Application status/).selectOption('interview');
  await page.locator('[data-new-chat]').click();
}

test('share my progress: name asked once (pre-filled), choose what shows, live preview, signed link, its page and preview', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const sharedBefore = Number(await redisGet(`career:cards:shared:${today()}`)) || 0;
  await withApplications(page);
  await page.locator('[data-share-open]').click();
  const dialog = page.locator('[data-share]');
  await expect(dialog).toBeVisible();
  // First time: their name, pre-filled from the résumé.
  await expect(dialog.locator('[data-share-ask]')).toBeVisible();
  await expect(dialog.locator('[data-share-name]')).toHaveValue('Sample');
  await expect(dialog.locator('[data-share-name]')).toBeFocused();
  // Sharing waits for that choice.
  await dialog.getByRole('button', { name: 'Copy caption & link' }).click();
  await expect(dialog.locator('[data-share-status]')).toHaveText('First, choose whether your name goes on the card.');
  await dialog.getByRole('button', { name: 'Add my name' }).click();
  await expect(dialog.locator('[data-share-ask]')).toBeHidden();
  await expect(dialog.locator('[data-share-img]')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(dialog.getByRole('checkbox', { name: 'My name (Sample)' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Applications (2)' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Interviews (1)' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Mock interviews/ })).toHaveCount(0); // nothing to show yet
  await dialog.getByRole('checkbox', { name: 'Interviews (1)' }).uncheck();
  await dialog.locator('label', { hasText: 'Story' }).click();
  await expect(dialog.locator('[data-share-img]')).toHaveAttribute('alt', 'Your progress card: 2 applications');

  await dialog.getByRole('button', { name: 'Copy caption & link' }).click();
  await expect(dialog.locator('[data-share-status]')).toHaveText('Caption and link copied.');
  const caption = await page.evaluate(() => navigator.clipboard.readText());
  expect(caption).toMatch(/^This week: 2 applications\. I'm practising with Ami, a free AI career coach\. Try it: https:\/\/theiconiciyanuoluwa\.com\/career\/card\/[\w-]+\.[\w-]+$/);
  expect(Number(await redisGet(`career:cards:shared:${today()}`))).toBe(sharedBefore + 1);
  // The same choices again: the same link, not another share.
  await dialog.getByRole('button', { name: 'Copy caption & link' }).click();
  expect(Number(await redisGet(`career:cards:shared:${today()}`))).toBe(sharedBefore + 1);

  // The link: their card, a clear invitation, and a link preview with their card on it.
  // Links use the site's real address; here it's opened on the test server.
  const url = new URL(new URL(caption.split('Try it: ')[1]).pathname, page.url()).toString();
  const visitsBefore = Number(await redisGet(`career:cards:visits:${today()}`)) || 0;
  // Opened by someone else: a fresh browser, no résumé.
  const visitor = await context.browser()!.newContext();
  const card = await visitor.newPage();
  await card.goto(url);
  await expect(card.locator('h1')).toHaveText('Sample is practising with Ami.');
  await expect(card.locator('.cardpage__card')).toHaveAttribute('alt', /Sample's job search, with Ami\. 2 applications\./);
  await expect(card.locator('meta[property="og:image"]')).toHaveAttribute('content', new RegExp(`/career/card/${url.split('/card/')[1].replace(/[.]/g, '\\.')}\\.png$`));
  await expect(card.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(card.getByRole('link', { name: 'Try Ami free' })).toHaveAttribute('href', '/career?from=card');
  expect(Number(await redisGet(`career:cards:visits:${today()}`))).toBe(visitsBefore + 1);
  const img = await card.request.get(`${url}.png`);
  expect(img.headers()['content-type']).toBe('image/png');
  expect((await img.body()).subarray(1, 4).toString()).toBe('PNG');
  // An edited link is refused.
  const [body, sig] = url.split('/card/')[1].split('.');
  await card.goto(url.replace(`${body}.${sig}`, `${body}x.${sig}`));
  await expect(card.locator('.label')).toContainText("isn't valid");
  expect((await card.request.get(`${url.replace(body, `${body}x`)}.png`)).status()).toBe(404);
  await card.getByRole('link', { name: 'Try Ami free' }).click();
  await expect(card.locator('.cc-empty__ref')).toContainText('Someone shared their progress with you.');
  expect(new URL(card.url()).search).toBe('');

  await visitor.close();
  // Next time: no question, the name is remembered.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await page.locator('[data-share-open]').click();
  await expect(dialog.locator('[data-share-ask]')).toBeHidden();
  await expect(dialog.getByRole('checkbox', { name: 'My name (Sample)' })).toBeChecked();
});

test('on a phone, Share opens the share sheet with the card image attached', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: unknown[] };
    w.__shared = [];
    Object.assign(navigator, {
      canShare: (d: { files?: File[] }) => !!d.files?.length,
      share: async (d: { files?: File[]; text?: string }) => void w.__shared.push({ files: d.files?.map((f) => `${f.name} ${f.type} ${f.size > 1000}`), text: d.text }),
    });
  });
  await withApplications(page);
  await page.locator('[data-share-open]').click();
  const dialog = page.locator('[data-share]');
  await dialog.getByRole('button', { name: 'Keep it anonymous' }).click();
  await expect(dialog.locator('[data-share-img]')).toHaveAttribute('src', /^data:image\/png/);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.locator('[data-share-status]')).toHaveText('Shared. Thank you for spreading the word!');
  const shared = (await page.evaluate(() => (window as unknown as { __shared: { files: string[]; text: string }[] }).__shared))[0];
  expect(shared.files).toEqual(['my-job-search-with-ami.png image/png true']);
  expect(shared.text).toMatch(/^This week: 2 applications, 1 interview\. .*Try it: https:\/\/theiconiciyanuoluwa\.com\/career\/card\//);
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe: the share dialog (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await withApplications(page);
    await page.locator('[data-share-open]').click();
    await expect(page.locator('[data-share-ask]')).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).include('[data-share]').analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
  });
}
