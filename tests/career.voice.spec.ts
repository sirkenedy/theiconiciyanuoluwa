// Spoken mock-interview answers in the browser: a scripted microphone and recogniser (window.__ccVoiceTest) drive the
// real turn-taking: pauses, trailing off, carrying on talking, the nudge, spoken commands, the check-what-I-heard step.
// Built function + fake Upstash + fake Claude. The real microphone + Whisper path was verified separately in Chrome.
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


type Sent = { output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } }; messages: { content: string | { text: string }[] }[] };
const sent = async (page: Page) => (await (await page.request.get(`${CLAUDE}/__requests`)).json()) as Sent[];
const turns = async (page: Page) => (await sent(page)).filter((r) => r.output_config?.format?.schema?.properties?.action);
const coach = (page: Page) => page.locator('.cc-msg--coach.cc-msg--iv .cc-msg__text');
const mine = (page: Page) => page.locator('.cc-msg--user.cc-msg--iv .cc-msg__text');

/** A scripted microphone: say(text, ms) is one stretch of speech; quiet(ms) is silence after it. */
async function fakeVoice(page: Page, { denied = false, slowModel = false } = {}) {
  await page.addInitScript(([denied, slowModel]) => {
    const handlers: Record<string, ((v: unknown) => void)[]> = {};
    let live = false;
    const emit = (e: string, v?: unknown) => (handlers[e] ?? []).forEach((fn) => fn(v));
    const mic = {
      open: async () => {
        if ((window as unknown as { __micDenied?: boolean }).__micDenied ?? denied) throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        live = true;
      },
      pause: () => (live = false),
      resume: () => (live = true),
      close: () => (live = false),
      on: (e: string, fn: (v: unknown) => void) => (handlers[e] ??= []).push(fn),
    };
    const w = window as unknown as Record<string, unknown>;
    const spoken: string[] = [];
    const byLength = new Map<number, string>(); // fake audio: its length says which words it holds
    let release: () => void = () => {};
    const loaded = new Promise<void>((r) => (release = r));
    w.__spoken = spoken;
    w.__releaseModel = () => release();
    w.__whole = '';
    w.__ccVoiceTest = {
      supported: true,
      mic: () => mic,
      ears: () => ({
        load: async (p: (loaded: number, total: number) => void) => {
          p(21_000_000, 43_000_000);
          if (slowModel) await loaded;
        },
        transcribe: async (a: { text: string } | Float32Array) => (a instanceof Float32Array ? (byLength.get(a.length) ?? (w.__whole as string)) : a.text),
      }),
      speaker: () => ({ available: true, unlock: () => {}, stop: () => {}, speak: async (text: string) => void spoken.push(text) }),
    };
    w.__sayAudio = (text: string, samples: number, ms = 3000) => {
      if (!live) return false;
      byLength.set(samples, text);
      emit('speechstart');
      emit('speech', { audio: new Float32Array(samples), ms });
      return true;
    };
    w.__say = (text: string, ms = 3000) => {
      if (!live) return false;
      emit('speechstart');
      emit('speech', { audio: { text }, ms });
      return true;
    };
    w.__quiet = (ms: number) => {
      for (let t = 100; t <= ms; t += 100) emit('silence', t);
    };
    w.__live = () => live;
  }, [denied, slowModel] as const);
}
/** Speaks once Ami is listening again (after she has said her line). */
const say = async (page: Page, text: string, ms = 3000) => {
  await expect(page.locator('[data-voice-status]')).not.toHaveText(/speaking|thinking|ready to listen/);
  return rawSay(page, text, ms);
};
const rawSay = (page: Page, text: string, ms = 3000) => page.evaluate(([t, m]) => (window as unknown as { __say(t: string, m: number): boolean }).__say(t, m), [text, ms] as const);
const quiet = (page: Page, ms: number) => page.evaluate((m) => (window as unknown as { __quiet(m: number): void }).__quiet(m), ms);

