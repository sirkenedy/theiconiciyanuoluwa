// Career Coach C3 in the browser: profile → "Find jobs for me" → ranked cards → show more → limit → reload restores.
// Built Vercel function + fake Upstash seeded with sample jobs + fake Claude (playwright.config.ts).
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

test('cards: every good match at once, ranked, honest freshness, fit meter, why/gaps, attribution, apply link, save; restore', async ({ page }) => {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();

  const cards = page.locator('.cc-job');
  await expect(cards).toHaveCount(5); // all five matches in the sample pool (up to 10 at once)
  await expect(page.locator('.cc-jobs__intro')).toHaveText("Here are today's freshest matches for you. 2 were posted within the last hour.");
  const first = cards.first();
  await expect(first.locator('.cc-job__title')).toHaveText('Product Manager, Payments');
  await expect(first.locator('.cc-job__tile')).toHaveText('S');
  await expect(first.locator('.cc-job__meta')).toContainText('Sample Pay');
  await expect(first.locator('.cc-job__remote')).toHaveText('Remote · Lagos, Nigeria'); // who can apply
  await expect(first.locator('.cc-job__when')).toHaveText(/^posted (18|19|20) min ago$/);
  await expect(first.locator('.cc-job__when')).toHaveClass(/is-fresh/);
  await expect(first.locator('.cc-job__fit-num')).toHaveText('92');
  await expect(first.locator('[role="meter"]')).toHaveAttribute('aria-valuenow', '92');
  await expect(first.locator('.cc-job__panel--why li')).toHaveCount(2);
  await expect(first.locator('.cc-job__panel--gaps')).toContainText('Gaps to address');
  await expect(first.locator('.cc-job__via')).toHaveText('via Greenhouse');
  await expect(first.locator('.cc-job__via')).toHaveAttribute('href', 'https://board.sample.test/1');
  const open = first.getByRole('link', { name: /Open job/ });
  await expect(open).toHaveAttribute('href', 'https://jobs.sample.test/1?utm_source=api');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  // An "updated" job is labelled honestly and gets the amber dot.
  const updated = page.locator('.cc-job__when', { hasText: /^updated/ }).first();
  await expect(updated).toHaveText(/^updated \d+ h ago$/);
  await expect(updated).not.toHaveClass(/is-fresh/);

  await first.getByRole('button', { name: 'Save' }).click();
  await expect(first.locator('.cc-job__save')).toHaveAttribute('aria-pressed', 'true');

  await expect(page.locator('.cc-jobs__left')).toContainText('5 of 10 fresh jobs left today.');
  await expect(page.locator('.cc-suggest .cc-chip--btn')).toHaveText(['Why is Sample Pay the top match?', 'Prep me for the Product Manager, Payments interview', 'What should I improve first?']);
  await expect(page.locator('.cc-jobs__more')).toHaveCount(0); // nothing held back
  const titles = await page.locator('.cc-job__title').allTextContents();
  expect(new Set(titles).size).toBe(5);

  // The chips go to the chat, with the cards on screen as compact context.
  await page.locator('.cc-suggest').getByRole('button', { name: /^Why is .+ the top match\?$/ }).click();
  await expect(page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text').last()).toContainText('Lead with outcomes');
  const reqs = (await (await page.request.get(`${CLAUDE}/__requests`)).json()) as { stream?: boolean; messages: { content: string }[] }[];
  const chat = reqs.filter((r) => r.stream).at(-1)!;
  expect(String(chat.messages.at(-1)!.content)).toContain('<jobs>[{"title":"Product Manager, Payments","company":"Sample Pay"');
  // One ranking call for all 5 cards.
  expect(reqs.filter((r) => JSON.stringify(r.messages).includes('task = \\"rank_jobs\\"'))).toHaveLength(1);

  await page.reload();
  await expect(cards).toHaveCount(5);
  await expect(first.locator('.cc-job__save')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-usage="jobs"] [data-left]')).toHaveText('5 of 10 left');
});

test('without a résumé, "Find jobs for me" asks for one first (no request made)', async ({ page }) => {
  await page.goto('/career');
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  let called = false;
  page.on('request', (r) => r.url().includes('/api/career/jobs') && (called = true));
  await page.locator('.cc-starter[data-start="jobs"]').click();
  await expect(page.locator('.cc-msg--note')).toContainText('Upload your résumé first');
  expect(called).toBe(false);
});

test('when the day is used up, the coach says so plainly', async ({ page }) => {
  await withProfile(page);
  // The server's answer once today's 10 are used (the limit itself is covered by tests/jobs.test.ts).
  await page.route('**/api/career/jobs', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: [], left: 0, reason: 'limit' }) }));
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  await expect(page.locator('.cc-msg--note').last()).toContainText("You've seen today's 10 fresh jobs");
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`axe: job cards have no violations (${theme}, ${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await withProfile(page);
      await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
      await expect(page.locator('.cc-job')).toHaveCount(5);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
    });
  }
}

// ---------- live search (fake Adzuna/Jooble: tests/fake-jobsearch.mjs) ----------

const SEARCH = 'http://127.0.0.1:4333';
/** A pool with nothing for a designer (one backend role), freshly ingested, and no earlier live searches. */
async function poolWithoutDesigners(request: import('@playwright/test').APIRequestContext) {
  const backend = { id: 'greenhouse:sample:99', title: 'Backend Engineer', company: 'Sample Infra', location: 'Remote', remote: true, time: { kind: 'posted', at: Date.now() - 3600_000 }, applyUrl: 'https://jobs.sample.test/99', sourceUrl: 'https://board.sample.test/99', attribution: { source: 'Greenhouse', label: 'via Greenhouse' }, snippet: 'Go and Postgres services.' };
  const sources = ['greenhouse', 'lever', 'ashby', 'himalayas', 'remotive', 'jobicy'];
  await request.post('http://localhost:4329/pipeline', {
    headers: { authorization: 'Bearer test-token' },
    data: [...sources.map((s) => ['DEL', `jobs:idx:${s}`]), ['DEL', 'jobs:idx:search'], ['DEL', 'search:done'], ['SET', 'jobs:idx:greenhouse', JSON.stringify([backend])], ...sources.map((s) => ['SET', `jobs:last:${s}`, String(Date.now())])],
  });
}
const designer = { identity: { name: 'Sample Candidate', headline: 'Product Designer', location: 'Toronto, Ontario, Canada' }, summary: 'Product designer.', experience: [{ id: 'exp-1', role: 'Product Designer', company: 'Example Fintech', dates: '2020 – Present', highlights: ['Redesigned checkout flow'] }], skills: [{ group: 'Design', items: ['Figma', 'User research'] }], education: ['B.A. Design'], certifications: [], targetRoles: ['Product Designer'], seniority: 'mid', location: 'Toronto, Ontario, Canada', remotePreference: 'hybrid', yearsExperience: 5 };

test('nothing in the pool fits → a typed "find me jobs" runs a live search, streamed, and serves recent roles with pay', async ({ page, request }) => {
  await poolWithoutDesigners(request);
  await request.post(`${CLAUDE}/__profile`, { data: JSON.stringify(designer) });
  await withProfile(page);
  await page.locator('#cc-input').fill('Can you find me product designer roles?');
  await page.locator('#cc-input').press('Enter');
  const cards = page.locator('.cc-job');
  await expect(cards).toHaveCount(3);
  await expect(page.locator('.cc-msg--jobs').last()).toContainText('I searched job sites for Product Designer in Toronto');
  await expect(cards.first()).toContainText('via Adzuna');
  await expect(cards.first()).toContainText('CAD 95,000–120,000');
  const calls = (await (await request.get(`${SEARCH}/__calls`)).json()) as { url: string; body: string }[];
  const adzuna = calls.filter((c) => c.url.startsWith('/adzuna/')).at(-1)!;
  expect(adzuna.url).toContain('/jobs/ca/search/1');
  expect(adzuna.url).toContain('what=Product+Designer');
  expect(adzuna.url).toContain('where=Toronto');
  expect(JSON.stringify(calls)).not.toContain('Sample Candidate'); // only role, level and place leave the device
  // The chat isn't spent: a typed job request is the jobs tool, not a chat message.
  await expect(page.locator('[data-usage="messages"] [data-left]')).toHaveText('20 of 20 left');
});

test('no fit even after searching → says what was checked and searched, and offers to widen', async ({ page, request }) => {
  await poolWithoutDesigners(request);
  await withProfile(page); // the sample profile: Product Manager, remote, Lagos (Adzuna has no Nigeria site; Jooble finds nothing)
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  const msg = page.locator('.cc-msg--note').last();
  await expect(msg).toContainText('I checked 1 recent job and searched job sites for Product Manager');
  await expect(msg).toContainText('none you can apply for from Nigeria fit Product Manager at 55% or better');
  await expect(msg).toContainText("I've asked for more roles in Nigeria");
  await expect(page.locator('.cc-suggest').getByRole('button', { name: 'Search remote roles anywhere' })).toBeVisible();
  await page.locator('.cc-suggest').getByRole('button', { name: 'Edit my target roles' }).click();
  await expect(page.locator('.cc-profile [contenteditable], .cc-profile input, .cc-profile textarea').first()).toBeVisible();
});

test('Ami knows every job shown in the last 7 days, in any chat, and which ones were opened', async ({ page, context, request }) => {
  await context.route('https://jobs.sample.test/**', (r) => r.fulfill({ status: 200, body: 'job page' }));
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  const cards = page.locator('.cc-job');
  await expect(cards).toHaveCount(5);
  const openedTitle = (await cards.nth(1).locator('.cc-job__title').textContent())!;
  const [tab] = await Promise.all([context.waitForEvent('page'), cards.nth(1).getByRole('link', { name: /Open job/ }).click()]);
  await tab.close();
  await page.locator('[data-new-chat]').click();
  await page.locator('#cc-input').fill('Jobs I have seen most recently?');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text').last()).not.toBeEmpty();
  const reqs = (await (await request.get(`${CLAUDE}/__requests`)).json()) as { stream?: boolean; messages: { content: string }[] }[];
  const chat = reqs.filter((r) => r.stream).at(-1)!.messages[0].content;
  const recent = JSON.parse(chat.match(/<recent_jobs>(.*)<\/recent_jobs>/)![1]) as { title: string; opened: string | null }[];
  expect(recent).toHaveLength(5); // from the other chat
  expect(recent.filter((j) => j.opened).map((j) => j.title)).toEqual([openedTitle]);
});

test('"get me all jobs I have seen" in a new chat: answered from saved and recent jobs, never a new search', async ({ page, request }) => {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  const cards = page.locator('.cc-job');
  await expect(cards).toHaveCount(5);
  await cards.first().getByRole('button', { name: 'Save' }).click();
  await expect(cards.first().locator('.cc-job__save')).toHaveAttribute('aria-pressed', 'true');
  await request.post(`${CLAUDE}/__reset`);
  await page.locator('[data-new-chat]').click();
  await page.locator('#cc-input').fill('get me all jobs i have seen in the past');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text').last()).toContainText('From your saved and recent jobs');
  await expect(page.locator('.cc-job')).toHaveCount(0); // no new cards
  const reqs = (await (await request.get(`${CLAUDE}/__requests`)).json()) as { stream?: boolean; messages: { content: unknown }[] }[];
  expect(reqs.some((r) => JSON.stringify(r.messages).includes('rank_jobs'))).toBe(false);
  const newest = String(reqs.filter((r) => r.stream).at(-1)!.messages.at(-1)!.content);
  expect(newest).toMatch(/<saved_jobs>\[\{"title":"Product Manager, Payments"/);
  expect(newest).toContain('<recent_jobs>');
});
