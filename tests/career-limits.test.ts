// C5 server rules: the $/day kill switch, Turnstile on registration, device + IP daily limits. `npm run test:api`
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startFakeUpstash, FAKE_TOKEN } from './fake-upstash.mjs';
import { startFakeClaude, SAMPLE_PROFILE } from './fake-claude.mjs';
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, signingInput } from '../src/lib/career/signing.ts';
import { localDay } from '../src/lib/career/limits.ts';
import { costMicros } from '../src/lib/career/spend.ts';

const realFetch = globalThis.fetch;
let servers: Server[] = [];
let redis: Awaited<ReturnType<typeof startFakeUpstash>>;
let claude: Awaited<ReturnType<typeof startFakeClaude>>;
const spendKey = () => `career:spend:${new Date().toISOString().slice(0, 10)}`;
const RESUME = `Sample Candidate\nProduct Designer, Example Fintech, 2020 – Present\n${'Redesigned the checkout flow used daily by thousands. '.repeat(5)}`;

before(async () => {
  redis = await startFakeUpstash();
  claude = await startFakeClaude();
  servers = [redis.server, claude.server];
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url });
});
after(() => {
  globalThis.fetch = realFetch;
  servers.forEach((s) => s.close());
});
beforeEach(() => {
  redis.kv.delete(spendKey());
  delete process.env.CAREER_DAILY_BUDGET_USD;
  delete process.env.TURNSTILE_SECRET_KEY;
  globalThis.fetch = realFetch;
  claude.requests.length = 0;
});

