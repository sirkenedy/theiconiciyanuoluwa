// Job sources, candidate selection and /api/career/jobs (fake Redis + fake Claude). `npm run test:api`
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startFakeUpstash, FAKE_TOKEN } from './fake-upstash.mjs';
import { startFakeClaude, SAMPLE_PROFILE } from './fake-claude.mjs';
import { sampleIndexes, seedJobs } from './fixtures-jobs.mjs';
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, signingInput } from '../src/lib/career/signing.ts';
import { localDay } from '../src/lib/career/limits.ts';
import { ashby, greenhouse, himalayas, jobicy, lever, remotive } from '../src/lib/jobs/sources.ts';
import { candidates, placeFits, tierOf } from '../src/lib/jobs/select.ts';
import { plainText } from '../src/lib/jobs/text.ts';
import type { Job } from '../src/lib/jobs/types.ts';
import type { Profile } from '../src/lib/career/types.ts';

const realFetch = globalThis.fetch;
let servers: Server[] = [];
let redisUrl = '';
let kv: Map<string, unknown>;
let claude: Awaited<ReturnType<typeof startFakeClaude>>;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const company = (ats: 'greenhouse' | 'lever' | 'ashby') => ({ company: 'Sample Co', ats, token: 'sample', regions: [], active: true });

/** Answers source URLs with canned payloads; everything else (fake Redis/Claude) goes to the network. */
function mockSources(routes: Record<string, unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return realFetch(input, init);
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

before(async () => {
  const redis = await startFakeUpstash();
  claude = await startFakeClaude();
  servers = [redis.server, claude.server];
  redisUrl = redis.url;
  kv = redis.kv;
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url });
});
after(() => {
  globalThis.fetch = realFetch;
  servers.forEach((s) => s.close());
});
beforeEach(() => {
  globalThis.fetch = realFetch;
  claude.requests.length = 0;
});

// ---------- sources: honest labels, untouched apply links, the 48 h window ----------

test('Greenhouse: first_published → "posted"; only re-touched → "updated"; older than a month dropped; entity-escaped HTML decoded', async () => {
  mockSources({
    'https://boards-api.greenhouse.io/': {
      jobs: [
        { id: 1, title: 'PM', first_published: iso(20), updated_at: iso(5), location: { name: 'Remote - Africa' }, absolute_url: 'https://co.test/jobs/1', content: '&lt;p&gt;Own the &lt;strong&gt;roadmap&lt;/strong&gt; &amp;amp; launches&lt;/p&gt;' },
        { id: 2, title: 'Designer', first_published: iso(60 * 24 * 31), updated_at: iso(90), location: { name: 'Lagos' }, absolute_url: 'https://co.test/jobs/2' },
        { id: 3, title: 'Old', first_published: iso(60 * 24 * 31), updated_at: iso(60 * 24 * 31), absolute_url: 'https://co.test/jobs/3' },
      ],
    },
  });
  const [a, b, ...rest] = await greenhouse(company('greenhouse'), NOW);
  assert.equal(rest.length, 0);
  assert.deepEqual([a.job.time.kind, b.job.time.kind], ['posted', 'updated']);
  assert.equal(a.job.time.at, NOW - 20 * 60_000);
  assert.equal(a.job.remote, true);
  assert.equal(a.job.applyUrl, 'https://co.test/jobs/1');
  assert.equal(a.job.attribution.label, 'via Greenhouse');
  assert.equal(a.description, 'Own the roadmap & launches');
});

test('Lever createdAt → "posted"; Ashby publishedAt → "published", unlisted jobs skipped', async () => {
  mockSources({
    'https://api.lever.co/': [{ id: 'x', text: 'APM', createdAt: NOW - 10 * 60_000, workplaceType: 'remote', hostedUrl: 'https://jobs.lever.co/sample/x', categories: { location: 'Remote' } }],
    'https://api.ashbyhq.com/': {
      jobs: [
        { id: 'a', title: 'PM', publishedAt: iso(30), isListed: true, isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/sample/a' },
        { id: 'b', title: 'Hidden', publishedAt: iso(30), isListed: false, jobUrl: 'https://jobs.ashbyhq.com/sample/b' },
      ],
    },
  });
  const [l] = await lever(company('lever'), NOW);
  assert.equal(l.job.time.kind, 'posted');
  assert.equal(l.job.applyUrl, 'https://jobs.lever.co/sample/x');
  const out = await ashby(company('ashby'), NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].job.time.kind, 'published');
});

