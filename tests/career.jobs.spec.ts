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

test('saved jobs come back as cards ("get ,y saved jobs", no AI call); Ami shows recently seen jobs as cards on request', async ({ page, request }) => {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  const cards = page.locator('.cc-job');
  await expect(cards).toHaveCount(5);
  for (const i of [0, 2]) await cards.nth(i).getByRole('button', { name: 'Save' }).click();
  await request.post(`${CLAUDE}/__reset`);
  await page.locator('[data-new-chat]').click();
  await page.locator('#cc-input').fill('get ,y saved jobs');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-jobs__intro').last()).toHaveText('Your 2 saved jobs:');
  await expect(page.locator('.cc-job')).toHaveCount(2);
  await expect(page.locator('.cc-jobs__left')).toHaveCount(0); // not fresh jobs: nothing counted
  expect(((await (await request.get(`${CLAUDE}/__requests`)).json()) as unknown[]).length).toBe(0); // no AI call
  await expect(page.locator('[data-usage="jobs"] [data-left]')).toHaveText('5 of 10 left');

  await page.locator('#cc-input').fill('show me the jobs I have seen as cards');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-jobs__intro').last()).toHaveText("Jobs I've shown you in the last 7 days (5):");
});

test('a momentary "unavailable" (e.g. a slow Redis moment) is retried once, so the message still gets an answer', async ({ page }) => {
  await withProfile(page);
  let calls = 0;
  await page.route('**/api/career/chat', async (route) => {
    if (++calls === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
    await route.continue();
  });
  await page.locator('#cc-input').fill('How should I prepare for interviews?');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text').last()).toContainText('Lead with outcomes');
  expect(calls).toBe(2);
});

test('if Ami wrongly picks a new search for jobs the visitor already has, the app shows those cards instead', async ({ page, request }) => {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  await expect(page.locator('.cc-job')).toHaveCount(5);
  await page.locator('.cc-job').first().getByRole('button', { name: 'Save' }).click();
  await request.post(`${CLAUDE}/__reset`);
  await page.locator('#cc-input').fill('bring back the ones I bookmarked earlier');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-jobs__intro').last()).toHaveText('Your 1 saved job:');
  const reqs = (await (await request.get(`${CLAUDE}/__requests`)).json()) as { messages: unknown[] }[];
  expect(reqs.some((r) => JSON.stringify(r.messages).includes('rank_jobs'))).toBe(false); // no new search
  await expect(page.locator('[data-usage="jobs"] [data-left]')).toHaveText('5 of 10 left');
});

test('tracker: eligibility badges, status on the card, calendar reminder, 7-day follow-up nudge, "my applications", this week', async ({ page, request }) => {
  await request.post('http://localhost:4329/pipeline', {
    headers: { authorization: 'Bearer test-token' },
    data: [
      ['SET', 'jobs:desc:greenhouse:sample:1', 'Build payments products. Visa sponsorship is available for this role.'],
      ['SET', 'jobs:desc:greenhouse:sample:2', 'Applicants must be authorized to work in Nigeria without sponsorship.'],
    ],
  });
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  const pay = page.locator('.cc-job', { hasText: 'Product Manager, Payments' });
  const health = page.locator('.cc-job', { hasText: 'Associate Product Manager' });
  await expect(pay.locator('.cc-job__elig')).toHaveText('Sponsors visas');
  await expect(pay.locator('.cc-job__elig')).toHaveClass(/is-open/);
  await expect(health.locator('.cc-job__elig')).toHaveText('No visa sponsorship');
  await expect(health.locator('.cc-job__elig')).toHaveClass(/is-limited/);
  await expect(page.locator('.cc-job__elig')).toHaveCount(2); // the rest say nothing either way

  // This week: counted on the device.
  await expect(page.locator('[data-week-strip] [data-stat="found"] .cc-week__num')).toHaveText('5');

  // Applied: saved too, dated, with a follow-up date and a calendar reminder.
  await pay.getByLabel(/Application status/).selectOption('applied');
  await expect(pay.locator('.cc-job__save')).toHaveAttribute('aria-pressed', 'true');
  await expect(pay.locator('.cc-job__since')).toContainText('Applied today · follow up');
  await expect(page.locator('[data-week-strip] [data-stat="applied"] .cc-week__num')).toHaveText('1');
  const download = page.waitForEvent('download');
  await pay.getByRole('button', { name: 'Add reminder to my calendar' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('follow-up-sample-pay.ics');
  const ics = (await (await import('node:fs/promises')).readFile(await file.path())).toString();
  expect(ics).toContain('BEGIN:VEVENT');
  expect(ics).toContain('SUMMARY:Follow up: Product Manager\\, Payments at Sample Pay');
  expect(ics).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
  await expect(page.locator('[data-nudge]')).toBeHidden(); // not due yet

  // "show my applications": the tracked cards, no AI call.
  await request.post(`${CLAUDE}/__reset`);
  await page.locator('#cc-input').fill('show my applications');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-jobs__intro').last()).toHaveText('Your 1 application, newest first:');
  expect(((await (await request.get(`${CLAUDE}/__requests`)).json()) as unknown[]).length).toBe(0);

  // Eight days later, no reply: Ami nudges.
  const now = Date.now();
  await page.clock.setFixedTime(now + 8 * 86_400_000);
  await page.reload();
  const nudge = page.locator('[data-nudge]');
  await expect(nudge).toBeVisible();
  await expect(nudge).toContainText('You applied to Product Manager, Payments at Sample Pay 8 days ago.');
  await nudge.getByRole('button', { name: 'Remind me in 3 days' }).click();
  await expect(nudge).toBeHidden();
  await page.clock.setFixedTime(now + 12 * 86_400_000);
  await page.reload();
  await expect(nudge).toBeVisible();
  await expect(nudge).toContainText('12 days ago');
  await nudge.getByRole('button', { name: 'I heard back' }).click();
  await expect(nudge).toBeHidden();
  await page.locator('.cc-jobs__intro').last().waitFor();
  await expect(page.locator('.cc-job', { hasText: 'Product Manager, Payments' }).last().getByLabel(/Application status/)).toHaveValue('interview');
});

test('the follow-up nudge writes the email in chat; dismissing hides it for the day', async ({ page }) => {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  await page.locator('.cc-job').first().getByLabel(/Application status/).selectOption('applied');
  await expect(page.locator('.cc-job').first().locator('.cc-job__since')).toBeVisible();
  const now = Date.now();
  await page.clock.setFixedTime(now + 8 * 86_400_000);
  await page.reload();
  const nudge = page.locator('[data-nudge]');
  await expect(nudge).toBeVisible();
  await nudge.getByRole('button', { name: 'Hide follow-up reminders for today' }).click();
  await expect(nudge).toBeHidden();
  await page.reload();
  await expect(page.locator('.cc-msgs')).toBeVisible();
  await expect(nudge).toBeHidden(); // dismissed for that day
  await page.evaluate(() => localStorage.removeItem('cc-nudge-dismissed'));
  await page.clock.setFixedTime(now);
  await page.reload();
  await expect(nudge).toBeHidden(); // back to today: not due
  await page.clock.setFixedTime(now + 8 * 86_400_000);
  await page.reload();
  await expect(nudge).toBeVisible();
  await page.clock.setFixedTime(now); // the chat request needs today's date
  await nudge.getByRole('button', { name: 'Write a follow-up' }).click();
  await expect(nudge).toBeHidden();
  await expect(page.locator('.cc-msg--user').last()).toContainText(/Write a short follow-up email for my application to the .+ role at .+\. I applied 8 days ago/);
  await expect(page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text').last()).not.toBeEmpty();
});

test('"Your week" on the new-chat screen: a weekly goal ring, tappable stats, and interview prep from a tracked interview', async ({ page }) => {
  await withProfile(page);
  await page.locator('[data-new-chat]').click();
  const strip = page.locator('[data-week-strip]');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.cc-week__stat')).toHaveCount(4); // found, saved, applied, interviews
  await expect(strip).toContainText('Weekly goal: how many jobs will you apply to?');
  await expect(strip.getByRole('group', { name: 'Weekly goal: how many jobs will you apply to?' }).getByRole('button')).toHaveText(['3 jobs', '5 jobs', '10 jobs']);
  await strip.getByRole('button', { name: '5 jobs' }).click();
  await expect(strip.locator('.cc-goal__text')).toContainText('0 of 5 applications5 to go this week');
  await expect(page.locator('[data-week]')).toHaveCount(0); // not in the sidebar

  // "0 jobs found" is a shortcut to finding jobs.
  await strip.locator('[data-stat="found"] button').click();
  await expect(page.locator('.cc-job')).toHaveCount(5);
  const first = page.locator('.cc-job').first();
  await first.getByLabel(/Application status/).selectOption('applied');
  await expect(page.locator('[data-welcome]')).toContainText('1 of 5 this week.');

  await page.locator('[data-new-chat]').click();
  await expect(strip.locator('.cc-goal__text')).toContainText('1 of 5 applications');
  await expect(strip.locator('[data-stat="applied"] .cc-week__num')).toHaveText('1');
  await expect(strip.locator('[data-stat="found"] .cc-week__num')).toHaveText('5');
  await strip.locator('[data-stat="applied"] button').click();
  await expect(page.locator('.cc-jobs__intro').last()).toHaveText('Your 1 application, newest first:');

  // Heard back: the card offers interview prep, and "interviews" lists it.
  const tracked = page.locator('.cc-job').last();
  await tracked.getByLabel(/Application status/).selectOption('interview');
  await expect(tracked.getByRole('button', { name: 'Interview prep' })).toBeVisible();
  await page.locator('[data-new-chat]').click();
  await expect(strip.locator('[data-stat="interview"] .cc-week__num')).toHaveText('1');
  await strip.locator('[data-stat="interview"] button').click();
  await expect(page.locator('.cc-jobs__intro').last()).toHaveText('Your 1 interview. Tap Interview prep on a card for a guide.');
  await page.locator('.cc-job').last().getByRole('button', { name: 'Interview prep' }).click();
  await expect(page.locator('.cc-msg--user').last()).toContainText(/Prep me for my .+ interview at .+\.$/);

  // Goal reached, and the goal can be changed.
  await page.locator('[data-new-chat]').click();
  await strip.getByRole('button', { name: 'Change goal' }).click();
  await strip.getByRole('button', { name: '3 jobs' }).click();
  await expect(strip.locator('.cc-goal__text')).toContainText('1 of 3 applications');
  await page.reload();
  await expect(strip.locator('.cc-goal__text')).toContainText('1 of 3 applications');
});