async function register(ip: string, turnstile?: string) {
  const { POST } = await import('../src/pages/api/device/register.ts');
  const pair = (await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.parse(canonicalJwk(await crypto.subtle.exportKey('jwk', pair.publicKey))!);
  const res = (await POST({ request: new Request('https://x.test/api/device/register', { method: 'POST', body: JSON.stringify({ jwk, turnstile }), headers: { 'x-forwarded-for': ip } }), clientAddress: ip } as never)) as Response;
  return { res, pair, id: res.ok ? ((await res.clone().json()) as { deviceId: string }).deviceId : '' };
}
async function signedCall(route: string, d: { pair: CryptoKeyPair; id: string }, ip: string, method: 'GET' | 'POST', payload?: unknown) {
  const mod = await import(`../src/pages/api/career/${route}.ts`);
  const path = method === 'GET' ? `/api/career/${route}?day=${localDay()}` : `/api/career/${route}`;
  const body = payload ? JSON.stringify(payload) : '';
  const ts = String(Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64url(await crypto.subtle.sign(ECDSA_SIGN, d.pair.privateKey, await signingInput(method, path, ts, nonce, body)));
  const headers = { [HEADER.device]: d.id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig, 'x-forwarded-for': ip };
  const request = new Request(`https://x.test${path}`, { method, headers, body: method === 'GET' ? undefined : body });
  return (await mod[method]({ request, clientAddress: ip, url: new URL(request.url) } as never)) as Response;
}

// ---------- kill switch ----------

test('cost: tokens × Haiku rates, in micro-dollars', () => {
  assert.equal(costMicros({ input_tokens: 1_000_000 }), 100_000); // $0.10
  assert.equal(costMicros({ output_tokens: 1_000_000 }), 500_000); // $0.50
  assert.equal(costMicros({ input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 1000 }), 5 + 10 + 30 + 125);
});

test('kill switch: real usage is recorded; at $1 today every Career Coach model call stops with "breather"', async () => {
  const d = await register('198.18.0.1');
  const chat = () => signedCall('chat', d, '198.18.0.1', 'POST', { messages: [{ role: 'user', content: 'Hi' }], profile: null, day: localDay() });
  await (await chat()).text();
  await new Promise((r) => setTimeout(r, 50)); // spend is recorded without blocking the answer
  assert.equal(Number(redis.kv.get(spendKey())), costMicros({ input_tokens: 50, output_tokens: 20 }));

  redis.kv.set(spendKey(), String(1_000_000));
  const before = claude.requests.length;
  const stopped = await chat();
  assert.equal(stopped.status, 503);
  assert.equal((await stopped.json()).error, 'breather');
  for (const [route, payload] of [
    ['profile', { text: RESUME, day: localDay() }],
    ['tailor', { mode: 'improve', phase: 'analyze', profile: SAMPLE_PROFILE, resume: RESUME, day: localDay() }],
    ['cover-letter', { profile: SAMPLE_PROFILE, resume: RESUME, job: { description: 'x'.repeat(300) }, day: localDay() }],
  ] as const) {
    const res = await signedCall(route, d, '198.18.0.1', 'POST', payload);
    assert.equal(res.status, 503, route);
  }
  assert.equal(claude.requests.length, before, 'no model call once the budget is spent');
  const usage = (await (await signedCall('usage', d, '198.18.0.1', 'GET')).json()) as { breather: boolean; used: { messages: number } };
  assert.equal(usage.breather, true);
  assert.equal(usage.used.messages, 1, 'a refused call costs the visitor nothing');
});

test('kill switch: CAREER_DAILY_BUDGET_USD raises or lowers the cap', async () => {
  const d = await register('198.18.0.2');
  redis.kv.set(spendKey(), String(1_200_000));
  process.env.CAREER_DAILY_BUDGET_USD = '2';
  const usage = (await (await signedCall('usage', d, '198.18.0.2', 'GET')).json()) as { breather: boolean };
  assert.equal(usage.breather, false);
  process.env.CAREER_DAILY_BUDGET_USD = '0.5';
  assert.equal(((await (await signedCall('usage', d, '198.18.0.2', 'GET')).json()) as { breather: boolean }).breather, true);
});

// ---------- Turnstile ----------

function mockSiteverify(success: boolean) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) {
      seen.push(String(init?.body));
      return new Response(JSON.stringify({ success }), { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return seen;
}

test('Turnstile: with a secret set, registration needs a token that Cloudflare confirms', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  const seen = mockSiteverify(true);
  assert.equal((await register('198.18.0.3')).res.status, 403, 'no token');
  const ok = await register('198.18.0.3', 'token-from-widget');
  assert.equal(ok.res.status, 200);
  assert.match(seen.at(-1)!, /secret=test-secret&response=token-from-widget&remoteip=198\.18\.0\.3/);
  mockSiteverify(false);
  assert.equal((await register('198.18.0.3', 'forged-token')).res.status, 403, 'Cloudflare says no');
});

test('Turnstile: without a secret (local dev), registration works as before', async () => {
  assert.equal((await register('198.18.0.4')).res.status, 200);
});

// ---------- device + IP limits ----------

test('"Delete everything" can\'t reset the day: a new device still shares the network limit, and only 3 new devices per network per day', async () => {
  const ip = '198.18.0.5';
  const statuses: number[] = [];
  for (let device = 0; device < 3; device++) {
    const d = await register(ip);
    assert.equal(d.res.status, 200);
    for (let i = 0; i < 3; i++) {
      const res = await signedCall('profile', d, ip, 'POST', { text: RESUME, day: localDay() });
      statuses.push(res.status);
      if (res.status === 429) assert.equal((await res.json()).scope, 'ip');
    }
  }
  assert.deepEqual(statuses.slice(0, 6), Array(6).fill(200), 'two devices × 3 uploads = this network\'s 6');
  assert.deepEqual(statuses.slice(6), [429, 429, 429], 'wiping and starting again gives nothing more today');
  const fourth = await register(ip);
  assert.equal(fourth.res.status, 429, 'a 4th new device from the same network today is refused');
  const fresh = await register('198.18.0.6');
  assert.equal((await signedCall('profile', fresh, '198.18.0.6', 'POST', { text: RESUME, day: localDay() })).status, 200, 'other networks unaffected');
});

test('device limits: 10 messages, then a limit error, independent of other devices', async () => {
  const ip = '198.18.0.7';
  const d = await register(ip);
  for (let i = 0; i < 10; i++) await (await signedCall('chat', d, ip, 'POST', { messages: [{ role: 'user', content: `Q${i}` }], profile: null, day: localDay() })).text();
  const over = await signedCall('chat', d, ip, 'POST', { messages: [{ role: 'user', content: 'Q11' }], profile: null, day: localDay() });
  assert.equal(over.status, 429);
  assert.equal((await over.json()).scope, 'device');
  const other = await register(ip);
  const usage = (await (await signedCall('usage', other, ip, 'GET')).json()) as { used: { messages: number } };
  assert.equal(usage.used.messages, 0, 'a new device starts the day fresh');
});

test('usage shows what a request will really get: a fresh device on a used-up network sees 0 left', async () => {
  const ip = '198.18.0.8';
  const first = await register(ip);
  const second = await register(ip);
  for (const d of [first, second]) for (let i = 0; i < 3; i++) assert.equal((await signedCall('profile', d, ip, 'POST', { text: RESUME, day: localDay() })).status, 200);
  for (let i = 0; i < 10; i++) await (await signedCall('chat', first, ip, 'POST', { messages: [{ role: 'user', content: `Q${i}` }], profile: null, day: localDay() })).text();
  for (let i = 0; i < 10; i++) await (await signedCall('chat', second, ip, 'POST', { messages: [{ role: 'user', content: `Q${i}` }], profile: null, day: localDay() })).text();
  const third = await register(ip);
  const usage = (await (await signedCall('usage', third, ip, 'GET')).json()) as { used: { messages: number; jobs: number } };
  assert.equal(usage.used.messages, 10, 'this network used its 20 messages: the new device has none left');
  assert.equal(usage.used.jobs, 0);
  assert.equal((await signedCall('chat', third, ip, 'POST', { messages: [{ role: 'user', content: 'Q' }], profile: null, day: localDay() })).status, 429);
});
