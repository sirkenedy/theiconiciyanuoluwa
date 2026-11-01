import type { APIRoute } from 'astro';
import { canonicalJwk, deviceIdFor, ECDSA } from '../../../lib/career/signing.ts';
import { DEVICE_TTL_S, deviceKey } from '../../../lib/career/verify.ts';
import { clientIp, digest, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

// "Delete everything" makes a new device, which would start with fresh device limits; capping new devices per network
// (plus the per-network usage limits) means wiping can't be used to reset the day's allowance.
export const REGISTRATIONS_PER_IP_PER_DAY = 2;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare Turnstile (free, invisible): stops bot farms from minting devices. Required whenever the secret is set. */
async function human(token: unknown, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: new URLSearchParams({ secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(8000) });
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Public key (JWK) + Turnstile token → deviceId = base64url(SHA-256(canonical key)). No cookies or tokens are issued. */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const redis = redisConfig();
  if (!redis) return json({ error: 'unavailable' }, 503);

  let jwk: Parameters<typeof canonicalJwk>[0];
  let turnstile: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: 'invalid' }, 400);
    ({ jwk, turnstile } = JSON.parse(raw));
  } catch {
    return json({ error: 'invalid' }, 400);
  }
  const canonical = jwk && typeof jwk === 'object' ? canonicalJwk(jwk) : null;
  if (!canonical) return json({ error: 'invalid' }, 400);
  try {
    // Rejects coordinates that aren't a point on P-256.
    await crypto.subtle.importKey('jwk', JSON.parse(canonical), ECDSA, false, ['verify']);
  } catch {
    return json({ error: 'invalid' }, 400);
  }

  const rawIp = clientIp(request, () => clientAddress);
  if (!(await human(turnstile, rawIp))) return json({ error: 'turnstile' }, 403);

  try {
    const ip = await digest('career-reg', rawIp);
    const day = new Date().toISOString().slice(0, 10);
    const deviceId = await deviceIdFor(canonical);
    const [count] = (await pipeline(redis, [
      ['INCR', `career:reg:${ip}:${day}`],
      ['EXPIRE', `career:reg:${ip}:${day}`, 86_400],
    ])) as [number];
    if (count > REGISTRATIONS_PER_IP_PER_DAY) return json({ error: 'rate-limited' }, 429);
    // Re-registering the same key just refreshes its 90-day lifetime.
    await pipeline(redis, [['SET', deviceKey(deviceId), canonical, 'EX', DEVICE_TTL_S]]);
    return json({ deviceId });
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
};
