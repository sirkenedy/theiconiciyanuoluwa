// Tailor / improve / cover letter endpoints and the code-level no-fabrication check. `npm run test:api`
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startFakeUpstash, FAKE_TOKEN } from './fake-upstash.mjs';
import { startFakeClaude, HONEST_WRITE, INVENTED_WRITE, SAMPLE_PROFILE } from './fake-claude.mjs';
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, signingInput } from '../src/lib/career/signing.ts';
import { DAILY_LIMITS, localDay } from '../src/lib/career/limits.ts';
import { checkResume, checkText } from '../src/lib/career/factcheck.ts';
import { changedKeys, contactLine, fileBase, profileToResume, setLine } from '../src/lib/career/document.ts';
import type { Profile } from '../src/lib/career/types.ts';

let servers: Server[] = [];
let redisUrl = '';
let claude: Awaited<ReturnType<typeof startFakeClaude>>;
const RESUME = 'Sample Candidate\nProduct Designer, Example Fintech, 2020 – Present\n- Redesigned the checkout flow used daily by thousands of customers.\n- Ran user research and A/B tests end to end with the growth team.\nSkills: Figma, user research, product discovery\nEducation: B.A. Design';
const JOB = { title: 'Product Manager, Payments', company: 'Sample Pay', description: `We're hiring a Product Manager for payments. ${'You will own discovery, the roadmap and A/B testing for checkout; SQL is a plus. '.repeat(4)}` };
const profile = SAMPLE_PROFILE as Profile;

before(async () => {
  const redis = await startFakeUpstash();
  claude = await startFakeClaude();
  servers = [redis.server, claude.server];
  redisUrl = redis.url;
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url });
});
after(() => servers.forEach((s) => s.close()));
beforeEach(() => {
  claude.requests.length = 0;
  claude.state.write = HONEST_WRITE;
  claude.state.analysis = null;
});