async function startSpoken(page: Page) {
  await withProfile(page);
  await page.locator('#cc-input').fill('mock interview me');
  await page.locator('#cc-input').press('Enter');
  const setup = page.locator('.cc-ivsetup__form');
  await expect(setup.getByRole('radio', { name: /Speaking/ })).toBeChecked();
  await expect(setup).toContainText('never uploaded');
  await setup.getByLabel('Job description').fill(JD);
  await setup.getByRole('button', { name: 'Start interview' }).click();
  await expect(coach(page).first()).toContainText('How would you improve checkout for schools?');
  await expect(page.locator('[data-voice]')).toBeVisible();
  await expect(page.locator('[data-voice-status]')).toHaveText('Listening… tap the orb when you’re done');
  await expect(page.locator('#cc-input')).toBeHidden(); // the chat box gives way to the orb
}
const spokenLines = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);

test('hands-free: an answer ends on a natural pause (not mid-thought), Ami follows up and listens again', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await expect(page.locator('.cc-ivsetup__done')).toContainText('spoken answers');

  // Trailing off on "and": still thinking, even after 5 s.
  await say(page, 'I would start by watching parents pay, and');
  await expect(page.locator('[data-voice-live]')).toHaveText('I would start by watching parents pay, and');
  await quiet(page, 5000);
  await expect(mine(page)).toHaveCount(0);
  // They carry on; a complete sentence and a normal pause end the answer.
  await say(page, 'then I would remove the slowest step and measure completion every week.');
  await quiet(page, 1500);
  await expect(mine(page)).toHaveCount(0);
  await quiet(page, 2000);
  await expect(mine(page)).toHaveText(['I would start by watching parents pay, and then I would remove the slowest step and measure completion every week.']);
  await expect(coach(page).last()).toContainText('Tell me about a time you disagreed with engineering.');
  await expect(page.locator('[data-voice-status]')).toHaveText('Listening… tap the orb when you’re done');
  await expect(page.locator('[data-voice-live]')).toBeHidden();

  // "That's my answer" ends it at once; vague, so Ami follows up.
  await say(page, "We just talked it through. That's my answer.");
  await quiet(page, 800);
  await expect(coach(page).last()).toHaveText('What exactly was your own part, and what was the result?');

  // Spoken commands: no AI call.
  const before = (await turns(page)).length;
  await say(page, 'Can you repeat that?', 900);
  await quiet(page, 800);
  await expect(coach(page).last()).toHaveText('What exactly was your own part, and what was the result?');
  expect((await turns(page)).length).toBe(before);

  // Nothing said for 10 s: a gentle nudge, never a move on.
  await quiet(page, 10_500);
  await expect(page.locator('[data-voice-status]')).toHaveText('Take your time. I’m listening.');
  await expect(coach(page)).toHaveCount(4);
});

test('carrying on talking after the answer was sent takes it back and continues it (one answer, not two)', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  // Ami is slow to reply this time.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/career/interview', async (route) => {
    await held;
    await route.continue();
  }, { times: 1 });
  await say(page, 'I would interview parents first and find the slowest step in the checkout flow.');
  await quiet(page, 2000);
  await expect(mine(page)).toHaveCount(1);
  await rawSay(page, 'Then I would fix it and track completion weekly.');
  await expect(mine(page)).toHaveCount(0); // taken back: the reply to half an answer is ignored
  release();
  await quiet(page, 2000);
  await expect(mine(page)).toHaveText(['I would interview parents first and find the slowest step in the checkout flow. Then I would fix it and track completion weekly.']);
  await expect(coach(page).last()).toContainText('Tell me about a time you disagreed with engineering.');
  await expect(coach(page)).toHaveCount(2);
});

