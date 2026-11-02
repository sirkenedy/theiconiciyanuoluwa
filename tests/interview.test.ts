// Mock interviews (/api/career/interview): start takes a daily interview and opens a session; turns send the whole
// transcript; only allowed actions can be chosen; a turn cap; one scorecard per session. Fake Claude + fake Upstash.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startFakeUpstash, FAKE_TOKEN } from './fake-upstash.mjs';
import { startFakeClaude, SAMPLE_PROFILE } from './fake-claude.mjs';
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, signingInput } from '../src/lib/career/signing.ts';
import { DAILY_LIMITS, localDay } from '../src/lib/career/limits.ts';

let servers: Server[] = [];
let redis: Awaited<ReturnType<typeof startFakeUpstash>>;
let claude: Awaited<ReturnType<typeof startFakeClaude>>;
const RESUME = 'Sample Candidate\nProduct Designer, Example Fintech, 2020 – Present\n- Redesigned the checkout flow used daily by thousands of customers.\n- Ran user research and A/B tests end to end with the growth team.\nSkills: Figma, user research, product discovery';
const JOB = { title: 'Product Manager, Payments', company: 'Sample Pay', description: `We're hiring a Product Manager for payments. ${'You will own discovery, the roadmap and A/B testing for checkout; SQL is a plus. '.repeat(4)}` };

before(async () => {
  redis = await startFakeUpstash();
  claude = await startFakeClaude();
  servers = [redis.server, claude.server];
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url });
});
after(() => servers.forEach((s) => s.close()));
beforeEach(() => {
  claude.requests.length = 0;
});

