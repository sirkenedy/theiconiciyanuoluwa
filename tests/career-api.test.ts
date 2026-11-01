// Device registration + signed requests (career-mode.md §4.3) against an in-memory Upstash. `npm run test:api`
// Each attack below must be rejected: replay, tampered body, tampered path, another device's key, stale clock, forged id.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startFakeUpstash, FAKE_TOKEN } from './fake-upstash.mjs';
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, deviceIdFor, signingInput } from '../src/lib/career/signing.ts';
import { verifySigned } from '../src/lib/career/verify.ts';
import { POST as register } from '../src/pages/api/device/register.ts';
import { GET as usage } from '../src/pages/api/career/usage.ts';
import { localDay } from '../src/lib/career/limits.ts';

let server: Server;
const redis = () => ({ url: process.env.UPSTASH_REDIS_REST_URL!, token: FAKE_TOKEN });
const ORIGIN = 'https://example.test';

before(async () => {
  const fake = await startFakeUpstash();
  server = fake.server;
  process.env.UPSTASH_REDIS_REST_URL = fake.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_TOKEN;
});
after(() => server.close());

type Device = { pair: CryptoKeyPair; id: string };

let deviceSeq = 0;
async function newDevice(): Promise<Device> {
  const pair = (await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.parse(canonicalJwk(await crypto.subtle.exportKey('jwk', pair.publicKey))!);
  const res = await register({
    request: new Request(`${ORIGIN}/api/device/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jwk }) }),
    clientAddress: `203.0.113.${++deviceSeq}`,
  } as never);
  assert.equal(res.status, 200);
  const { deviceId } = await res.json();
  return { pair, id: deviceId };
}

/** Headers exactly as src/lib/device.ts builds them. */
async function signed(d: Device, method: string, path: string, body = '', opts: { ts?: number; nonce?: string; key?: CryptoKey; id?: string } = {}) {
  const timestamp = String(opts.ts ?? Date.now());
  const nonce = opts.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = await crypto.subtle.sign(ECDSA_SIGN, opts.key ?? d.pair.privateKey, await signingInput(method, path, timestamp, nonce, body));
  return { [HEADER.device]: opts.id ?? d.id, [HEADER.timestamp]: timestamp, [HEADER.nonce]: nonce, [HEADER.signature]: b64url(sig) };
}

const req = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Request(`${ORIGIN}${path}`, { method, headers, body: method === 'GET' ? undefined : body });

test('register: deviceId is base64url(SHA-256(canonical public key))', async () => {
  const d = await newDevice();
  const jwk = canonicalJwk(await crypto.subtle.exportKey('jwk', d.pair.publicKey))!;
  assert.equal(d.id, await deviceIdFor(jwk));
});

test('register: rejects malformed keys and points that are not on P-256', async () => {
  const call = (jwk: unknown) =>
    register({ request: new Request(`${ORIGIN}/api/device/register`, { method: 'POST', body: JSON.stringify({ jwk }) }), clientAddress: '203.0.113.8' } as never);
  assert.equal((await call({ kty: 'EC', crv: 'P-256', x: 'short', y: 'short' })).status, 400);
  assert.equal((await call({ kty: 'RSA', n: 'x', e: 'AQAB' })).status, 400);
  const notOnCurve = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) };
  assert.equal((await call(notOnCurve)).status, 400);
});

test('a correctly signed request is accepted', async () => {
  const d = await newDevice();
  const path = `/api/career/usage?day=${localDay()}`;
  const res = await usage({ request: req('GET', path, await signed(d, 'GET', path)), url: new URL(ORIGIN + path) } as never);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.used, { messages: 0, jobs: 0, tailored: 0, letters: 0, guides: 0 });
});

test('replay: the exact same signed request twice → second is rejected', async () => {
  const d = await newDevice();
  const path = `/api/career/usage?day=${localDay()}`;
  const headers = await signed(d, 'GET', path);
  const first = await usage({ request: req('GET', path, headers), url: new URL(ORIGIN + path) } as never);
  const replay = await usage({ request: req('GET', path, headers), url: new URL(ORIGIN + path) } as never);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, 'replay');
});

test('tampered body: one changed byte → rejected', async () => {
  const d = await newDevice();
  const body = JSON.stringify({ message: 'Tailor my résumé for the PM role' });
  const headers = await signed(d, 'POST', '/api/career/chat', body);
  const tampered = body.replace('PM', 'QM');
  const r = await verifySigned(req('POST', '/api/career/chat', headers, tampered), redis());
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'bad-signature');
  // …and the untouched body with the same headers still verifies (nonce wasn't spent by the forgery).
  assert.equal((await verifySigned(req('POST', '/api/career/chat', headers, body), redis())).ok, true);
});

test('tampered path or query: signature covers it → rejected', async () => {
  const d = await newDevice();
  const headers = await signed(d, 'GET', `/api/career/usage?day=${localDay()}`);
  const r = await verifySigned(req('GET', '/api/career/usage?day=2000-01-01', headers), redis());
  assert.equal(!r.ok && r.code, 'bad-signature');
});

test("another device's key: headers name device A but B signed → rejected", async () => {
  const a = await newDevice();
  const b = await newDevice();
  const path = `/api/career/usage?day=${localDay()}`;
  const r = await verifySigned(req('GET', path, await signed(a, 'GET', path, '', { key: b.pair.privateKey })), redis());
  assert.equal(!r.ok && r.code, 'bad-signature');
});

test('stale or future timestamp (> 60 s off) → rejected', async () => {
  const d = await newDevice();
  const path = `/api/career/usage?day=${localDay()}`;
  for (const ts of [Date.now() - 61_000, Date.now() + 61_000]) {
    const r = await verifySigned(req('GET', path, await signed(d, 'GET', path, '', { ts })), redis());
    assert.equal(!r.ok && r.code, 'stale');
  }
});

test('unknown or forged deviceId → rejected; missing or malformed headers → rejected', async () => {
  const d = await newDevice();
  const path = `/api/career/usage?day=${localDay()}`;
  const forged = await signed(d, 'GET', path, '', { id: b64url(crypto.getRandomValues(new Uint8Array(32))) });
  assert.equal(((await verifySigned(req('GET', path, forged), redis())) as { code: string }).code, 'unknown-device');
  assert.equal(((await verifySigned(req('GET', path, {}), redis())) as { code: string }).code, 'missing');
  const bad = { ...(await signed(d, 'GET', path)), [HEADER.signature]: 'not-a-signature' };
  assert.equal(((await verifySigned(req('GET', path, bad), redis())) as { code: string }).code, 'malformed');
});

test('usage: a forged far-away day is refused', async () => {
  const d = await newDevice();
  const path = '/api/career/usage?day=1999-01-01';
  const res = await usage({ request: req('GET', path, await signed(d, 'GET', path)), url: new URL(ORIGIN + path) } as never);
  assert.equal(res.status, 400);
});
