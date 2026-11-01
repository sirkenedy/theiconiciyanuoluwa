import type { APIRoute } from 'astro';
import { REACTION_KEYS } from '../../content/reaction-keys.ts';
import { MAX_CHANGES, VISITOR_PATTERN, type ReactionChange } from '../../lib/reactions.ts';
import { clientIp, digest, pipeline, redisConfig } from '../../lib/redis.ts';

export const prerender = false;

const ALLOWED = new Set(REACTION_KEYS);
const WRITES_PER_MINUTE = 60;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

const setKey = (key: string) => `rx:${key}`;
/** For the owner (Upstash Data Browser): all reactions right now, and the count per reaction. */
const TOTAL_KEY = 'rx:total';
const BREAKDOWN_KEY = 'rx:breakdown';

// Without Redis the client keeps counts locally, so "disabled" is a normal 200, not an error.
export const GET: APIRoute = async () => {
  const redis = redisConfig();
  if (!redis) return json({ enabled: false });
  try {
    const keys = [...ALLOWED];
    const sizes = await pipeline(redis, keys.map((k) => ['SCARD', setKey(k)]));
    const counts = Object.fromEntries(keys.map((k, i) => [k, Number(sizes[i]) || 0]));
    return json({ enabled: true, counts }, 200, { 'cache-control': 'public, s-maxage=15, stale-while-revalidate=60' });
  } catch {
    return json({ enabled: false });
  }
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const redis = redisConfig();
  if (!redis) return json({ enabled: false });

  let body: { visitor?: unknown; changes?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid' }, 400);
  }
  const { visitor, changes } = body;
  const valid =
    typeof visitor === 'string' &&
    VISITOR_PATTERN.test(visitor) &&
    Array.isArray(changes) &&
    changes.length > 0 &&
    changes.length <= MAX_CHANGES &&
    changes.every((c: ReactionChange) => c && ALLOWED.has(c.key) && typeof c.on === 'boolean');
  if (!valid) return json({ error: 'invalid' }, 400);

  // The last change per key wins. Set members are the hashed network, not the browser id, so a private window,
  // another browser or cleared storage can't add a second reaction of the same type from the same place.
  const latest = new Map((changes as ReactionChange[]).map((c) => [c.key, c.on]));
  const ip = clientIp(request, () => clientAddress);
  const member = await digest('react', ip);
  const limitKey = `rl:react:${member}:${Math.floor(Date.now() / 60_000)}`;

  try {
    const [writes] = await pipeline(redis, [['INCR', limitKey], ['EXPIRE', limitKey, 120]]);
    if (Number(writes) > WRITES_PER_MINUTE) return json({ error: 'rate_limited' }, 429);

    const keys = [...latest.keys()];
    const results = await pipeline(redis, [
      ...keys.map((k) => [latest.get(k) ? 'SADD' : 'SREM', setKey(k), member]),
      ...keys.map((k) => ['SCARD', setKey(k)]),
    ]);
    const counts = Object.fromEntries(keys.map((k, i) => [k, Number(results[keys.length + i]) || 0]));
    const changed = keys.filter((_, i) => Number(results[i]) === 1).map((k) => [k, latest.get(k) ? 1 : -1] as const);
    if (changed.length) {
      const delta = changed.reduce((sum, [, d]) => sum + d, 0);
      await pipeline(redis, [['INCRBY', TOTAL_KEY, delta], ...changed.map(([k, d]) => ['HINCRBY', BREAKDOWN_KEY, k, d])]).catch(() => {});
    }
    return json({ enabled: true, counts });
  } catch {
    return json({ error: 'upstream' }, 502);
  }
};
