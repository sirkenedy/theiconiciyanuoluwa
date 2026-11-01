// Live job search (Adzuna/Jooble), board discovery and the streamed /api/career/job-search route. Every job API is
// mocked; Redis and Claude are the in-memory fakes. `npm run test:api`
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startFakeUpstash, FAKE_TOKEN } from './fake-upstash.mjs';
import { startFakeClaude, SAMPLE_PROFILE } from './fake-claude.mjs';
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, signingInput } from '../src/lib/career/signing.ts';
import { localDay } from '../src/lib/career/limits.ts';
import { adzuna, jooble, queriesFor } from '../src/lib/jobs/search.ts';
import { ADDED, SKIPPED, discover, guessTokens, leadFromUrl } from '../src/lib/jobs/discover.ts';
import type { Profile } from '../src/lib/career/types.ts';
import type { Job } from '../src/lib/jobs/types.ts';

const realFetch = globalThis.fetch;
let servers: Server[] = [];
let redis: Awaited<ReturnType<typeof startFakeUpstash>>;
let claude: Awaited<ReturnType<typeof startFakeClaude>>;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const designer: Profile = { ...SAMPLE_PROFILE, targetRoles: ['Product Designer'], seniority: 'senior', location: 'Toronto, Ontario, Canada', remotePreference: 'hybrid' } as Profile;