test('"let\'s stop here" by voice: check what I heard (editable), then a scorecard that says how they sounded', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await say(page, 'Um, basically I redesigned the checkout flow myself, and completion went up after launch, like, a lot.', 9000);
  await quiet(page, 2000);
  await expect(coach(page).last()).toContainText('Tell me about a time you disagreed with engineering.');
  await say(page, "Let's stop here.", 1000);
  await quiet(page, 800);
  await expect(coach(page).last()).toContainText("Let's stop there.");
  await expect(page.locator('[data-voice]')).toBeHidden(); // the microphone is off
  expect(await page.evaluate(() => (window as unknown as { __live(): boolean }).__live())).toBe(false);

  const review = page.locator('.cc-ivsetup__form', { hasText: 'Check what I heard' });
  await expect(review).toContainText('Your audio was never saved');
  await expect(page.locator('[data-ivbar]')).toContainText('Check what I heard');
  await expect(review.locator('textarea')).toHaveCount(1);
  await expect(review).toContainText('9 s · 113 words a minute · 3 filler words (um, like, basically)');
  await review.locator('textarea').fill('Um, basically I redesigned the checkout flow myself, and completion went up 12% after launch.');
  await review.getByRole('button', { name: 'Get my scorecard' }).click();

  await expect(page.locator('.cc-doccard__kind')).toHaveText('Interview scorecard');
  await expect(mine(page).first()).toContainText('completion went up 12% after launch'); // the fix is kept
  const feedback = (await sent(page)).filter((r) => r.output_config?.format?.schema?.properties?.readiness).at(-1)!;
  const said = typeof feedback.messages[0].content === 'string' ? feedback.messages[0].content : '';
  expect(said).toContain('completion went up 12% after launch');
  expect(said).toMatch(/\[spoken: 9 s, 113 words a minute, 3 filler words, 0 long pauses\]/);
  await expect(page.locator('.cc-preview')).toContainText('How you sounded');
  await expect(page.locator('.cc-preview')).toContainText('Delivery: 9 s');
  await expect(page.locator('.cc-ivsetup__done').last()).toContainText('You checked 1 spoken answer.');
});

test('a blocked microphone: Ami says why and lets them choose (nothing starts, no interview used, until they do)', async ({ page }) => {
  await fakeVoice(page, { denied: true });
  await startSpokenDenied(page);
  const blocked = page.locator('.cc-msg--note', { hasText: 'Your microphone is blocked' });
  await expect(blocked).toContainText("Your microphone is blocked for this site. To allow it, use the lock icon by this site's address → allow Microphone, then tap Try again. Or answer by typing.");
  await expect(blocked.locator('.cc-msg__code')).toHaveText('Code: NotAllowedError'); // for screenshots from phones
  await expect(coach(page)).toHaveCount(0); // not switched to typing by itself, and no interview used up

  // They allow it, then tap Try again: the spoken interview starts.
  await page.evaluate(() => ((window as unknown as { __micDenied?: boolean }).__micDenied = false));
  await blocked.getByRole('button', { name: 'Try again' }).click();
  await expect(coach(page).first()).toContainText('How would you improve checkout for schools?');
  await expect(page.locator('[data-voice]')).toBeVisible();
  await expect(blocked.getByRole('button', { name: /Try again|Type instead/ })).toHaveCount(0);
});

test('a blocked microphone → "Type instead": the interview carries on by typing, and "Speak instead" switches back later', async ({ page }) => {
  await fakeVoice(page, { denied: true });
  await startSpokenDenied(page);
  const blocked = page.locator('.cc-msg--note', { hasText: 'Your microphone is blocked' });
  await blocked.getByRole('button', { name: 'Type instead' }).click();
  await expect(coach(page).first()).toContainText('How would you improve checkout for schools?');
  await expect(page.locator('[data-voice]')).toBeHidden();
  await expect(page.locator('#cc-input')).toHaveAttribute('placeholder', 'Your answer…');

  // Later (say, after allowing the microphone and reloading), the bar offers speaking again.
  await page.reload();
  await expect(page.locator('[data-ivbar]')).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __micDenied?: boolean }).__micDenied = false));
  await page.locator('[data-ivbar]').getByRole('button', { name: 'Speak instead' }).click();
  await expect(page.locator('[data-voice]')).toBeVisible();
  await expect(page.locator('[data-ivbar]').getByRole('button', { name: 'Speak instead' })).toHaveCount(0);
});

