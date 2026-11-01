// Server side of device-bound requests (career-mode.md §4.3). Every /api/career/* call must carry a signature made
// with the device's non-extractable private key; a copied deviceId, header set or whole request is useless without it.
import { pipeline, type Redis } from '../redis.ts';
import { ECDSA, ECDSA_SIGN, HEADER, MAX_SKEW_MS, NONCE_TTL_S, fromB64url, signingInput } from './signing.ts';

export const DEVICE_TTL_S = 90 * 24 * 3600;
export const MAX_BODY = 64 * 1024;
export const deviceKey = (id: string) => `career:dev:${id}`;
const nonceKey = (id: string, nonce: string) => `career:nonce:${id}:${nonce}`;

export type Rejection = 'missing' | 'malformed' | 'stale' | 'unknown-device' | 'bad-signature' | 'replay' | 'too-large';
export type Verified = { ok: true; deviceId: string; body: string };
export type Failed = { ok: false; status: number; code: Rejection; now: number };

const B64URL = (len: number) => new RegExp(`^[A-Za-z0-9_-]{${len}}$`);
const fail = (status: number, code: Rejection, now: number): Failed => ({ ok: false, status, code, now });

export async function verifySigned(request: Request, redis: Redis, now = Date.now()): Promise<Verified | Failed> {
  const h = (name: string) => request.headers.get(name) ?? '';
  const deviceId = h(HEADER.device);
  const timestamp = h(HEADER.timestamp);
  const nonce = h(HEADER.nonce);
  const signature = h(HEADER.signature);
  if (!deviceId || !timestamp || !nonce || !signature) return fail(401, 'missing', now);
  // deviceId = 32-byte hash, nonce = 16 random bytes, signature = 64-byte raw ECDSA (r || s), all base64url.
  if (!B64URL(43).test(deviceId) || !B64URL(22).test(nonce) || !B64URL(86).test(signature) || !/^\d{13}$/.test(timestamp)) {
    return fail(401, 'malformed', now);
  }
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return fail(401, 'stale', now);

  const body = await request.text();
  if (body.length > MAX_BODY) return fail(413, 'too-large', now);

  const [jwk] = (await pipeline(redis, [['GET', deviceKey(deviceId)]])) as [string | null];
  if (!jwk) return fail(401, 'unknown-device', now);

  const url = new URL(request.url);
  const key = await crypto.subtle.importKey('jwk', JSON.parse(jwk), ECDSA, false, ['verify']);
  const input = await signingInput(request.method, url.pathname + url.search, timestamp, nonce, body);
  if (!(await crypto.subtle.verify(ECDSA_SIGN, key, fromB64url(signature), input))) return fail(401, 'bad-signature', now);

  // Only a correctly signed request may spend a nonce, so forged traffic can't burn a device's nonces.
  const [fresh] = await pipeline(redis, [['SET', nonceKey(deviceId, nonce), '1', 'NX', 'EX', NONCE_TTL_S]]);
  if (fresh !== 'OK') return fail(401, 'replay', now);

  return { ok: true, deviceId, body };
}

export const rejected = (f: Failed) =>
  new Response(JSON.stringify({ error: f.code, now: f.now }), {
    status: f.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