type Device = { pair: CryptoKeyPair; id: string };
let ipN = 50;
async function device(): Promise<Device & { ip: string }> {
  const ip = `203.0.113.${ipN++}`;
  const { POST } = await import('../src/pages/api/device/register.ts');
  const pair = (await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.parse(canonicalJwk(await crypto.subtle.exportKey('jwk', pair.publicKey))!);
  const res = await POST({ request: new Request('https://x.test/api/device/register', { method: 'POST', body: JSON.stringify({ jwk }) }), clientAddress: ip } as never);
  return { pair, id: (await res.json()).deviceId, ip };
}
async function call(route: 'tailor' | 'cover-letter', d: Device & { ip: string }, payload: Record<string, unknown>) {
  const mod = route === 'tailor' ? await import('../src/pages/api/career/tailor.ts') : await import('../src/pages/api/career/cover-letter.ts');
  const path = `/api/career/${route}`;
  const body = JSON.stringify({ profile: SAMPLE_PROFILE, resume: RESUME, day: localDay(), ...payload });
  const ts = String(Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64url(await crypto.subtle.sign(ECDSA_SIGN, d.pair.privateKey, await signingInput('POST', path, ts, nonce, body)));
  return mod.POST({ request: new Request(`https://x.test${path}`, { method: 'POST', headers: { [HEADER.device]: d.id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig, 'x-forwarded-for': d.ip }, body }), clientAddress: d.ip } as never) as Promise<Response>;
}
async function events(res: Response) {
  const out: Record<string, unknown[]> = {};
  for (const block of (await res.text()).split('\n\n').filter(Boolean)) {
    const event = block.match(/^event: (.+)$/m)![1];
    (out[event] ??= []).push(JSON.parse(block.match(/^data: (.+)$/m)![1]));
  }
  return out;
}

// ---------- the no-fabrication check ----------

test('factcheck: a faithful rewrite passes; invented numbers, tools, employers and titles are flagged', () => {
  assert.deepEqual(checkResume(HONEST_WRITE.tailored, profile, RESUME, [{ question: 'A/B tests?', answer: 'About 6' }]), []);
  const flags = checkResume(INVENTED_WRITE.tailored, profile, RESUME);
  const text = flags.map((f) => `${f.kind}:${f.text}`);
  assert.ok(text.includes('number:37'), text.join(', '));
  assert.ok(text.includes('name:SQL'));
  assert.ok(text.includes('employer:Invented Corp'));
});

test('factcheck: numbers the visitor gave in answers are allowed; dates and titles must match the profile', () => {
  const t = { ...HONEST_WRITE.tailored, experience: [{ ...HONEST_WRITE.tailored.experience[0], bullets: ['Ran 6 A/B tests on payment steps.'] }] };
  assert.deepEqual(checkResume(t, profile, RESUME, [{ question: 'How many?', answer: 'About 6, the winner became the default' }]), []);
  assert.deepEqual(checkResume(t, profile, RESUME).map((f) => f.kind), ['number']);
  const retitled = { ...t, experience: [{ ...t.experience[0], role: 'Head of Design', dates: '2019 – Present', bullets: [] }] };
  assert.deepEqual(checkResume(retitled, profile, RESUME).map((f) => f.kind).sort(), ['date', 'title']);
});

test('factcheck: cover letters may name the target company; anything else new is flagged', () => {
  assert.deepEqual(checkText('Dear Sample Pay team, I led the checkout redesign at Example Fintech.', profile, RESUME, [], ['Sample Pay']), []);
  const flags = checkText('At Example Fintech I cut costs by 45% using Salesforce.', profile, RESUME);
  assert.deepEqual(flags.map((f) => f.text).sort(), ['45', 'Salesforce']);
});

test('document helpers: changed lines, local contact line, file name, line edits', () => {
  const before = profileToResume(profile);
  const keys = changedKeys(before, HONEST_WRITE.tailored);
  assert.ok(keys.includes('summary') && keys.includes('exp.0.bullets.0'));
  assert.ok(!keys.includes('skills.0.items.2'), 'Figma was already there');
  assert.equal(contactLine('Sample Candidate\nsample@mail.test · +234 801 234 5678 · linkedin.com/in/sample', 'Lagos, Nigeria'), 'Lagos, Nigeria · sample@mail.test · +234 801 234 5678 · linkedin.com/in/sample');
  assert.equal(fileBase('Sample Candidate', 'resume', 'Sample Pay', 'Product Manager, Payments'), 'sample-candidate-resume-sample-pay-product-manager-payments');
  assert.equal(setLine(HONEST_WRITE.tailored, 'exp.0.bullets.1', 'Edited').experience[0].bullets[1], 'Edited');
});

// ---------- endpoints ----------

test('tailor analyze: match + quick questions, Haiku, structured output; counts as a message', async () => {
  const d = await device();
  const res = await call('tailor', d, { mode: 'tailor', phase: 'analyze', job: JOB });
  assert.equal(res.status, 200);
  const { analysis } = await res.json();
  assert.equal(analysis.match.length, 3);
  assert.equal(analysis.questions.length, 1);
  const sent = claude.requests[0] as { model: string; output_config: { format: { type: string } }; messages: { content: string }[] };
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.match(sent.messages[0].content, /task = "tailor_analyze"[\s\S]*<resume>[\s\S]*<job>[\s\S]*Sample Pay/);
});

test('tailor analyze: an over-long analysis (long job ad) is trimmed, not a 502', async () => {
  const m = (kind: string, text: string) => ({ kind, text });
  claude.state.analysis = {
    role: 'Product Manager',
    company: 'Sample Pay',
    match: [m('strong', 'x'.repeat(320)), m('added', 'discovery'), m('missing', 'SQL'), m('strong', 'fintech'), m('added', 'roadmap'), m('missing', 'Kafka')],
    questions: [1, 2, 3, 4].map((n) => ({ id: `question_about_metric_${n}`, question: 'How many?' })),
  };
  const res = await call('tailor', await device(), { mode: 'tailor', phase: 'analyze', job: { ...JOB, description: JOB.description.repeat(40) } });
  assert.equal(res.status, 200);
  const { analysis } = await res.json();
  assert.equal(analysis.match.length, 5);
  assert.equal(analysis.match[0].text.length, 300);
  assert.equal(analysis.questions.length, 3);
  assert.ok(analysis.questions.every((q: { id: string }) => q.id.length <= 20));
  assert.equal(claude.requests.length, 1, 'no retry needed');
});

test('tailor write: streamed progress then the result; the answers ride along and count as facts', async () => {
  const d = await device();
  const answers = [{ question: 'How many A/B tests?', answer: 'About 6' }];
  const out = await events(await call('tailor', d, { mode: 'tailor', phase: 'write', job: JOB, answers }));
  const [result] = out.result as { result: typeof HONEST_WRITE; flags: unknown[] }[];
  assert.deepEqual(result.flags, []);
  assert.equal(result.result.ats.after, 88);
  assert.deepEqual(result.result.critique, [], 'no critique for tailoring');
  assert.match((claude.requests[0] as { messages: { content: string }[] }).messages[0].content, /<answers>\[\{"question":"How many A\/B tests\?","answer":"About 6"\}\]<\/answers>/);
});

test('tailor write: inventions come back flagged, never silently shipped', async () => {
  claude.state.write = INVENTED_WRITE;
  const out = await events(await call('tailor', await device(), { mode: 'tailor', phase: 'write', job: JOB }));
  const [{ flags }] = out.result as { flags: { kind: string; text: string }[] }[];
  assert.deepEqual(flags.map((f) => f.kind).sort(), ['employer', 'name', 'number']);
});

test('improve: no job needed, returns the 5-point critique', async () => {
  const d = await device();
  const a = await call('tailor', d, { mode: 'improve', phase: 'analyze' });
  assert.equal((await a.json()).analysis.role, null);
  const out = await events(await call('tailor', d, { mode: 'improve', phase: 'write' }));
  const [{ result }] = out.result as { result: { critique: { area: string }[] } }[];
  assert.deepEqual(result.critique.map((c) => c.area), ['clarity', 'impact', 'keywords', 'structure', 'length']);
});

test(`tailored résumés: ${DAILY_LIMITS.tailored} a day per device; one more is refused before any model call`, async () => {
  const d = await device();
  for (let i = 0; i < DAILY_LIMITS.tailored; i++) await events(await call('tailor', d, { mode: 'improve', phase: 'write' }));
  const before = claude.requests.length;
  const third = await call('tailor', d, { mode: 'improve', phase: 'write' });
  assert.equal(third.status, 429);
  assert.equal(claude.requests.length, before);
});

test('a found job uses the description stored at ingest; an expired one asks for the text', async () => {
  await fetch(`${redisUrl}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${FAKE_TOKEN}` }, body: JSON.stringify([['SET', 'jobs:desc:greenhouse:sample:1', JOB.description]]) });
  const d = await device();
  const ok = await call('tailor', d, { mode: 'tailor', phase: 'analyze', job: { jobId: 'greenhouse:sample:1', title: JOB.title, company: JOB.company } });
  assert.equal(ok.status, 200);
  assert.match((claude.requests.at(-1) as { messages: { content: string }[] }).messages[0].content, /You will own discovery/);
  const gone = await call('tailor', d, { mode: 'tailor', phase: 'analyze', job: { jobId: 'greenhouse:sample:999' } });
  assert.equal(gone.status, 410);
});

