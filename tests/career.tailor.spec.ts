// Career Coach C4 in the browser: tailor (found job or pasted), quick questions, preview + inline edit, DOCX/PDF
// downloads, improve, cover letter, the no-fabrication flags. Built function + fake Upstash + fake Claude.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
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

async function tailorFromCard(page: Page) {
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  await expect(page.locator('.cc-job')).toHaveCount(3);
  await page.locator('.cc-job').first().getByRole('button', { name: 'Tailor my résumé' }).click();
  await expect(page.locator('.cc-match')).toBeVisible();
}

test('tailor a found job: match, quick question, result, preview with highlights, before/after, edit, downloads', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await withProfile(page);
  await tailorFromCard(page);

  await expect(page.locator('.cc-match__label')).toHaveText('Match · Product Manager, Payments');
  await expect(page.locator('.cc-match__item--strong')).toContainText('checkout design');
  await expect(page.locator('.cc-match__item--missing')).toContainText('SQL');
  await expect(page.locator('.cc-question__text')).toHaveText('How many A/B tests did you run on the checkout?');
  await page.locator('.cc-question__input').fill('About 6, and the winner became the default.');
  await page.getByRole('button', { name: 'Use my answers' }).click();

  await expect(page.locator('.cc-question__answer')).toHaveText('About 6, and the winner became the default.');
  const result = page.locator('.cc-result');
  await expect(result.locator('.cc-result__lead')).toContainText('Nothing was invented');
  await expect(result.locator('.cc-ats__before')).toHaveText('54');
  await expect(result.locator('.cc-ats__after')).toHaveText('88');
  await expect(result.locator('.cc-changes li')).toHaveCount(2);
  await expect(result.locator('.cc-changes li').first()).toContainText('Summary:');

  // Two columns at 1440: the preview is the sticky second column.
  await expect(page.locator('.cc')).toHaveClass(/has-preview/);
  const preview = page.locator('[data-preview]');
  await expect(preview).toBeVisible();
  const box = await preview.boundingBox();
  const chat = await page.locator('.cc-log').boundingBox();
  expect(box!.x).toBeGreaterThan(chat!.x + chat!.width - 5);

  const doc = page.locator('[data-doc]');
  await expect(doc.locator('.cc-doc__name')).toHaveText('Sample Candidate');
  // The contact line is rebuilt on the device from the original file (email was never sent to the model).
  await expect(doc.locator('.cc-doc__contact')).toHaveText('Lagos, Nigeria · candidate@mail.test · linkedin.com/in/sample-candidate');
  await expect(doc.locator('.is-changed').first()).toBeVisible();
  await expect(doc.locator('[data-key="summary"]')).toHaveClass(/is-changed/);
  await expect(page.locator('[data-doc-file]')).toHaveText('sample-candidate-resume-sample-pay-product-manager-payments.docx');

  await page.getByRole('button', { name: 'Before' }).click();
  await expect(doc.locator('.is-changed')).toHaveCount(0);
  await expect(doc.locator('[contenteditable]')).toHaveCount(0);
  await expect(doc).toContainText('Redesigned checkout flow');
  await page.getByRole('button', { name: 'Tailored', exact: true }).click();

  const bullet = doc.locator('[data-key="exp.0.bullets.1"]');
  await bullet.click();
  // Caret at the true end of the (wrapped) line, then type like a person would.
  await bullet.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.keyboard.type(' Weekly.');
  await bullet.press('Enter');
  await page.waitForTimeout(600);

  const [docx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download DOCX' }).click()]);
  expect(docx.suggestedFilename()).toBe('sample-candidate-resume-sample-pay-product-manager-payments.docx');
  const xml = await (await JSZip.loadAsync(readFileSync(await docx.path()))).file('word/document.xml')!.async('string');
  expect(xml).toContain('Product-minded designer');
  expect(xml).toContain('growth team. Weekly.');
  expect(xml).toContain('candidate@mail.test');

  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
  expect(pdf.suggestedFilename()).toBe('sample-candidate-resume-sample-pay-product-manager-payments.pdf');
  const bytes = readFileSync(await pdf.path());
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1500);

  await page.reload();
  await expect(page.locator('[data-doc] [data-key="exp.0.bullets.1"]')).toContainText('Weekly.');
  await expect(page.locator('[data-usage="tailored"] [data-left]')).toHaveText('1 of 2 left');
});

