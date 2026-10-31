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

  // The last change per key wins; one set per key keeps each visitor to one reaction of each type.
  const latest = new Map((changes as ReactionChange[]).map((c) => [c.key, c.on]));
  const ip = clientIp(request, () => clientAddress);
  const limitKey = `rl:react:${await digest('react', ip)}:${Math.floor(Date.now() / 60_000)}`;

  try {
    const [writes] = await pipeline(redis, [['INCR', limitKey], ['EXPIRE', limitKey, 120]]);
    if (Number(writes) > WRITES_PER_MINUTE) return json({ error: 'rate_limited' }, 429);

    const keys = [...latest.keys()];
    const results = await pipeline(redis, [
      ...keys.map((k) => [latest.get(k) ? 'SADD' : 'SREM', setKey(k), visitor]),
      ...keys.map((k) => ['SCARD', setKey(k)]),
    ]);
    const counts = Object.fromEntries(keys.map((k, i) => [k, Number(results[keys.length + i]) || 0]));
    return json({ enabled: true, counts });
  } catch {
    return json({ error: 'upstream' }, 502);
  }
};