type Device = { pair: CryptoKeyPair; id: string; ip: string };
let n = 60;
async function device(): Promise<Device> {
  const ip = `203.0.114.${n++}`;
  const { POST } = await import('../src/pages/api/device/register.ts');
  const pair = (await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.parse(canonicalJwk(await crypto.subtle.exportKey('jwk', pair.publicKey))!);
  const res = await POST({ request: new Request('https://x.test/api/device/register', { method: 'POST', body: JSON.stringify({ jwk }) }), clientAddress: ip } as never);
  return { pair, id: (await res.json()).deviceId, ip };
}

const rc = async (cmd: string[]) => ((await (await fetch(`${redis.url}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${FAKE_TOKEN}` }, body: JSON.stringify([cmd]) })).json()) as { result: unknown }[])[0].result;
const SETUP = { questions: 4, style: 'neutral', instructions: '' };
async function call(d: Device, payload: Record<string, unknown>) {
  const { POST } = await import('../src/pages/api/career/interview.ts');
  const path = '/api/career/interview';
  const body = JSON.stringify({ profile: SAMPLE_PROFILE, resume: RESUME, setup: SETUP, day: localDay(), transcript: [], job: {}, ...payload });
  const ts = String(Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64url(await crypto.subtle.sign(ECDSA_SIGN, d.pair.privateKey, await signingInput('POST', path, ts, nonce, body)));
  const res = (await POST({ request: new Request(`https://x.test${path}`, { method: 'POST', headers: { [HEADER.device]: d.id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig, 'x-forwarded-for': d.ip }, body }), clientAddress: d.ip } as never)) as Response;
  if (res.headers.get('content-type')?.includes('event-stream')) {
    const out: Record<string, unknown[]> = {};
    for (const block of (await res.text()).split('\n\n').filter(Boolean)) (out[block.match(/^event: (.+)$/m)![1]] ??= []).push(JSON.parse(block.match(/^data: (.+)$/m)![1]));
    return { res, body: out as Record<string, unknown[]> };
  }
  return { res, body: (await res.json()) as Record<string, unknown> };
}
type Turn = { action: string; say: string; note: string | null };
type Entry = { who: 'ami'; kind: string; text: string } | { who: 'you'; text: string; note?: string | null };

test('interview: start takes one interview, asks the first question, and keeps the job with the session', async () => {
  const d = await device();
  const { res, body } = await call(d, { phase: 'start', job: JOB });
  assert.equal(res.status, 200);
  const turn = body.turn as Turn;
  assert.equal(turn.action, 'ask');
  assert.equal(turn.note, null);
  assert.match(String(body.sid), /^[a-z0-9]{16,40}$/);
  const [sent] = claude.requests as { model: string; messages: { content: { text: string; cache_control?: unknown }[] }[]; output_config: { format: { schema: { properties: { action: { enum: string[] } } } } } }[];
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.deepEqual(sent.output_config.format.schema.properties.action.enum, ['ask'], 'the opening can only ask');
  assert.ok(sent.messages[0].content[0].cache_control, 'résumé, job and setup are cached across turns');
  assert.match(sent.messages[0].content[0].text, /task = "mock_interview"[\s\S]*Product Manager, Payments[\s\S]*<setup>/);
  const used = await rc(['HGET', `career:use:${d.id}:${localDay()}`, 'interviews']);
  assert.equal(used, '1');
});

test('interview: a turn sends the whole transcript with notes; allowed actions follow the budget and the follow-up cap', async () => {
  const d = await device();
  const { body } = await call(d, { phase: 'start', job: JOB });
  const sid = body.sid as string;
  const t: Entry[] = [{ who: 'ami', kind: 'ask', text: 'Q1?' }, { who: 'you', text: 'We did stuff.' }];
  const first = await call(d, { phase: 'turn', sid, transcript: t });
  assert.equal((first.body.turn as Turn).action, 'follow_up');
  const req = claude.requests.at(-1) as { messages: { content: { text: string }[] }[]; output_config: { format: { schema: { properties: { action: { enum: string[] } } } } } };
  assert.deepEqual(req.output_config.format.schema.properties.action.enum, ['ask', 'follow_up', 'reply']);
  assert.match(req.messages[0].content[1].text, /Candidate: We did stuff\./);

  // Two follow-ups already on this question: no third.
  const capped: Entry[] = [{ who: 'ami', kind: 'ask', text: 'Q1?' }, { who: 'you', text: 'a', note: 'Vague.' }, { who: 'ami', kind: 'follow_up', text: 'F1?' }, { who: 'you', text: 'b' }, { who: 'ami', kind: 'follow_up', text: 'F2?' }, { who: 'you', text: 'c' }];
  await call(d, { phase: 'turn', sid, transcript: capped });
  const capReq = claude.requests.at(-1) as { messages: { content: { text: string }[] }[]; output_config: { format: { schema: { properties: { action: { enum: string[] } } } } } };
  assert.deepEqual(capReq.output_config.format.schema.properties.action.enum, ['ask', 'reply']);
  assert.match(capReq.messages[0].content[1].text, /\[your private note: Vague\.\]/);

  // All 4 main questions asked: only a reply or the close.
  const done: Entry[] = [1, 2, 3, 4].flatMap((i) => [{ who: 'ami' as const, kind: 'ask', text: `Q${i}?` }, { who: 'you' as const, text: 'I led it and the result was a 20% lift in completion over the quarter.' }]);
  const last = await call(d, { phase: 'turn', sid, transcript: done });
  assert.equal((last.body.turn as Turn).action, 'end');
});

test('interview: no session, no turn; the turn cap; a turn must answer something', async () => {
  const d = await device();
  const answered: Entry[] = [{ who: 'ami', kind: 'ask', text: 'Q1?' }, { who: 'you', text: 'Answer.' }];
  const none = await call(d, { phase: 'turn', sid: 'abcdefghijklmnop1234', transcript: answered });
  assert.equal(none.res.status, 410);
  assert.equal(none.body.error, 'session-expired');
  const { body } = await call(d, { phase: 'start', job: JOB });
  const sid = body.sid as string;
  const wrong = await call(d, { phase: 'turn', sid, transcript: [{ who: 'ami', kind: 'ask', text: 'Q1?' }] });
  assert.equal(wrong.res.status, 400);
  await rc(['HSET', `career:iv:${d.id}:${sid}`, 'turns', '30']);
  const over = await call(d, { phase: 'turn', sid, transcript: answered });
  assert.equal(over.res.status, 429);
  assert.equal(over.body.kind, 'turns');
});

test('interview: one scorecard per session (Sonnet), built as a guide; nothing to score without answers', async () => {
  const d = await device();
  const { body } = await call(d, { phase: 'start', job: JOB });
  const sid = body.sid as string;
  const empty = await call(d, { phase: 'feedback', sid, transcript: [{ who: 'ami', kind: 'ask', text: 'Q1?' }, { who: 'you', text: '(skipped)' }] });
  assert.equal(empty.res.status, 422);
  const t: Entry[] = [{ who: 'ami', kind: 'ask', text: 'How would you improve checkout for schools?' }, { who: 'you', text: 'I redesigned the checkout flow and completion went up.' }, { who: 'ami', kind: 'end', text: 'Thanks.' }];
  const first = await call(d, { phase: 'feedback', sid, transcript: t });
  const result = (first.body as Record<string, unknown[]>).result[0] as { feedback: { score: number }; guide: { title: string; sections: { heading: string; items: { title: string | null; bullets: string[] }[] }[] } };
  assert.equal(result.guide.title, 'Interview scorecard');
  assert.deepEqual(result.guide.sections.map((s) => s.heading), ['Overall: 3.5/5 · Almost ready', 'Question by question', 'Transcript']);
  assert.equal(result.guide.sections[1].items[0].title, 'How would you improve checkout for schools? (3/5)');
  assert.ok(result.guide.sections[1].items[0].bullets.includes('Answer length: 9 words'));
  assert.equal((claude.requests.at(-1) as { model: string }).model, 'claude-sonnet-5-5');
  const again = await call(d, { phase: 'feedback', sid, transcript: t });
  assert.equal(again.res.status, 409);
});

test('interview: 2 a day per device; a failed start gives the interview back', async () => {
  const d = await device();
  for (let i = 0; i < DAILY_LIMITS.interviews; i++) assert.equal((await call(d, { phase: 'start', job: JOB })).res.status, 200);
  const third = await call(d, { phase: 'start', job: JOB });
  assert.equal(third.res.status, 429);
  assert.equal(third.body.kind, 'interviews');

  const e = await device();
  const short = await call(e, { phase: 'start', job: { description: 'Too short.' } });
  assert.equal(short.res.status, 422);
  assert.equal(await rc(['HGET', `career:use:${e.id}:${localDay()}`, 'interviews']), null, 'nothing taken for a bad job');
});