test('pasted job description: URLs are refused, text is tailored; questions can be skipped', async ({ page }) => {
  await withProfile(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.cc-starter[data-start="tailor"]')!.click());
  const area = page.getByLabel('Job description');
  await area.fill('https://jobs.sample.test/123');
  await page.getByRole('button', { name: 'Résumé only' }).click();
  await expect(page.locator('.cc-msg--note').last()).toContainText("I can't open links");
  await area.fill(JD);
  await page.getByRole('button', { name: 'Résumé only' }).click();
  await expect(page.locator('.cc-match')).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.cc-question__skipped')).toHaveText('Skipped');
  await expect(page.locator('.cc-result')).toBeVisible();
  const sent = (await (await page.request.get(`${CLAUDE}/__requests`)).json()) as { messages: { content: string }[] }[];
  expect(sent.find((r) => r.messages[0].content.includes('task = "tailor_write"'))!.messages[0].content).toContain('SQL is a plus');
});

test('improve my résumé: the 5-point critique, then the stronger version', async ({ page }) => {
  await withProfile(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.cc-starter[data-start="improve"]')!.click());
  await expect(page.locator('.cc-match')).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.cc-critique li')).toHaveCount(5);
  await expect(page.locator('.cc-critique li').first()).toContainText('Clarity:');
  await expect(page.locator('[data-doc-file]')).toHaveText('sample-candidate-resume.docx');
});

test('cover letter from a job card: streamed, editable, downloadable', async ({ page }) => {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  await expect(page.locator('.cc-job')).toHaveCount(3);
  await page.locator('.cc-job').first().getByRole('button', { name: 'Cover letter' }).click();
  await expect(page.locator('.cc-result__lead')).toContainText('Your cover letter is ready. Nothing was invented');
  const doc = page.locator('[data-doc]');
  await expect(doc).toContainText('Dear hiring team,');
  await expect(page.locator('[data-toggle]')).toBeHidden();
  const [docx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download DOCX' }).click()]);
  expect(docx.suggestedFilename()).toBe('sample-candidate-cover-letter-sample-pay-product-manager-payments.docx');
  await expect(page.locator('[data-usage="letters"] [data-left]')).toHaveText('0 of 1 left');
});

test('inventions are flagged in the chat and underlined in the preview', async ({ page, request }) => {
  await request.post(`${CLAUDE}/__invent`);
  try {
    await withProfile(page);
    await tailorFromCard(page);
    await page.getByRole('button', { name: 'Skip' }).click();
    const flags = page.locator('.cc-flags');
    await expect(flags).toContainText('Check these before you send it');
    await expect(flags.locator('li')).toHaveText(['Invented Corp (employer)', '37 (number)', 'SQL (name or tool)']);
    await expect(page.locator('.cc-result__lead')).not.toContainText('Nothing was invented');
    await expect(page.locator('[data-doc] .is-flagged').first()).toBeVisible();
  } finally {
    await request.post(`${CLAUDE}/__honest`);
  }
});

test('phone: the preview stacks below the conversation; axe passes on the result (light + dark)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withProfile(page);
  await tailorFromCard(page);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('[data-scroll] [data-preview]')).toBeVisible();
  await expect(page.locator('.cc')).not.toHaveClass(/has-preview/);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
  }
});

test('chat → "Make my résumé stronger" chip runs the real tool and ends with DOCX/PDF downloads; the coach is Ami', async ({ page, request }) => {
  await withProfile(page);
  await page.locator('#cc-input').fill('Build it so I can download it as a PDF');
  await page.locator('#cc-input').press('Enter');
  // The chat answer offers the tools by their exact labels (ai/career-system-prompt.md); a chip starts the tool.
  await page.locator('.cc-suggest').getByRole('button', { name: 'Make my résumé stronger' }).click();
  await expect(page.locator('.cc-match')).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.cc-critique li')).toHaveCount(5);
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
  expect(pdf.suggestedFilename()).toBe('sample-candidate-resume.pdf');

  const sent = (await (await request.get(`${CLAUDE}/__requests`)).json()) as { stream?: boolean; system: { text: string }[] }[];
  const system = sent.find((r) => r.stream)!.system[0].text;
  expect(system).toContain('You are **Ami**');
  expect(system).toContain('"Make my résumé stronger"');
  expect(system).toContain("never say you can't make a file");
  await page.locator('[data-new-chat]').click();
  await expect(page.locator('.cc-empty__title')).toHaveText("Hi, I'm Ami, your career coach.");
});