test(`cover letter: streamed, checked, ${DAILY_LIMITS.letters} a day`, async () => {
  const d = await device();
  const out = await events(await call('cover-letter', d, { job: JOB }));
  const text = (out.token as { t: string }[]).map((t) => t.t).join('');
  assert.match(text, /^Dear hiring team,/);
  assert.deepEqual((out.flags as { flags: unknown[] }[])[0].flags, []);
  for (let i = 1; i < DAILY_LIMITS.letters; i++) await events(await call('cover-letter', d, { job: JOB }));
  const second = await call('cover-letter', d, { job: JOB });
  assert.equal(second.status, 429);
});

test('cover letter: if the model replies instead of writing a letter, it is a message, not a document, and not counted', async () => {
  const d = await device();
  const saved = claude.state.letter;
  claude.state.letter = ["Thanks for sharing the posting. This role requires US residency; if you're eligible, tell me and I'll write the letter."];
  try {
    const out = await events(await call('cover-letter', d, { job: JOB }));
    assert.match((out.message as { text: string }[])[0].text, /tell me and I'll write the letter/);
    assert.equal(out.flags, undefined, 'no document checks');
    claude.state.letter = saved;
    for (let i = 0; i < DAILY_LIMITS.letters; i++) assert.equal((await call('cover-letter', d, { job: JOB })).status, 200, 'all of today\'s letters still available');
    assert.equal((await call('cover-letter', d, { job: JOB })).status, 429);
  } finally {
    claude.state.letter = saved;
  }
});

test('factcheck: punctuation around a word is not part of it ("Canada)." is Canada, already in the profile)', () => {
  const p = { ...profile, location: 'Ontario, Canada' } as Profile;
  assert.deepEqual(checkText('I am based in Ontario (Ontario, Canada). Happy to relocate.', p, RESUME), []);
});
