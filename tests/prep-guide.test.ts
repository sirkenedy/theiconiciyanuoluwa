// Interview prep guides: Sonnet researches the company on the public web (job-review sites blocked) and writes a guide
// that follows the visitor's own instructions. Fake Claude + fake Upstash: no key, no cost. `npm run test:api`
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startFakeUpstash, FAKE_TOKEN } from './fake-upstash.mjs';
import { startFakeClaude, SAMPLE_PROFILE } from './fake-claude.mjs';
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, signingInput } from '../src/lib/career/signing.ts';
import { DAILY_LIMITS, localDay } from '../src/lib/career/limits.ts';
import { SONNET_RATES, costMicros } from '../src/lib/career/spend.ts';

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
let n = 10;
async function device(): Promise<Device> {
  const ip = `203.0.114.${n++}`;
  const { POST } = await import('../src/pages/api/device/register.ts');
  const pair = (await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.parse(canonicalJwk(await crypto.subtle.exportKey('jwk', pair.publicKey))!);
  const res = await POST({ request: new Request('https://x.test/api/device/register', { method: 'POST', body: JSON.stringify({ jwk }) }), clientAddress: ip } as never);
  return { pair, id: (await res.json()).deviceId, ip };
}
async function guide(d: Device, payload: Record<string, unknown>) {
  const { POST } = await import('../src/pages/api/career/prep-guide.ts');
  const path = '/api/career/prep-guide';
  const body = JSON.stringify({ profile: SAMPLE_PROFILE, resume: RESUME, job: JOB, day: localDay(), ...payload });
  const ts = String(Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64url(await crypto.subtle.sign(ECDSA_SIGN, d.pair.privateKey, await signingInput('POST', path, ts, nonce, body)));
  const res = (await POST({ request: new Request(`https://x.test${path}`, { method: 'POST', headers: { [HEADER.device]: d.id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig, 'x-forwarded-for': d.ip }, body }), clientAddress: d.ip } as never)) as Response;
  const out: Record<string, unknown[]> = {};
  if (res.headers.get('content-type')?.includes('event-stream')) {
    for (const block of (await res.text()).split('\n\n').filter(Boolean)) (out[block.match(/^event: (.+)$/m)![1]] ??= []).push(JSON.parse(block.match(/^data: (.+)$/m)![1]));
  }
  return { res, out };
}
type GuideOut = { guide: { title: string; sections: { heading: string; items: { kind: string; answer: string[] }[] }[]; sources: { url: string }[] }; flags: unknown[] };

test('prep guide: Sonnet researches (review sites blocked), then writes; sources cited; answers from the résumé', async () => {
  const { res, out } = await guide(await device(), { instructions: '' });
  assert.match(res.headers.get('content-type') ?? '', /event-stream/);
  const [research, write] = claude.requests as { model: string; tools?: { type: string; blocked_domains?: string[] }[]; messages: { content: string }[] }[];
  assert.equal(research.model, 'claude-sonnet-5-5');
  assert.equal(research.tools![0].type, 'web_search_20260209');
  for (const site of ['glassdoor.com', 'indeed.com', 'linkedin.com']) assert.ok(research.tools![0].blocked_domains!.includes(site), site);
  assert.equal(write.model, 'claude-sonnet-5-5');
  for (const r of [research, write] as { thinking?: { type: string } }[]) assert.equal(r.thinking?.type, 'between_tools', 'Sonnet 5.5 rejects "disabled"');
  assert.match(write.messages[0].content, /task = "prep_guide"[\s\S]*<research>\nSample Pay builds checkout[\s\S]*<instructions>none: use the default guide<\/instructions>/);
  const result = out.result![0] as GuideOut;
  assert.deepEqual(result.guide.sections.map((s) => s.heading), ['Product sense', 'Behavioural']);
  assert.ok(result.guide.sources.some((s) => s.url === 'https://samplepay.test/about'), 'the cited page is a source');
  assert.match(result.guide.sections[0].items[0].answer[0], /Redesigned the checkout flow/);
  assert.ok((out.progress as { text: string }[]).some((p) => /Researching Sample Pay/.test(p.text)));
});

test('prep guide: follows the visitor\'s own instructions ("a 3-day plan", "no behavioural questions")', async () => {
  const plan = (await guide(await device(), { instructions: 'I want a 3-day prep plan' })).out.result![0] as GuideOut;
  assert.deepEqual(plan.guide.sections.map((s) => s.heading), ['Day 1', 'Day 2', 'Day 3']);
  const sent = (claude.requests.at(-1) as { messages: { content: string }[] }).messages[0].content;
  assert.match(sent, /<instructions>I want a 3-day prep plan<\/instructions>/);
  const noBehavioural = (await guide(await device(), { instructions: 'no behavioural questions please' })).out.result![0] as GuideOut;
  assert.deepEqual(noBehavioural.guide.sections.map((s) => s.heading), ['Product sense']);
});

test(`prep guide: ${DAILY_LIMITS.guides} a day per device; a short job is refused before any model call; costs at Sonnet rates incl. searches`, async () => {
  const d = await device();
  const spendKey = `career:spend:${new Date().toISOString().slice(0, 10)}`;
  redis.kv.delete(spendKey);
  for (let i = 0; i < DAILY_LIMITS.guides; i++) await guide(d, {});
  const usage = { input_tokens: 50, output_tokens: 20 };
  const perGuide = costMicros({ ...usage, server_tool_use: { web_search_requests: 2 } }, SONNET_RATES) + costMicros(usage, SONNET_RATES);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(Number(redis.kv.get(spendKey)), perGuide * DAILY_LIMITS.guides, 'Sonnet tokens + USD 10 per 1,000 searches');
  const before = claude.requests.length;
  const over = await guide(d, {});
  assert.equal(over.res.status, 429);
  assert.equal(claude.requests.length, before);
  const short = await guide(await device(), { job: { title: 'PM', description: 'Too short' } });
  assert.equal(short.res.status, 422);
});