test('Himalayas: applicationLink unchanged (utm kept), "via Himalayas" links to the listing, pubDate → "updated", expired dropped', async () => {
  const link = 'https://himalayas.app/companies/sample/jobs/pm?utm_source=api';
  mockSources({
    'https://himalayas.app/jobs/api': {
      jobs: [
        { title: 'PM', companyName: 'Sample', pubDate: (NOW - 3600_000) / 1000, expiryDate: (NOW + 86_400_000) / 1000, applicationLink: link, guid: 'https://himalayas.app/companies/sample/jobs/pm' },
        { title: 'Expired', companyName: 'Sample', pubDate: (NOW - 3600_000) / 1000, expiryDate: (NOW - 1000) / 1000, applicationLink: 'x', guid: 'https://himalayas.app/x' },
      ],
      nextCursor: null,
    },
  });
  const out = await himalayas(NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].job.applyUrl, link);
  assert.equal(out[0].job.sourceUrl, 'https://himalayas.app/companies/sample/jobs/pm');
  assert.equal(out[0].job.time.kind, 'updated');
  assert.equal(out[0].job.attribution.label, 'via Himalayas');
});

test('Remotive keeps a week (its feed is delayed ≥ 24 h) and links to the Remotive page; Jobicy links to the Jobicy page', async () => {
  mockSources({
    'https://remotive.com/api/remote-jobs': { jobs: [{ id: 9, url: 'https://remotive.com/remote-jobs/product/pm-9', title: 'PM', company_name: 'Sample', publication_date: iso(60 * 72).slice(0, 19) }] },
    'https://jobicy.com/api/v2/remote-jobs': { jobs: [{ id: 4, url: 'https://jobicy.com/jobs/4-pm', jobTitle: 'PM', companyName: 'Sample', pubDate: iso(15) }] },
  });
  const [r] = await remotive(NOW);
  assert.equal(r.job.applyUrl, 'https://remotive.com/remote-jobs/product/pm-9');
  assert.equal(r.job.attribution.label, 'via Remotive');
  const [j] = await jobicy(NOW);
  assert.equal(j.job.applyUrl, 'https://jobicy.com/jobs/4-pm');
  assert.equal(j.job.attribution.label, 'via Jobicy');
});

test('plainText strips scripts and keeps list structure', () => {
  assert.equal(plainText('<ul><li>One</li><li>Two</li></ul><script>alert(1)</script>'), '• One\n• Two');
});

// ---------- selection ----------

const profile = SAMPLE_PROFILE as Profile;
const sample = () => Object.values(sampleIndexes()).flat() as Job[];

test('tiers: only a true posting time ≤ 60 min is tier 1; "updated" never is', () => {
  const now = Date.now();
  const [pm, apm, design] = sampleIndexes().greenhouse as Job[];
  assert.equal(tierOf(pm, now), 1);
  assert.equal(tierOf(apm, now), 1);
  assert.equal(tierOf(design, now), 2);
  assert.equal(tierOf({ ...pm, time: { kind: 'updated', at: now - 60_000 } }, now), 2);
});

test('candidates: relevant to the profile, freshest tier first, never a served job, duplicates merged', () => {
  const jobs = sample();
  const dup = { ...jobs[0], id: 'jobicy:dup' };
  const picks = candidates([...jobs, dup], profile, new Set(['greenhouse:sample:2']));
  const titles = picks.map((p) => p.job.title);
  assert.equal(titles[0], 'Product Manager, Payments');
  assert.ok(!titles.includes('Associate Product Manager'), 'served job excluded');
  assert.ok(!titles.includes('Backend Engineer'), 'irrelevant job excluded');
  assert.equal(titles.filter((t) => t === 'Product Manager, Payments').length, 1, 'duplicate merged');
  assert.deepEqual(picks.map((p) => p.tier), [...picks.map((p) => p.tier)].sort());
});