test('continuation: after a letter for a pasted job, "Tailor my reume for the role above" tailors to that same job', async ({ page, request }) => {
  await withProfile(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.cc-starter[data-start="tailor"]')!.click());
  await page.getByLabel('Job description').fill(JD);
  await page.getByRole('button', { name: 'Letter only' }).click();
  await expect(page.locator('.cc-result__lead')).toContainText('Your cover letter is ready');

  await page.locator('#cc-input').fill('Tailor my reume for the role above');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-match')).toBeVisible();
  await expect(page.locator('.cc-jobpaste')).toHaveCount(0); // never asked to paste it again
  const sent = (await (await request.get(`${CLAUDE}/__requests`)).json()) as { messages: { content: string }[] }[];
  const analyze = sent.find((r) => r.messages[0].content.includes('task = "tailor_analyze"'))!;
  expect(analyze.messages[0].content).toContain('SQL is a plus');
});

test('composer: Shift+Enter adds a line, Enter sends; a question about tailoring stays a chat message', async ({ page, request }) => {
  await withProfile(page);
  const input = page.locator('#cc-input');
  await input.click();
  await page.keyboard.type('Line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Line two');
  expect(await input.inputValue()).toBe('Line one\nLine two');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Enter');
  // Tall composer keeps rounded corners, not an oval: the radius stays at half the one-line height.
  const shape = await page.locator('.cc-composer').evaluate((el) => ({ r: parseFloat(getComputedStyle(el).borderTopLeftRadius), h: el.getBoundingClientRect().height }));
  expect(shape.h).toBeGreaterThan(100);
  expect(shape.r).toBe(28);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cc-msg--user .cc-msg__text').last()).toHaveText('Line one\nLine two');
  await expect(input).toHaveValue('');
  await expect(page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text').last()).toContainText('Lead with outcomes');

  await input.fill('Should I tailor my résumé for every application?');
  await input.press('Enter');
  await expect(page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text')).toHaveCount(3);
  await expect(page.locator('.cc-match')).toHaveCount(0);
});

test('preview: closes (chat goes full width), reopens from the chat, never makes the page scroll; downloads say what happened', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 });
  await withProfile(page);
  await tailorFromCard(page);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.cc')).toHaveClass(/has-preview/);
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight + 1)).toBe(true);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download DOCX' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  await expect(page.locator('[data-dl-status]')).toHaveText(/^Saved .+\.docx: check your Downloads folder\.$/);

  const chatWidth = (await page.locator('.cc-log').boundingBox())!.width;
  await page.getByRole('button', { name: 'Close the preview' }).click();
  await expect(page.locator('[data-preview]')).toBeHidden();
  await expect(page.locator('.cc')).not.toHaveClass(/has-preview/);
  expect((await page.locator('.cc-log').boundingBox())!.width).toBeGreaterThan(chatWidth + 200);
  await page.reload();
  await expect(page.locator('[data-preview]')).toBeHidden(); // stays closed
  const card = page.locator('.cc-doccard');
  await expect(card).not.toHaveClass(/is-showing/); // closed: the card pulses
  await card.getByRole('button', { name: /Tailored résumé/ }).click();
  await expect(page.locator('[data-preview]')).toBeVisible();
  await expect(card).toHaveClass(/is-showing/);
  await expect(card).toContainText('In the preview');
});

test('"Résumé + cover letter": one click makes both, each with a paper card that downloads directly', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withProfile(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.cc-starter[data-start="tailor"]')!.click());
  await page.getByLabel('Job description').fill(JD);
  const userTurns = await page.locator('.cc-msg--user').count();
  await page.getByRole('button', { name: 'Résumé + cover letter' }).click();
  await expect(page.locator('.cc-msg--user .cc-msg__text').last()).toHaveText('Tailor my résumé and write a cover letter for this job description.');
  await page.getByRole('button', { name: 'Skip' }).click();
  const cards = page.locator('.cc-doccard');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Tailored résumé');
  await expect(cards.nth(1)).toContainText('Cover letter');
  // The letter came last, so it's in the preview; the résumé card pulses until opened.
  await expect(cards.nth(1)).toHaveClass(/is-showing/);
  await expect(cards.nth(0)).not.toHaveClass(/is-showing/);
  expect(await page.locator('.cc-msg--user').count()).toBe(userTurns + 1); // one request, no second user turn

  const [pdf] = await Promise.all([page.waitForEvent('download'), cards.nth(0).getByRole('button', { name: 'Download the résumé as PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/resume.*\.pdf$/i);
  await expect(cards.nth(0).locator('.cc-doccard__status')).toHaveText(/^Saved .+\.pdf: check your Downloads folder\.$/);
  await cards.nth(0).locator('.cc-doccard__open').click();
  await expect(cards.nth(0)).toHaveClass(/is-showing/);
  await expect(cards.nth(1)).not.toHaveClass(/is-showing/);

  const sent = (await (await request.get(`${CLAUDE}/__requests`)).json()) as { messages: { content: string }[] }[];
  expect(sent.filter((r) => r.messages[0].content.includes('task = "tailor_write"'))).toHaveLength(1);
  const letter = sent.filter((r) => r.messages[0].content.includes('task = "cover_letter"'));
  expect(letter).toHaveLength(1);
  expect(letter[0].messages[0].content).toContain('SQL is a plus');
});

test('typing "tailor my résumé and write a cover letter" for a known job does both', async ({ page }) => {
  await withProfile(page);
  await page.locator('.cc-suggest').getByRole('button', { name: 'Find jobs for me' }).click();
  await expect(page.locator('.cc-job')).toHaveCount(3);
  await page.locator('.cc-job').first().getByRole('button', { name: 'Cover letter' }).click();
  await expect(page.locator('.cc-doccard')).toHaveCount(1);
  await expect(page.locator('[data-usage="letters"] [data-left]')).toHaveText('0 of 1 left');
  await page.locator('#cc-input').fill('Now tailor my CV and write a cover letter too');
  await page.locator('#cc-input').press('Enter');
  // Today's one cover letter is used, so Ami says so and tailors the résumé only.
  await expect(page.locator('.cc-msg--note').last()).toContainText("I'll tailor your résumé now");
  await expect(page.locator('.cc-match')).toBeVisible();
});
