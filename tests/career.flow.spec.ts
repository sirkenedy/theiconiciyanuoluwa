// Career Coach C2 end to end: upload → parse in the browser → profile → coaching chat → reload restores it all.
// Runs against the built Vercel function, an in-memory Upstash and a fake Claude API (playwright.config.ts).
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';

const DIR = 'test-results/career-fixtures';
const CLAUDE = 'http://127.0.0.1:4331';
const RESUME_HTML = `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;padding:40px">
<h1>Sample Candidate</h1><p>candidate@mail.test · +234 801 234 5678 · Lagos, Nigeria</p>
<h2>Experience</h2><p><b>Product Designer</b>, Example Fintech, 2020 – Present</p>
<ul><li>Redesigned the checkout flow used daily by thousands of customers.</li><li>Ran user research and A/B tests end to end.</li></ul>
<h2>Skills</h2><p>Figma, user research, prototyping, design systems</p></body>`;

const fixtures = { pdf: `${DIR}/sample-resume.pdf`, docx: `${DIR}/sample-resume.docx`, scanned: `${DIR}/scanned.pdf` };


// One network per test: the server allows only 3 new devices per network per day.
let netSeq = 0;
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.113.${(++netSeq % 250) + 1}-w${test.info().workerIndex}-${Date.now()}` });
});

test.beforeAll(async ({ browser }) => {
  mkdirSync(DIR, { recursive: true });
  const page = await browser.newPage();
  await page.setContent(RESUME_HTML);
  writeFileSync(fixtures.pdf, await page.pdf({ format: 'A4' }));
  // An "image-only" page: shapes, no text layer.
  await page.setContent('<body style="margin:0"><div style="width:400px;height:500px;background:linear-gradient(#999,#ccc)"></div></body>');
  writeFileSync(fixtures.scanned, await page.pdf({ format: 'A4' }));
  await page.close();

  const zip = new JSZip();
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const body = ['Sample Candidate', 'candidate@mail.test', 'Product Designer, Example Fintech, 2020 – Present', 'Redesigned the checkout flow used daily by thousands of customers.', 'Ran user research and A/B tests end to end.', 'Skills: Figma, user research, prototyping, design systems'].map(p).join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  writeFileSync(fixtures.docx, await zip.generateAsync({ type: 'nodebuffer' }));
});

test.beforeEach(async ({ request }) => {
  await request.post(`${CLAUDE}/__reset`);
});

const sentToClaude = async (page: Page) => (await (await page.request.get(`${CLAUDE}/__requests`)).json()) as { output_config?: { format?: unknown }; stream?: boolean; messages: { content: string }[] }[];

async function upload(page: Page, file: string) {
  await page.goto('/career');
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  await page.locator('.cc-consent').click();
  await page.locator('.cc-drop [data-file]').setInputFiles(file);
}

for (const kind of ['pdf', 'docx'] as const) {
  test(`${kind.toUpperCase()}: parsed in the browser → "Searching as" profile → sidebar card`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await upload(page, fixtures[kind]);
    const strip = page.locator('.cc-profile').last();
    await expect(strip).toContainText('Searching as');
    await expect(strip).toContainText('Sample Candidate');
    await expect(strip).toContainText('Product Designer → Product Manager');
    await expect(strip).toContainText('5 yrs');
    await expect(strip).toContainText('Lagos, Nigeria or remote');
    await expect(page.locator('.cc-resume__file')).toHaveText(`sample-resume.${kind}`);
    await expect(page.locator('.cc-resume__check')).toHaveText('Check your profile');

    // What reached the model: the résumé text, parsed on the device, without email or phone number.
    const [req] = await sentToClaude(page);
    expect(req.output_config?.format).toBeTruthy();
    expect(req.messages[0].content).toContain('Redesigned the checkout flow');
    expect(req.messages[0].content).not.toContain('candidate@mail.test');
    expect(req.messages[0].content).not.toContain('801 234 5678');
    expect(errors).toEqual([]);
  });
}

test('consent comes first: no file picker until "Stays on your device" is ticked', async ({ page }) => {
  await page.goto('/career');
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  const chooser = page.waitForEvent('filechooser', { timeout: 800 }).then(() => true, () => false);
  await page.locator('.cc-starter[data-start="upload"]').click();
  expect(await chooser).toBe(false);
  await expect(page.locator('.cc-consent')).toHaveClass(/is-needed/);
  // "Choose file" itself points at the box: ring + shake, focus on the checkbox, no picker.
  const chooser2 = page.waitForEvent('filechooser', { timeout: 800 }).then(() => true, () => false);
  await page.locator('.cc-drop__btn').click();
  expect(await chooser2).toBe(false);
  await expect(page.locator('[data-consent]')).toBeFocused();
  await page.locator('.cc-consent').click();
  await expect(page.locator('.cc-consent')).not.toHaveClass(/is-needed/);
  const opened = page.waitForEvent('filechooser');
  await page.locator('.cc-starter[data-start="upload"]').click();
  expect(await opened).toBeTruthy();
});

test('a scanned PDF is explained plainly, with a paste-instead box that builds the profile', async ({ page }) => {
  await upload(page, fixtures.scanned);
  await expect(page.locator('.cc-msg--note').last()).toContainText('scanned PDF');
  const area = page.locator('.cc-paste__area');
  await expect(area).toBeVisible();
  await area.fill('Sample Candidate\nProduct Designer, Example Fintech, 2020 – Present\n' + 'Redesigned the checkout flow used daily by thousands of customers. '.repeat(4));
  await page.getByRole('button', { name: 'Use this text' }).click();
  await expect(page.locator('.cc-profile').last()).toContainText('Sample Candidate');
});

test('edit + confirm the profile; it is what the chat sends; chat streams with suggestions; reload restores all', async ({ page }) => {
  await upload(page, fixtures.pdf);
  const strip = page.locator('.cc-profile').last();
  await strip.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Target roles (comma-separated)').fill('Product Manager, Associate PM');
  await page.getByLabel('Years of experience').fill('6');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('.cc-profile').last()).toContainText('6 yrs');
  await expect(page.locator('.cc-resume__ok')).toHaveText('Profile confirmed');

  await page.locator('#cc-input').fill('How should I describe my design work for PM roles?');
  await page.locator('#cc-input').press('Enter');
  const answer = page.locator('.cc-msg--coach:not(.cc-msg--note):not(.cc-msg--profile) .cc-msg__text').last();
  await expect(answer).toContainText('Lead with outcomes');
  await expect(answer.locator('strong')).toHaveText('checkout redesign');
  await expect(page.locator('.cc-suggest .cc-chip--btn')).toHaveText(['Find jobs for me', 'Tailor to this job']);
  await expect(page.locator('[data-usage="messages"] [data-left]')).toHaveText('9 of 10 left');

  const chat = (await sentToClaude(page)).find((r) => r.stream)!;
  expect(chat.messages[0].content).toContain('"targetRoles":["Product Manager","Associate PM"]');
  expect(chat.messages[0].content).toContain('"yearsExperience":6');

  const before = await page.locator('.cc-msg').allTextContents();
  await page.reload();
  await expect(page.locator('[data-welcome]')).toBeVisible();
  await expect(page.locator('.cc-msg')).toHaveCount(before.length);
  await expect(page.locator('.cc-profile').last()).toContainText('6 yrs');
  await expect(page.locator('.cc-resume__file')).toHaveText('sample-resume.pdf');
  await expect(page.locator('.cc-suggest .cc-chip--btn')).toHaveCount(2);
});

test('only the last 6 turns are sent; older ones are folded into a rolling summary', async ({ page }) => {
  await page.goto('/career');
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  for (let i = 1; i <= 9; i++) {
    await page.locator('#cc-input').fill(`Question ${i}`);
    await page.locator('#cc-input').press('Enter');
    await expect(page.locator('.cc-msg--coach').nth(i - 1)).toContainText('Lead with outcomes');
  }
  const reqs = await sentToClaude(page);
  const chats = reqs.filter((r) => r.stream);
  expect(chats.at(-1)!.messages.length).toBeLessThanOrEqual(6);
  expect(chats.at(-1)!.messages.at(-1)!.content).toBe('Question 9');
  // 9 questions = 18 turns: 12 beyond the 6 sent verbatim → one summary call, then the summary rides along.
  expect(reqs.filter((r) => !r.stream && !r.output_config?.format)).toHaveLength(1);
  await page.locator('#cc-input').fill('Question 10');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-msg--coach').nth(9)).toContainText('Lead with outcomes');
  const last = (await sentToClaude(page)).filter((r) => r.stream).at(-1)!;
  expect(last.messages[0].content).toContain('<summary>The visitor is a product designer');
});

test('orb shows "reading" while the résumé is parsed', async ({ page }) => {
  await page.goto('/career');
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  await page.locator('.cc-consent').click();
  const sawReading = page.waitForFunction(() => document.querySelector('[data-cc]')?.getAttribute('data-orb') === 'reading' && !!document.querySelector('.cc-reading .cc-paper'));
  await page.locator('.cc-drop [data-file]').setInputFiles(fixtures.pdf);
  await sawReading;
  await expect(page.locator('.cc-profile')).toHaveCount(1);
  await expect(page.locator('.cc-reading')).toHaveCount(0);
});

test('usage panel shows a loading skeleton until Upstash answers, then real counts', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/career/usage**', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/career');
  const card = page.locator('section[aria-labelledby="cc-usage-title"]');
  await expect(card).toHaveAttribute('data-usage-loading', '');
  await expect(card).toHaveAttribute('aria-busy', 'true');
  await expect(card.locator('[data-left]').first()).not.toContainText('left');
  release();
  await expect(card).not.toHaveAttribute('data-usage-loading', '');
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  await expect(card.locator('[data-usage="messages"] [data-left]')).toHaveText('10 of 10 left');
});