test('place: remote seekers get remote or local jobs only', () => {
  const [, , onsite] = sampleIndexes().greenhouse as Job[];
  assert.equal(placeFits({ ...onsite, location: 'Berlin' }, profile), false);
  assert.equal(placeFits(onsite, profile), true, 'same city counts');
});

// ---------- /api/career/jobs ----------

type Device = { pair: CryptoKeyPair; id: string };
async function device(ip: string): Promise<Device> {
  const { POST } = await import('../src/pages/api/device/register.ts');
  const pair = (await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.parse(canonicalJwk(await crypto.subtle.exportKey('jwk', pair.publicKey))!);
  const res = await POST({ request: new Request('https://x.test/api/device/register', { method: 'POST', body: JSON.stringify({ jwk }) }), clientAddress: ip } as never);
  return { pair, id: (await res.json()).deviceId };
}
async function jobs(d: Device, payload: Record<string, unknown>, ip: string) {
  const { POST } = await import('../src/pages/api/career/jobs.ts');
  const path = '/api/career/jobs';
  const body = JSON.stringify({ profile: SAMPLE_PROFILE, day: localDay(), ...payload });
  const ts = String(Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64url(await crypto.subtle.sign(ECDSA_SIGN, d.pair.privateKey, await signingInput('POST', path, ts, nonce, body)));
  const res = await POST({ request: new Request(`https://x.test${path}`, { method: 'POST', headers: { [HEADER.device]: d.id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig, 'x-forwarded-for': ip }, body }), clientAddress: ip } as never);
  return (await res.json()) as { jobs: (Job & { fit: number; why: string[]; gaps: string[] })[]; left: number; more?: number; reason?: string };
}

test('jobs: one batched Haiku ranking, fit < 55 dropped, best first, 3 now + "show more" from the cache, 5 a day, never repeated', async () => {
  await seedJobs(redisUrl);
  const d = await device('203.0.113.40');
  const first = await jobs(d, {}, '203.0.113.40');
  assert.equal(claude.requests.length, 1, 'one ranking call');
  const rankReq = claude.requests[0] as { model: string; messages: { content: string }[] };
  assert.equal(rankReq.model, 'claude-haiku-5-5');
  assert.match(rankReq.messages[0].content, /task = "rank_jobs"/);
  assert.equal(first.jobs.length, 3);
  assert.deepEqual(first.jobs.map((j) => j.fit), [92, 81, 76]);
  assert.equal(first.left, 2);
  assert.equal(first.more, 2);

  const more = await jobs(d, { more: true, count: 2 }, '203.0.113.40');
  assert.equal(claude.requests.length, 1, '"show more" reuses the ranked list');
  assert.deepEqual(more.jobs.map((j) => j.fit), [64, 58]);
  assert.equal(more.left, 0);
  const ids = [...first.jobs, ...more.jobs].map((j) => j.id);
  assert.equal(new Set(ids).size, 5, 'no repeats');
  assert.ok([...first.jobs, ...more.jobs].every((j) => j.fit >= 55));

  const sixth = await jobs(d, {}, '203.0.113.40');
  assert.deepEqual([sixth.jobs.length, sixth.reason], [0, 'limit']);
});

test('jobs: a new day still never repeats what this device has seen', async () => {
  await seedJobs(redisUrl);
  const d = await device('203.0.113.41');
  const today = await jobs(d, { count: 5 }, '203.0.113.41');
  const tomorrow = new Date(Date.now() + 86_400_000);
  const next = await jobs(d, { day: localDay(tomorrow) }, '203.0.113.41');
  const seen = new Set(today.jobs.map((j) => j.id));
  assert.ok(next.jobs.every((j) => !seen.has(j.id)));
});

test('jobs: nothing good enough → none, and no quota spent', async () => {
  await seedJobs(redisUrl);
  claude.state.fits = [40, 30, 20, 10, 5, 5, 5];
  try {
    const d = await device('203.0.113.42');
    const out = await jobs(d, {}, '203.0.113.42');
    assert.deepEqual([out.jobs.length, out.reason, out.left], [0, 'none', 5]);
  } finally {
    claude.state.fits = [92, 81, 76, 64, 58, 40, 35];
  }
});

// ---------- live fallback: empty or stale pool ----------

const clearPool = () => {
  for (const k of [...kv.keys()]) if (k.startsWith('jobs:')) kv.delete(k);
};
/** Every source answers with one fresh Product Manager job; counts the requests per host. */
function liveSources() {
  const hits: Record<string, number> = {};
  const at = new Date(Date.now() - 20 * 60_000).toISOString();
  const count = (url: string) => (hits[new URL(url).host] = (hits[new URL(url).host] ?? 0) + 1);
  const routes: Record<string, (url: string) => unknown> = {
    'https://boards-api.greenhouse.io/': (url) => ({ jobs: [{ id: Number(url.length), title: 'Product Manager', first_published: at, updated_at: at, location: { name: 'Remote' }, absolute_url: `https://co.test/gh/${url.length}`, content: '&lt;p&gt;Own the roadmap&lt;/p&gt;' }] }),
    'https://api.lever.co/': () => [],
    'https://api.ashbyhq.com/': () => ({ jobs: [] }),
    'https://himalayas.app/jobs/api': () => ({ jobs: [{ title: 'Product Manager', companyName: 'Feed Co', pubDate: Math.floor((Date.now() - 3600_000) / 1000), expiryDate: Math.floor((Date.now() + 86_400_000) / 1000), applicationLink: 'https://boards.greenhouse.io/feedco/jobs/1', guid: 'https://himalayas.app/companies/feedco/jobs/pm' }], nextCursor: null }),
    'https://remotive.com/api/remote-jobs': () => ({ jobs: [] }),
    'https://jobicy.com/api/v2/remote-jobs': () => ({ jobs: [] }),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return realFetch(input, init);
    count(url);
    return new Response(JSON.stringify(hit[1](url)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return hits;
}

test('jobs: empty pool (ingest never ran) → the three job feeds are fetched (not every board), saved, ranked and served', async () => {
  clearPool();
  const hits = liveSources();
  const d = await device('203.0.113.43');
  const out = await jobs(d, {}, '203.0.113.43');
  assert.ok(hits['himalayas.app'] > 0, 'the job feeds were fetched');
  assert.equal(hits['boards-api.greenhouse.io'] ?? 0, 0, 'company boards are left to the hourly ingest');
  assert.ok(out.jobs.length > 0, 'jobs served from the refreshed feeds');
  assert.ok(typeof kv.get('jobs:idx:himalayas') === 'string', 'the pool is now in Redis for everyone');
  assert.ok(kv.get('jobs:last:himalayas'), 'and marked fresh');
  assert.equal(kv.has('jobs:refresh:lock'), false, 'lock released');
});

test('jobs: someone else is already fetching an empty pool → "warming", no model call, nothing spent', async () => {
  clearPool();
  kv.set('jobs:refresh:lock', '1');
  try {
    const d = await device('203.0.113.45');
    const out = await jobs(d, {}, '203.0.113.45');
    assert.deepEqual([out.jobs.length, out.reason, out.left], [0, 'warming', 5]);
    assert.equal(claude.requests.length, 0);
  } finally {
    kv.delete('jobs:refresh:lock');
  }
});

test('jobs: a stale pool (ingest stopped > 3 h ago) gets its feeds refreshed, and the saved jobs still count', async () => {
  await seedJobs(redisUrl);
  for (const s of ['greenhouse', 'lever', 'ashby', 'himalayas', 'remotive', 'jobicy']) kv.set(`jobs:last:${s}`, String(Date.now() - 4 * 3600_000));
  const hits = liveSources();
  const d = await device('203.0.113.46');
  const out = await jobs(d, {}, '203.0.113.46');
  // Each feed keeps its own cadence: Jobicy (hourly) is due after 4 h; Himalayas (daily) and Remotive (6 h) are not.
  assert.ok(hits['jobicy.com'] > 0, 'due feeds refreshed');
  assert.equal(hits['himalayas.app'] ?? 0, 0, 'feeds not yet due are left alone');
  assert.ok(out.jobs.length > 0, 'the saved jobs still count');
  assert.ok(Number(kv.get('jobs:last:jobicy')) > Date.now() - 60_000);
});