type Route = (url: string, init?: RequestInit) => unknown;
/** Answers matching URL prefixes with JSON (or a status); records every call. Everything else goes to the fakes. */
function mock(routes: Record<string, Route | number>) {
  const calls: { url: string; body?: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return realFetch(input, init);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (typeof hit[1] === 'number') return new Response('', { status: hit[1] });
    return new Response(JSON.stringify(hit[1](url, init)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

before(async () => {
  redis = await startFakeUpstash();
  claude = await startFakeClaude();
  servers = [redis.server, claude.server];
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url, ADZUNA_API_URL: 'https://adzuna.test/v1/api', JOOBLE_API_URL: 'https://jooble.test/api' });
});
after(() => {
  globalThis.fetch = realFetch;
  servers.forEach((s) => s.close());
});
beforeEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(process.env, { ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key', JOOBLE_API_KEY: 'jkey' });
  claude.requests.length = 0;
});

// ---------- queries ----------

test('queries: the target role at the visitor\'s level, in their city (remote seekers: their country); never their name', () => {
  const [q] = queriesFor(designer);
  assert.deepEqual([q.what, q.where, q.country, q.label], ['senior Product Designer', 'Toronto', 'ca', 'Product Designer in Toronto']);
  const [r] = queriesFor({ ...designer, remotePreference: 'remote' });
  assert.deepEqual([r.where, r.remote], ['Canada', true]);
  const [any] = queriesFor(designer, { anywhere: true });
  assert.deepEqual([any.where, any.country], ['', 'ca']);
  assert.ok(!JSON.stringify(queriesFor(designer)).includes('Sample Candidate'));
});

// ---------- sources ----------

test('Adzuna: role + city in the URL, only the last month, real pay only (never predicted), "via Adzuna" to its listing', async () => {
  const calls = mock({
    'https://adzuna.test/': () => ({
      results: [
        { id: '1', title: '<strong>Product Designer</strong>', company: { display_name: 'Maple Co' }, location: { display_name: 'Toronto, Ontario' }, created: ago(3), redirect_url: 'https://www.adzuna.ca/land/ad/1', description: 'Design our app', salary_min: 90000, salary_max: 110000, salary_is_predicted: '0' },
        { id: '2', title: 'Old role', created: ago(40), redirect_url: 'https://www.adzuna.ca/land/ad/2' },
        { id: '3', title: 'Designer', company: { display_name: 'Guess Co' }, created: ago(1), redirect_url: 'https://www.adzuna.ca/land/ad/3', salary_min: 1, salary_max: 2, salary_is_predicted: '1' },
      ],
    }),
  });
  const rows = await adzuna(queriesFor(designer)[0]);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1/api/jobs/ca/search/1');
  assert.deepEqual([url.searchParams.get('what'), url.searchParams.get('where'), url.searchParams.get('max_days_old')], ['senior Product Designer', 'Toronto', '30']);
  assert.deepEqual(rows.map((r) => r.job.id), ['adzuna:1', 'adzuna:3']);
  assert.equal(rows[0].job.title, 'Product Designer');
  assert.equal(rows[0].job.salary, 'CAD 90,000–110,000');
  assert.equal(rows[1].job.salary, undefined, 'predicted pay is not shown as real');
  assert.deepEqual([rows[0].job.applyUrl, rows[0].job.attribution.label, rows[0].job.time.kind], ['https://www.adzuna.ca/land/ad/1', 'via Adzuna', 'posted']);
});

test('Jooble: role + place in the body, "updated" time (never "posted"), the month window; nothing without a key', async () => {
  const calls = mock({ 'https://jooble.test/': () => ({ jobs: [{ id: 7, title: 'Product Designer', company: 'Lake Inc', location: 'Toronto, ON', link: 'https://jooble.org/desc/7', updated: ago(2), snippet: 'Hybrid role' }, { id: 8, title: 'Old', link: 'x', updated: ago(45) }] }) });
  const rows = await jooble(queriesFor(designer)[0]);
  assert.deepEqual(JSON.parse(calls[0].body!), { keywords: 'senior Product Designer', location: 'Toronto', page: '1' });
  assert.ok(calls[0].url.endsWith('/api/jkey'));
  assert.deepEqual(rows.map((r) => [r.job.id, r.job.time.kind, r.job.attribution.label]), [['jooble:7', 'updated', 'via Jooble']]);
  delete process.env.JOOBLE_API_KEY;
  assert.deepEqual(await jooble(queriesFor(designer)[0]), []);
});

// ---------- discovery ----------

test('leads: supported hiring systems give a board token; Workday/LinkedIn are policy skips; SmartRecruiters is "later"', () => {
  assert.deepEqual(leadFromUrl('https://boards.greenhouse.io/newco/jobs/123', 'NewCo'), { ats: 'greenhouse', token: 'newco', company: 'NewCo', via: 'boards.greenhouse.io' });
  assert.deepEqual(leadFromUrl('https://jobs.lever.co/acme/abc', 'Acme'), { ats: 'lever', token: 'acme', company: 'Acme', via: 'jobs.lever.co' });
  assert.equal((leadFromUrl('https://jobs.ashbyhq.com/zed/1', 'Zed') as { token: string }).token, 'zed');
  assert.deepEqual(leadFromUrl('https://acme.wd5.myworkdayjobs.com/en-US/jobs/1', 'Acme'), { skip: 'acme.wd5.myworkdayjobs.com', reason: 'Workday: no public job API', policy: true });
  assert.equal((leadFromUrl('https://www.linkedin.com/jobs/view/1', 'x') as { policy: boolean }).policy, true);
  assert.equal((leadFromUrl('https://jobs.smartrecruiters.com/Acme/1', 'x') as { policy: boolean }).policy, false);
  assert.equal(leadFromUrl('https://acme.com/careers/1', 'Acme'), null);
  assert.deepEqual(guessTokens('Acme Health Inc.'), ['acmehealth', 'acme-health']);
  assert.deepEqual(guessTokens('Company not listed'), []);
});

const poolJob = (applyUrl: string, company: string): Job => ({ id: `himalayas:${company}`, title: 'Designer', company, location: 'Remote', remote: true, time: { kind: 'updated', at: Date.now() }, applyUrl, sourceUrl: 'https://himalayas.app/x', attribution: { source: 'Himalayas', label: 'via Himalayas' }, snippet: '' });

test('discovery: verified boards are added, policy and dead ends are skipped with a reason, and nothing is checked twice', async () => {
  const r = { url: redis.url, token: FAKE_TOKEN };
  const calls = mock({
    'https://boards-api.greenhouse.io/robots.txt': 404,
    'https://api.lever.co/robots.txt': 404,
    'https://api.ashbyhq.com/robots.txt': 404,
    'https://boards-api.greenhouse.io/v1/boards/newco/': () => ({ jobs: [] }),
    'https://boards-api.greenhouse.io/': 404,
    'https://api.lever.co/': 404,
    'https://api.ashbyhq.com/': 404,
  });
  const pool = [poolJob('https://boards.greenhouse.io/newco/jobs/1', 'NewCo'), poolJob('https://acme.wd1.myworkdayjobs.com/x', 'Acme')];
  const first = await discover(r, pool, ['Acme Health Inc.'], []);
  assert.deepEqual(first.added.map((c) => `${c.ats}:${c.token}`), ['greenhouse:newco']);
  const added = JSON.parse((await (await fetchRedis([['HGET', ADDED, 'greenhouse:newco']]))[0]) as string);
  assert.deepEqual([added.company, typeof added.foundAt], ['NewCo', 'number']);
  const [workday, guessed] = await fetchRedis([['HGET', SKIPPED, 'acme.wd1.myworkdayjobs.com'], ['HGET', SKIPPED, 'company:acmehealth']]);
  assert.deepEqual(JSON.parse(workday as string).policy, true);
  assert.equal(JSON.parse(guessed as string).reason, 'no public job board found');
  assert.ok(calls.some((c) => c.url.includes('/v1/boards/acmehealth/')), 'the company name was tried as a board token');

  const before = calls.length;
  const again = await discover(r, pool, ['Acme Health Inc.'], []);
  assert.deepEqual([again.checked, again.added.length], [0, 0]);
  assert.equal(calls.length, before, 'no repeat requests');
});

test("discovery: a board API whose robots.txt disallows it is a policy skip, never fetched", async () => {
  const calls = mock({ 'https://api.lever.co/robots.txt': () => 'x', 'https://api.lever.co/': () => [] });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.lever.co/robots.txt') return new Response('User-agent: *\nDisallow: /v0/\n');
    if (url.startsWith('https://api.lever.co/')) {
      calls.push({ url });
      return new Response('[]');
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const out = await discover({ url: redis.url, token: FAKE_TOKEN }, [poolJob('https://jobs.lever.co/blocked/1', 'Blocked')], [], []);
  assert.equal(out.added.length, 0);
  assert.deepEqual(out.skipped, [{ key: 'lever:blocked', reason: "the board API's robots.txt disallows it", policy: true }]);
  assert.equal(calls.length, 0);
});

async function fetchRedis(cmds: (string | number)[][]) {
  const res = await realFetch(`${redis.url}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${FAKE_TOKEN}` }, body: JSON.stringify(cmds) });
  return ((await res.json()) as { result: unknown }[]).map((r) => r.result);
}

// ---------- the streamed route ----------

type Device = { pair: CryptoKeyPair; id: string };
async function device(ip: string): Promise<Device> {
  const { POST } = await import('../src/pages/api/device/register.ts');
  const pair = (await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.parse(canonicalJwk(await crypto.subtle.exportKey('jwk', pair.publicKey))!);
  const res = await POST({ request: new Request('https://x.test/api/device/register', { method: 'POST', body: JSON.stringify({ jwk }) }), clientAddress: ip } as never);
  return { pair, id: (await res.json()).deviceId };
}
async function search(d: Device, ip: string, payload: Record<string, unknown> = {}) {
  const { POST } = await import('../src/pages/api/career/job-search.ts');
  const path = '/api/career/job-search';
  const body = JSON.stringify({ profile: designer, day: localDay(), ...payload });
  const ts = String(Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64url(await crypto.subtle.sign(ECDSA_SIGN, d.pair.privateKey, await signingInput('POST', path, ts, nonce, body)));
  const res = (await POST({ request: new Request(`https://x.test${path}`, { method: 'POST', headers: { [HEADER.device]: d.id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig, 'x-forwarded-for': ip }, body }), clientAddress: ip } as never)) as Response;
  const text = await res.text();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map(([, event, data]) => ({ event, data: JSON.parse(data) }));
  return { res, events, result: events.find((e) => e.event === 'result')?.data as { jobs: { id: string }[]; searched: string[]; searchable: boolean; reason?: string } | undefined };
}

const designerJobs = () => ({
  results: [
    { id: 'd1', title: 'Senior Product Designer', company: { display_name: 'Maple Co' }, location: { display_name: 'Toronto' }, created: ago(2), redirect_url: 'https://www.adzuna.ca/land/ad/d1', description: 'Design systems, Figma, user research' },
    { id: 'd2', title: 'Product Designer', company: { display_name: 'Lake Inc' }, location: { display_name: 'Toronto' }, created: ago(5), redirect_url: 'https://www.adzuna.ca/land/ad/d2', description: 'Own discovery and prototyping in Figma' },
  ],
});

test('job-search: streams progress, searches with the profile, saves for everyone, ranks and serves; a repeat reuses it', async () => {
  for (const k of [...redis.kv.keys()]) if (k.startsWith('jobs:') || k.startsWith('search:')) redis.kv.delete(k);
  const calls = mock({ 'https://adzuna.test/': designerJobs, 'https://jooble.test/': () => ({ jobs: [] }) });
  const d = await device('203.0.113.80');
  const { res, events, result } = await search(d, '203.0.113.80');
  assert.match(res.headers.get('content-type') ?? '', /event-stream/);
  const progress = events.filter((e) => e.event === 'progress').map((e) => e.data.text as string);
  assert.ok(progress.some((t) => t.startsWith('Searching Adzuna for Product Designer in Toronto')));
  assert.ok(progress.some((t) => t === 'Adzuna: 2 recent roles for Product Designer in Toronto.'));
  assert.equal(events.at(-1)?.event, 'done');
  assert.ok(result && result.jobs.length > 0, 'cards served');
  assert.deepEqual(result!.searched, ['Product Designer in Toronto']);
  assert.ok(String(redis.kv.get('jobs:idx:search')).includes('adzuna:d1'), 'saved for everyone');
  assert.ok(redis.kv.get('jobs:desc:adzuna:d1'), 'descriptions saved for tailoring');
  assert.equal(claude.requests.length, 1, 'one ranking call');
  assert.ok(!calls.some((c) => (c.body ?? c.url).includes('Sample Candidate')), 'the name never leaves');

  const before = calls.length;
  const again = await search(await device('203.0.113.81'), '203.0.113.81');
  assert.equal(calls.length, before, 'the same search within 6 h is not repeated');
  assert.ok(again.events.some((e) => e.event === 'progress' && /Already searched/.test(e.data.text)));
  assert.ok(again.result!.jobs.length > 0, 'and its saved results are served');
});

test('job-search: 3 live searches a day per device; with no search keys it says so and gives the search back', async () => {
  const d = await device('203.0.113.82');
  mock({ 'https://adzuna.test/': () => ({ results: [] }), 'https://jooble.test/': () => ({ jobs: [] }) });
  for (let i = 0; i < 3; i++) {
    await fetchRedis([['DEL', 'search:done']]);
    await search(d, '203.0.113.82', { anywhere: i % 2 === 1 });
  }
  const fourth = await search(d, '203.0.113.82');
  assert.equal(fourth.res.status, 429);

  delete process.env.ADZUNA_APP_ID;
  delete process.env.JOOBLE_API_KEY;
  const d2 = await device('203.0.113.83');
  const off = await search(d2, '203.0.113.83');
  assert.equal(off.result?.searchable, false);
  for (let i = 0; i < 3; i++) assert.notEqual((await search(d2, '203.0.113.83')).res.status, 429, 'nothing searched, nothing spent');
});

test('jobs: an unreachable Redis is a clean 503, never a crash', async () => {
  const d = await device('203.0.113.84');
  const path = '/api/career/jobs';
  const body = JSON.stringify({ profile: designer, day: localDay() });
  const ts = String(Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64url(await crypto.subtle.sign(ECDSA_SIGN, d.pair.privateKey, await signingInput('POST', path, ts, nonce, body)));
  const url = process.env.UPSTASH_REDIS_REST_URL;
  process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:9';
  try {
    const { POST } = await import('../src/pages/api/career/jobs.ts');
    const request = new Request(`https://x.test${path}`, { method: 'POST', headers: { [HEADER.device]: d.id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig }, body });
    const res = (await POST({ request, clientAddress: '203.0.113.84' } as never)) as Response;
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'unavailable');
  } finally {
    process.env.UPSTASH_REDIS_REST_URL = url;
  }
});


test('JOB_SEARCH_SOURCES switches sources on or off, even with keys set', async () => {
  const { searchConfigured } = await import('../src/lib/jobs/search.ts');
  try {
    process.env.JOB_SEARCH_SOURCES = 'jooble';
    assert.deepEqual([searchConfigured('adzuna'), searchConfigured('jooble')], [false, true]);
    process.env.JOB_SEARCH_SOURCES = ' Adzuna , jooble ';
    assert.deepEqual([searchConfigured('adzuna'), searchConfigured('jooble')], [true, true]);
    process.env.JOB_SEARCH_SOURCES = '';
    assert.deepEqual([searchConfigured('adzuna'), searchConfigured('jooble')], [false, false]);
    const calls = mock({ 'https://adzuna.test/': designerJobs, 'https://jooble.test/': () => ({ jobs: [] }) });
    assert.deepEqual(await adzuna(queriesFor(designer)[0]), []);
    assert.equal(calls.length, 0, 'a disabled source is never called');
  } finally {
    delete process.env.JOB_SEARCH_SOURCES;
  }
  assert.deepEqual([searchConfigured('adzuna'), searchConfigured('jooble')], [true, true], 'unset = every source with keys');
});
