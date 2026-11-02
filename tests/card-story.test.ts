// Progress-card stories (/api/career/card-story): written from what's on the card only, never an invented number.
// Fake Claude + fake Upstash.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startFakeUpstash, FAKE_TOKEN } from './fake-upstash.mjs';
import { startFakeClaude, SAMPLE_PROFILE } from './fake-claude.mjs';
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, signingInput } from '../src/lib/career/signing.ts';
import { DEVICE_LIMITS, localDay } from '../src/lib/career/limits.ts';

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
let n = 140;
async function device(): Promise<Device> {
  const ip = `203.0.114.${n++}`;
  const { POST } = await import('../src/pages/api/device/register.ts');
  const pair = (await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.parse(canonicalJwk(await crypto.subtle.exportKey('jwk', pair.publicKey))!);
  const res = await POST({ request: new Request('https://x.test/api/device/register', { method: 'POST', body: JSON.stringify({ jwk }) }), clientAddress: ip } as never);
  return { pair, id: (await res.json()).deviceId, ip };
}

async function story(d: Device, payload: Record<string, unknown>) {
  const { POST } = await import('../src/pages/api/career/card-story.ts');
  const path = '/api/career/card-story';
  const body = JSON.stringify({ profile: SAMPLE_PROFILE, day: localDay(), style: 0, ...payload });
  const ts = String(Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64url(await crypto.subtle.sign(ECDSA_SIGN, d.pair.privateKey, await signingInput('POST', path, ts, nonce, body)));
  const res = (await POST({ request: new Request(`https://x.test${path}`, { method: 'POST', headers: { [HEADER.device]: d.id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig, 'x-forwarded-for': d.ip }, body }), clientAddress: d.ip } as never)) as Response;
  return { res, body: (await res.json()) as Record<string, unknown> };
}
const CARD = { name: 'Ade', period: 'week', applied: 4, interviews: 1, companies: ['Moniepoint'], role: 'Product Manager' };

test('card story: written from the card (its companies, its numbers) in the chosen style; their field only, never their history', async () => {
  const { res, body } = await story(await device(), { card: CARD, style: 1 });
  assert.equal(res.status, 200);
  assert.match(String(body.story), /^Dear Moniepoint: 4 applications in/);
  assert.equal(body.style, 'live sports commentary');
  const sent = String((claude.requests.at(-1) as { messages: { content: string }[] }).messages[0].content);
  assert.match(sent, /task = "card_story"[\s\S]*<card>\{"name":"Ade"/);
  assert.match(sent, /<style>live sports commentary<\/style>/);
  assert.doesNotMatch(sent, /Example Fintech|candidate@/, 'no employers or contact details from the résumé');
});

test('card story: a story with a number that is not on the card is refused (retried, then given up)', async () => {
  const d = await device();
  const { res } = await story(d, { card: { ...CARD, role: 'INVENT' } });
  assert.equal(res.status, 502);
  assert.equal((claude.requests as unknown[]).filter((r) => JSON.stringify((r as { messages: unknown }).messages).includes('task = \\"card_story\\"')).length, 2, 'one retry');
  const { storyNumbersOk } = await import('../src/pages/api/career/card-story.ts');
  const { cleanCard } = await import('../src/lib/career/card.ts');
  const card = cleanCard({ applied: 4, score: [2.9, 4.2] })!;
  assert.equal(storyNumbersOk('4 applications and a 4.2 score', card), true);
  assert.equal(storyNumbersOk('4 applications, 3 offers', card), false);
});

test('card story: 12 a day per device', async () => {
  const d = await device();
  for (let i = 0; i < DEVICE_LIMITS.stories; i++) assert.equal((await story(d, { card: CARD })).res.status, 200);
  assert.equal((await story(d, { card: CARD })).res.status, 429);
});
