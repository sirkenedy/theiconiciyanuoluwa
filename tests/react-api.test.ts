// Runs /api/react against an in-memory fake of Upstash's REST pipeline. `npm run test:api`
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GET, POST } from '../src/pages/api/react.ts';

const sets = new Map<string, Set<string>>();
const counters = new Map<string, number>();
let failing = false;
let server: Server;

function run([cmd, key, value]: string[]) {
  const set = sets.get(key) ?? new Set<string>();
  sets.set(key, set);
  switch (cmd) {
    case 'SADD': return set.has(value) ? 0 : (set.add(value), 1);
    case 'SREM': return set.delete(value) ? 1 : 0;
    case 'SCARD': return set.size;
    case 'INCR': return counters.set(key, (counters.get(key) ?? 0) + 1).get(key);
    case 'EXPIRE': return 1;
    default: throw new Error(`unexpected ${cmd}`);
  }
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failing) return res.writeHead(500).end();
      if (req.headers.authorization !== 'Bearer test-token' || req.url !== '/pipeline') return res.writeHead(401).end();
      const out = (JSON.parse(body) as string[][]).map((c) => ({ result: run(c.map(String)) }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
});
after(() => server.close());

const configure = () => {
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
};
const unconfigure = () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
};
const ctx = (request: Request, ip = '203.0.113.7') => ({ request, clientAddress: ip }) as never;
const post = (body: unknown, ip?: string) =>
  POST(ctx(new Request('http://x/api/react', { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': ip ?? '203.0.113.7' } }), ip));
const get = () => GET(ctx(new Request('http://x/api/react')));
const A = '11111111-aaaa-4aaa-8aaa-111111111111';
const B = '22222222-bbbb-4bbb-8bbb-222222222222';

test('without Redis: enabled:false with 200 (client counts locally)', async () => {
  unconfigure();
  assert.deepEqual(await (await get()).json(), { enabled: false });
  const res = await post({ visitor: A, changes: [{ key: 'site:love', on: true }] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: false });
});

test('GET returns a count for every allowed key, cacheable at the edge', async () => {
  configure();
  const res = await get();
  const data = await res.json();
  assert.equal(data.enabled, true);
  assert.equal(data.counts['site:love'], 0);
  assert.ok('post-1:insight' in data.counts);
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=15/);
});

test('one reaction per visitor per type; toggling off removes it', async () => {
  configure();
  assert.deepEqual((await (await post({ visitor: A, changes: [{ key: 'site:love', on: true }] })).json()).counts, { 'site:love': 1 });
  assert.deepEqual((await (await post({ visitor: A, changes: [{ key: 'site:love', on: true }] })).json()).counts, { 'site:love': 1 });
  assert.deepEqual((await (await post({ visitor: B, changes: [{ key: 'site:love', on: true }] })).json()).counts, { 'site:love': 2 });
  const batch = await (await post({ visitor: A, changes: [{ key: 'site:love', on: false }, { key: 'post-2:insight', on: true }, { key: 'site:love', on: true }, { key: 'site:love', on: false }] })).json();
  assert.deepEqual(batch.counts, { 'site:love': 1, 'post-2:insight': 1 });
});

test('rejects unknown keys, bad visitor ids and oversized batches', async () => {
  configure();
  assert.equal((await post({ visitor: A, changes: [{ key: 'site:evil', on: true }] })).status, 400);
  assert.equal((await post({ visitor: 'x', changes: [{ key: 'site:love', on: true }] })).status, 400);
  assert.equal((await post({ visitor: A, changes: Array.from({ length: 17 }, () => ({ key: 'site:love', on: true })) })).status, 400);
  assert.equal((await post({ visitor: A, changes: [{ key: 'site:love', on: 'yes' }] })).status, 400);
  assert.equal(sets.get('rx:site:evil'), undefined);
});

test('rate limit: more than 60 writes a minute from one IP gets 429', async () => {
  configure();
  const ip = '198.51.100.9';
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await post({ visitor: A, changes: [{ key: 'site:fun', on: i % 2 === 0 }] }, ip)).status;
  assert.equal(last, 429);
  assert.equal((await post({ visitor: A, changes: [{ key: 'site:fun', on: true }] }, '198.51.100.10')).status, 200);
});

test('Redis outage: GET degrades to local mode, POST reports upstream', async () => {
  configure();
  failing = true;
  assert.deepEqual(await (await get()).json(), { enabled: false });
  assert.equal((await post({ visitor: A, changes: [{ key: 'site:love', on: true }] })).status, 502);
  failing = false;
});
