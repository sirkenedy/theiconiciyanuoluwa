// Mock interviews in the browser: setup, one question at a time, follow-ups on vague answers, repeat/skip/end with no
// AI call, the whole transcript sent every turn, the scorecard. Built function + fake Upstash + fake Claude.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import JSZip from 'jszip';
import { seedJobs } from './fixtures-jobs.mjs';

const CLAUDE = 'http://127.0.0.1:4331';
const REDIS = 'http://localhost:4329';
const JD = `Product Manager, Payments at Sample Pay. ${'You will own discovery, the roadmap and A/B testing for checkout; SQL is a plus. '.repeat(4)}`;

test.beforeEach(async ({ request }) => {
  await seedJobs(REDIS);
  // Descriptions for the seeded jobs, as the ingest stores them.
  await request.post(`${REDIS}/pipeline`, { headers: { authorization: 'Bearer test-token' }, data: [1, 2, 3, 5, 6, 7].map((n) => ['SET', `jobs:desc:${n === 5 ? 'himalayas' : n > 5 ? 'jobicy' : 'greenhouse'}:sample:${n}`, JD]) });
  await request.post(`${CLAUDE}/__reset`);
});

let ipSeq = 0;
async function withProfile(page: Page) {
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `198.51.100.${(++ipSeq % 250) + 1}-t${test.info().workerIndex}-${Date.now()}` });
  await page.goto('/career');
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  await page.locator('.cc-consent').click();
  const zip = new JSZip();
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const lines = ['Sample Candidate', 'Lagos, Nigeria · candidate@mail.test · linkedin.com/in/sample-candidate', 'Product Designer, Example Fintech, 2020 – Present', 'Redesigned the checkout flow used daily by thousands of customers.', 'Ran user research and A/B tests end to end with the growth team.', 'Skills: Figma, user research, product discovery', 'Education: B.A. Design'];
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(p).join('')}</w:body></w:document>`);
  await page.locator('.cc-drop [data-file]').setInputFiles({ name: 'resume.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  await expect(page.locator('.cc-profile')).toHaveCount(1);
}


type Sent = { model: string; stream?: boolean; tools?: { name: string }[]; output_config?: { format?: { schema?: { properties?: Record<string, { enum?: string[] }> } } }; messages: { content: string | { text: string }[] }[] };
const sent = async (page: Page) => (await (await page.request.get(`${CLAUDE}/__requests`)).json()) as Sent[];
const turns = async (page: Page) => (await sent(page)).filter((r) => r.output_config?.format?.schema?.properties?.action);
const textOf = (r: Sent) => (Array.isArray(r.messages[0].content) ? r.messages[0].content.map((b) => b.text).join('\n') : r.messages[0].content);
const coachLines = (page: Page) => page.locator('.cc-msg--coach.cc-msg--iv .cc-msg__text');

async function answer(page: Page, text: string) {
  await page.locator('#cc-input').fill(text);
  await page.locator('#cc-input').press('Enter');
}

test('mock interview from a tracked job: setup, follow-up on a vague answer, repeat/skip with no AI call, scorecard', async ({ page }) => {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  const card = page.locator('.cc-job').first();
  await card.getByLabel(/Application status/).selectOption('interview');
  await card.getByRole('button', { name: 'Mock interview' }).click();

  // A new chat with the setup card; their words chose nothing special, so Standard + Neutral.
  await expect(page.locator('.cc-chats [data-conv]').first()).toContainText('Mock interview · Product Manager, Payments');
  const setup = page.locator('.cc-ivsetup__form');
  await expect(setup).toContainText("I'll interview you for Product Manager, Payments at Sample Pay");
  await expect(setup.getByRole('radio', { name: /Standard/ })).toBeChecked();
  await expect(setup.getByRole('radio', { name: /Neutral/ })).toBeChecked();
  await setup.locator('label', { hasText: 'Short' }).click();
  await setup.locator('label', { hasText: 'Tough' }).click();
  await setup.getByLabel(/Anything to focus on/).fill('no behavioural questions');
  await setup.getByRole('button', { name: 'Start interview' }).click();

  const bar = page.locator('[data-ivbar]');
  await expect(bar).toContainText('Mock interview · Question 1 of 4');
  await expect(coachLines(page).last()).toContainText('How would you improve checkout for schools?');
  await expect(page.locator('.cc-ivsetup__done')).toContainText('4 questions · Tough interviewer · no behavioural questions');
  await expect(page.locator('#cc-input')).toHaveAttribute('placeholder', 'Your answer…');
  await expect(page.locator('[data-usage="interviews"] [data-left]')).toHaveText('1 of 2 left');
  const [start] = await turns(page);
  expect(start.model).toBe('claude-haiku-5-5');
  expect(textOf(start)).toContain('"style":"tough"');
  expect(textOf(start)).toContain('Product Manager, Payments'); // the stored job description, read at the start

  // Vague ("we", no result) → Ami follows up instead of moving on.
  await answer(page, 'We changed some things.');
  await expect(coachLines(page).last()).toHaveText('What exactly was your own part, and what was the result?');
  await expect(bar).toContainText('Question 1 of 4');
  await answer(page, 'I redesigned the checkout flow myself and ran the A/B tests; completion went up after launch.');
  await expect(coachLines(page).last()).toContainText('How would you prioritise a payments roadmap?'); // no behavioural, as asked
  await expect(bar).toContainText('Question 2 of 4');

  // The whole interview goes with every turn, with Ami's private notes on each answer.
  const third = (await turns(page)).at(-1)!;
  const said = textOf(third);
  expect(said).toContain('Candidate: We changed some things.');
  expect(said).toContain('[your private note: Vague: no result, unclear personal role.]');
  expect(said).toContain('Ami (follow_up): What exactly was your own part');
  expect(said).toContain('Main questions asked: 1 of 4.');

  // "Repeat" and "skip" need no AI call to understand them.
  const before = (await turns(page)).length;
  await answer(page, 'Can you repeat that?');
  await expect(coachLines(page).last()).toContainText('How would you prioritise a payments roadmap?');
  expect((await turns(page)).length).toBe(before);
  await answer(page, 'skip');
  await expect(page.locator('.cc-msg__skipped')).toHaveText('Skipped');
  await expect(bar).toContainText('Question 3 of 4');

  await answer(page, 'I look at adoption, completion and support tickets, and I set the target before launch.');
  await expect(bar).toContainText('Question 4 of 4');
  await answer(page, 'Because I have built payment checkouts and I like the mission of helping schools.');
  // The budget is spent: Ami closes, and the scorecard follows on its own.
  await expect(coachLines(page).last()).toContainText('your scorecard is on its way');
  await expect(page.locator('.cc-doccard__kind')).toHaveText('Interview scorecard');
  await expect(page.locator('.cc-result__lead')).toContainText('Your interview scorecard is ready: 3.5/5 · Almost ready.');
  await expect(page.locator('.cc-preview')).toContainText('Overall: 3.5/5 · Almost ready');
  await expect(page.locator('.cc-preview')).toContainText('Question by question');
  await expect(page.locator('.cc-preview')).toContainText('Transcript');
  await expect(bar).toBeHidden();
  await expect(page.locator('#cc-input')).toHaveAttribute('placeholder', 'Ask anything about your job search…');
  const feedback = (await sent(page)).filter((r) => r.output_config?.format?.schema?.properties?.readiness);
  expect(feedback).toHaveLength(1);
  expect(feedback[0].model).toBe('claude-sonnet-5-5');

  // Afterwards it's a normal chat again, and Ami knows how it went.
  await answer(page, 'What should I work on first?');
  await expect(page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text').last()).toContainText('Lead with');
  const chat = (await sent(page)).filter((r) => r.tools?.some((x) => x.name === 'mock_interview')).at(-1)!;
  expect(JSON.stringify(chat.messages)).toContain('(I scored their mock interview: 3.5/5, almost ready.');
  expect(JSON.stringify(chat.messages)).toContain('(Interview answer) We changed some things.');

  // Reload: the interview, its scorecard and the finished state come back.
  await page.reload();
  await expect(page.locator('.cc-doccard__kind')).toHaveText('Interview scorecard');
  await expect(page.locator('[data-ivbar]')).toBeHidden();
});

test('typed "mock interview me" with a pasted posting in the setup; "end" early still gets a scorecard; the daily limit', async ({ page }) => {
  await withProfile(page);
  await answer(page, 'mock interview me, a tough one, focus on payments');
  const setup = page.locator('.cc-ivsetup__form');
  await expect(setup.getByRole('radio', { name: /Tough/ })).toBeChecked();
  await expect(setup.getByLabel(/Anything to focus on/)).toHaveValue('focus on payments');
  await setup.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.locator('.cc-ivsetup__error')).toContainText('Paste the full job description');
  await setup.getByLabel('Job description').fill(JD);
  await setup.getByRole('button', { name: 'Start interview' }).click();
  await expect(coachLines(page).last()).toContainText('How would you improve checkout for schools?');

  await answer(page, 'I would start by watching parents pay, then I would remove the extra steps, and measure completion weekly.');
  await expect(page.locator('[data-ivbar]')).toContainText('Question 2 of 6');
  await page.locator('[data-ivbar]').getByRole('button', { name: 'End interview' }).click();
  await expect(coachLines(page).last()).toContainText("Let's stop there.");
  await expect(page.locator('.cc-doccard__kind')).toHaveText('Interview scorecard');

  // A second one today is fine; a third is not (2 a day).
  await answer(page, 'practice interview please');
  await page.locator('.cc-ivsetup__form').getByLabel('Job description').fill(JD);
  await page.locator('.cc-ivsetup__form').getByRole('button', { name: 'Start interview' }).click();
  await expect(page.locator('[data-ivbar]')).toContainText('Question 1 of 6');
  await answer(page, 'end interview');
  await expect(coachLines(page).last()).toContainText("You didn't answer any questions");
  await expect(page.locator('[data-ivbar]')).toBeHidden();
  await answer(page, 'mock interview me again');
  await page.locator('.cc-ivsetup__form').getByLabel('Job description').fill(JD);
  await page.locator('.cc-ivsetup__form').getByRole('button', { name: 'Start interview' }).click();
  await expect(page.locator('.cc-msg--note').last()).toContainText("You've done today's 2 mock interviews.");
});

test('Ami starts a mock interview from an unusual phrasing (tool), and a failed turn puts the answer back in the box', async ({ page, request }) => {
  await withProfile(page);
  await answer(page, `Could you simulate the interview with me?\n${JD}`);
  const setup = page.locator('.cc-ivsetup__form');
  await expect(setup).toBeVisible();
  await expect(setup.getByLabel('Job description')).toHaveCount(0); // the pasted posting is used
  await setup.getByRole('button', { name: 'Start interview' }).click();
  await expect(coachLines(page).last()).toContainText('How would you improve checkout for schools?');

  // The model call fails once: nothing is lost, the answer is back in the box.
  await page.route('**/api/career/interview', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream"}' }), { times: 1 });
  await answer(page, 'I would interview parents first, find the slowest step in checkout, fix it and measure completion every week.');
  await expect(page.locator('.cc-msg--note').last()).toContainText("I couldn't respond just now");
  await expect(page.locator('#cc-input')).toHaveValue('I would interview parents first, find the slowest step in checkout, fix it and measure completion every week.');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('[data-ivbar]')).toContainText('Question 2 of 6');
  void request;
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe: interview setup and bar have no violations (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await withProfile(page);
    await answer(page, 'mock interview me');
    await page.locator('.cc-ivsetup__form').getByLabel('Job description').fill(JD);
    const a = await new AxeBuilder({ page }).analyze();
    expect(a.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
    await page.locator('.cc-ivsetup__form').getByRole('button', { name: 'Start interview' }).click();
    await expect(page.locator('[data-ivbar]')).toBeVisible();
    const b = await new AxeBuilder({ page }).analyze();
    expect(b.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
  });
}