async function startSpokenDenied(page: Page) {
  await withProfile(page);
  await page.locator('#cc-input').fill('mock interview me');
  await page.locator('#cc-input').press('Enter');
  const setup = page.locator('.cc-ivsetup__form');
  await setup.getByLabel('Job description').fill(JD);
  await setup.getByRole('button', { name: 'Start interview' }).click();
}

test('"Type instead" turns the microphone off and the interview carries on by typing', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await page.locator('[data-voice-type]').click();
  await expect(page.locator('[data-voice]')).toBeHidden();
  await expect(page.locator('#cc-input')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __live(): boolean }).__live())).toBe(false);
  await page.locator('#cc-input').fill('I would interview parents first, find the slowest step in checkout, fix it and measure completion every week.');
  await page.locator('#cc-input').press('Enter');
  await expect(coach(page).last()).toContainText('Tell me about a time you disagreed with engineering.');
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe: listening panel and check-what-I-heard (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await fakeVoice(page);
    await startSpoken(page);
    await say(page, 'I redesigned the checkout flow');
    const a = await new AxeBuilder({ page }).analyze();
    expect(a.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
    await quiet(page, 4200);
    await expect(mine(page)).toHaveCount(1);
    await expect(coach(page)).toHaveCount(2);
    await say(page, 'End the interview.', 900);
    await quiet(page, 800);
    await expect(page.locator('.cc-ivsetup__form', { hasText: 'Check what I heard' })).toBeVisible();
    const b = await new AxeBuilder({ page }).analyze();
    expect(b.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`)).toEqual([]);
  });
}

test('after a reload, spoken answers resume with one tap (the browser needs a tap to use the microphone)', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await page.reload();
  await expect(coach(page).first()).toContainText('How would you improve checkout for schools?');
  await expect(page.locator('[data-voice]')).toBeHidden();
  await page.locator('[data-ivbar]').getByRole('button', { name: 'Resume speaking' }).click();
  await expect(page.locator('[data-voice-status]')).toHaveText('Listening… tap the orb when you’re done');
  await say(page, 'I would interview parents first, find the slowest step in checkout, fix it and measure completion every week.');
  await quiet(page, 2000);
  await expect(coach(page).last()).toContainText('Tell me about a time you disagreed with engineering.');
});

test('Ami speaks every line; the answer she understood is shown with recognition slips fixed (never added to)', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  expect((await spokenLines(page))[0]).toContain('How would you improve checkout for schools?');
  // Ami is slow to reply: meanwhile the answer shows as heard, faded, "tidying".
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/career/interview', async (route) => {
    await held;
    await route.continue();
  }, { times: 1 });
  await say(page, 'I redesigned the check out flow at sample pay myself and completion went up after launch.');
  await quiet(page, 2000);
  await expect(page.locator('.cc-msg--user.is-raw .cc-msg__text')).toHaveText('I redesigned the check out flow at sample pay myself and completion went up after launch.');
  await expect(page.locator('.cc-msg__tidy')).toHaveText('Tidying what I heard…');
  release();
  await expect(page.locator('.cc-msg__tidy')).toHaveCount(0);
  await expect(page.locator('.cc-msg--user.is-raw')).toHaveCount(0);
  await expect(mine(page).last()).toHaveText('I redesigned the checkout flow at Sample Pay myself and completion went up after launch.');
  await expect(coach(page).last()).toContainText('Tell me about a time you disagreed with engineering.');
  // Her reply is spoken sentence by sentence as it streams in.
  await expect.poll(async () => (await spokenLines(page)).join(' ')).toContain('Thanks. Tell me about a time you disagreed with engineering.');

  // A "correction" that adds a claim is refused: their words stay as heard.
  await say(page, 'We argued about scope, so I wrote a one page trade off and we agreed in a day. INVENT');
  await quiet(page, 4200); // no full stop at the end: a longer pause before it counts as finished
  await expect(mine(page).last()).toHaveText('We argued about scope, so I wrote a one page trade off and we agreed in a day. INVENT');

  // Ami's voice can be turned off; the orb then just listens.
  await expect(page.locator('[data-voice-status]')).toHaveText('Listening… tap the orb when you’re done');
  const before = (await spokenLines(page)).length;
  await page.locator('[data-voice-mute]').click();
  await expect(page.locator('[data-voice-mute]')).toHaveText('Ami’s voice: off');
  await say(page, 'I measure completion, time to pay and support tickets, and I set the target before launch.');
  await quiet(page, 2000);
  await expect(coach(page)).toHaveCount(4);
  expect((await spokenLines(page)).length).toBe(before);
});

test('the speech model downloads in the background: the first question is asked meanwhile, then Ami listens', async ({ page }) => {
  await fakeVoice(page, { slowModel: true });
  await withProfile(page);
  await page.locator('#cc-input').fill('mock interview me');
  await page.locator('#cc-input').press('Enter');
  const setup = page.locator('.cc-ivsetup__form');
  await setup.getByLabel('Job description').fill(JD);
  await setup.getByRole('button', { name: 'Start interview' }).click();
  await expect(coach(page).first()).toContainText('How would you improve checkout for schools?');
  await expect(page.locator('[data-voice-status]')).toHaveText('Getting ready to listen… 21 of 43 MB (only the first time)');
  await page.evaluate(() => (window as unknown as { __releaseModel(): void }).__releaseModel());
  await expect(page.locator('[data-voice-status]')).toHaveText('Listening… tap the orb when you’re done');
});

test('the final text is the whole answer read at once (more accurate than the pieces)', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await page.evaluate(() => {
    const w = window as unknown as { __whole: string; __sayAudio(t: string, n: number, ms: number): boolean };
    w.__whole = 'I would interview parents first, then remove the slowest step in checkout and track completion weekly.';
    w.__sayAudio('I would interview parent first then', 16000, 2000);
  });
  await quiet(page, 1200);
  await page.evaluate(() => (window as unknown as { __sayAudio(t: string, n: number, ms: number): boolean }).__sayAudio('remove the slow step in check out and track completion weekly.', 24000, 3000));
  await quiet(page, 2000);
  await expect(mine(page)).toHaveText(['I would interview parents first, then remove the slowest step in checkout and track completion weekly.']);
});

test('tap the orb when you are done: the answer goes at once, whatever the room noise or the wording', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await page.locator('[data-voice-orb]').click(); // nothing said yet: nothing to send
  await expect(page.locator('[data-voice-status]')).toHaveText('Listening… say your answer, then tap the orb');
  await expect(mine(page)).toHaveCount(0);
  await say(page, 'At my last company I led the zero to one launch of our creative studio and');
  await expect(page.locator('[data-voice-live]')).toContainText('creative studio and');
  await expect(page.locator('[data-voice-orb]')).toHaveAttribute('aria-label', 'I’m done answering');
  await page.locator('[data-voice-orb]').click(); // no pause needed, even after a trailing "and"
  await expect(mine(page)).toHaveText(['At my last company I led the zero to one launch of our creative studio and']);
  await expect(coach(page)).toHaveCount(2);
});

test('"I am done" and "that will be all" end an answer quickly', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await say(page, 'I interviewed parents, cut the checkout from five steps to two, and completion went up. I am done.');
  await quiet(page, 800);
  await expect(mine(page)).toHaveCount(1);
  await say(page, 'We disagreed on scope, I wrote up the trade-offs and we agreed within a day. That will be all.');
  await quiet(page, 800);
  await expect(mine(page)).toHaveCount(2);
});

test('noise is not speech: after "I am done", a fan or a cough never pulls the answer back (the bug that got stuck)', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  const status = page.locator('[data-voice-status]');
  // A long answer that ends "I am done", then the fan kicks in (the recogniser hears nothing in it).
  await say(page, 'Alright, so at Spidra I worked as a product manager on our products from zero to launch, and the way I made that work was weekly discovery with real customers.', 20_000);
  await quiet(page, 1500);
  await rawSay(page, '[BLANK_AUDIO]', 900);
  await rawSay(page, 'I am done.', 900);
  await rawSay(page, '', 1500); // fan
  await expect(mine(page)).toHaveCount(1);
  await expect(mine(page).last()).toContainText('I am done.');
  await expect(coach(page)).toHaveCount(2);

  // No finishing phrase, with noise blips between the pauses: the quiet still adds up and the answer goes.
  await say(page, 'We disagreed about scope, so I wrote up the trade-offs and we agreed within a day.');
  await quiet(page, 1000);
  await rawSay(page, '', 800); // cough
  await quiet(page, 300);
  await expect(mine(page)).toHaveCount(2);
  await expect(status).not.toHaveText('Listening… tap the orb when you’re done');

  // Noise after an answer was sent doesn't take it back.
  await expect(coach(page)).toHaveCount(3);
  await say(page, 'I measure adoption, completion and support tickets, and I set the target before launch.');
  await quiet(page, 2000);
  await rawSay(page, '(fan whirring)', 1200);
  await expect(coach(page)).toHaveCount(4);
  await expect(mine(page)).toHaveCount(3);
});

test('tapping the orb always sends, even while noise keeps going', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await say(page, 'At my last company I led the zero to one launch of our creative studio and');
  await rawSay(page, '', 2000); // noise, no words
  await page.locator('[data-voice-orb]').click();
  await expect(mine(page)).toHaveText(['At my last company I led the zero to one launch of our creative studio and']);
});

test('feels like a person: an instant "mm-hm" when you finish, a face that reacts, her reply spoken as it streams', async ({ page }) => {
  await fakeVoice(page);
  await startSpoken(page);
  await expect(page.locator('[data-voice]')).toHaveAttribute('data-react', /smile|neutral/); // a warm hello
  // Ami's reply is held back, to show what happens in the meantime.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/career/interview', async (route) => {
    await held;
    await route.continue();
  }, { times: 1 });
  const before = (await spokenLines(page)).length;
  await say(page, 'I redesigned the checkout flow myself and completion went up by twelve percent after launch.');
  await quiet(page, 2000);
  // The instant acknowledgement (neutral interviewer), before her reply exists, and a nod.
  await expect.poll(async () => (await spokenLines(page)).slice(before)).toEqual([expect.stringMatching(/^(Okay, thank you\.|Got it\.|Mm-hm, thanks\.|Right, thank you\.)$/)]);
  await expect(page.locator('[data-voice]')).toHaveAttribute('data-react', 'nod');
  const turnsBefore = (await (await page.request.get(`${CLAUDE}/__requests`)).json()) as unknown[];
  release();
  await expect(coach(page).last()).toContainText('Tell me about a time you disagreed with engineering.');
  await expect(page.locator('[data-voice]')).toHaveAttribute('data-react', 'impressed'); // a specific answer
  // She was told she'd already acknowledged it, so she doesn't thank them twice.
  const sent = ((await (await page.request.get(`${CLAUDE}/__requests`)).json()) as { messages: { content: string | { text: string }[] }[] }[]).slice(turnsBefore.length);
  const status = sent.map((r) => (Array.isArray(r.messages[0].content) ? r.messages[0].content.map((b) => b.text).join('') : r.messages[0].content)).join('');
  expect(status).toMatch(/You already acknowledged their answer out loud \("(Okay, thank you\.|Got it\.|Mm-hm, thanks\.|Right, thank you\.)"\)/);
  // Her own "mm-hm" leaking into the microphone is not them talking.
  await say(page, 'We disagreed on scope, so I wrote up the trade-offs and we agreed in a day.');
  await quiet(page, 2000);
  const ack = (await spokenLines(page)).at(-3) ?? '';
  await expect(coach(page)).toHaveCount(3);
  void ack;
});
