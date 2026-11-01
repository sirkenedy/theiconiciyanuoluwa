import type { APIRoute } from 'astro';
import { cleanProfile, isoDay, json } from '../../../lib/career/ai.ts';
import { DAILY_LIMITS, plausibleDay } from '../../../lib/career/limits.ts';
import { usageKey } from '../../../lib/career/quota.ts';
import { breather } from '../../../lib/career/spend.ts';
import type { RankedJob } from '../../../lib/career/types.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { ingest } from '../../../lib/jobs/ingest.ts';
import { SEARCH_INDEX } from '../../../lib/jobs/live.ts';
import { pendingKey, rankAndServe, serve, type ServeContext } from '../../../lib/jobs/serve.ts';
import { KEY, parseIndex } from '../../../lib/jobs/store.ts';
import { SOURCES, type SourceId } from '../../../lib/jobs/types.ts';
import { clientIp, pipeline, redisConfig, type Redis } from '../../../lib/redis.ts';

export const prerender = false;

/** The hourly ingest keeps the pool fresh; if it hasn't run for this long (or the pool is empty), refresh the feeds. */
const STALE_MS = 3 * 3600_000;
const REFRESH_LOCK = 'jobs:refresh:lock';
/** The three job feeds: one request each, so a refresh inside a visitor's request stays quick. */
const FEEDS: SourceId[] = ['himalayas', 'remotive', 'jobicy'];

async function refreshFeeds(redis: Redis): Promise<'done' | 'busy'> {
  const [lock] = await pipeline(redis, [['SET', REFRESH_LOCK, '1', 'NX', 'EX', 90]]);
  if (lock !== 'OK') return 'busy';
  try {
    const report = await ingest({ redis, companies: [], only: FEEDS, deadline: Date.now() + 15_000, concurrency: 1, pauseMs: 0 });
    console.log(`[jobs] feed refresh: ${report.jobs} jobs`, report.sources);
  } catch (err) {
    console.error('[jobs] feed refresh failed:', (err as Error).message);
  } finally {
    await pipeline(redis, [['DEL', REFRESH_LOCK]]).catch(() => {});
  }
  return 'done';
}

const readPool = async (redis: Redis, sources: SourceId[]) =>
  (await pipeline(redis, [...sources.map((s) => ['GET', KEY.index(s)]), ['GET', SEARCH_INDEX]], 15_000)).flatMap(parseIndex);

/**
 * Up to 5 fresh job cards per device per day (career-mode.md §3.3), from the shared pool: the hourly ingest, discovered
 * boards and earlier live searches. If the pool is empty or stale the three job feeds are refreshed first. When nothing
 * fits, the client follows up with /api/career/job-search (a live keyword search, streamed).
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const redis = redisConfig();
  if (!redis) return json({ error: 'unavailable' }, 503);
  try {
    const check = await verifySigned(request, redis);
    if (!check.ok) return rejected(check);

    let body: { profile?: unknown; day?: unknown; today?: unknown; count?: unknown; more?: unknown };
    try {
      body = JSON.parse(check.body);
    } catch {
      return json({ error: 'invalid' }, 400);
    }
    const profile = cleanProfile(body.profile);
    const day = typeof body.day === 'string' ? body.day : '';
    const want = Math.min(5, Math.max(1, Number(body.count) || 3));
    if (!profile || !plausibleDay(day)) return json({ error: 'invalid' }, 400);

    const sources = Object.keys(SOURCES) as SourceId[];
    const [used, served, pending, ...lastRuns] = await pipeline(redis, [
      ['HGET', usageKey(check.deviceId, day), 'jobs'],
      ['SMEMBERS', KEY.served(check.deviceId)],
      ['GET', pendingKey(check.deviceId, day)],
      ...sources.map((s) => ['GET', KEY.lastRun(s)]),
    ]);
    const left = Math.max(0, DAILY_LIMITS.jobs - (Number(used) || 0));
    if (!left) return json({ jobs: [], left: 0, reason: 'limit' });
    const ctx: ServeContext = {
      redis,
      deviceId: check.deviceId,
      ip: clientIp(request, () => clientAddress),
      day,
      today: isoDay(body.today),
      profile,
      want,
      left,
      seen: new Set(Array.isArray(served) ? (served as string[]) : []),
      signal: request.signal,
    };

    let out;
    if (body.more === true && typeof pending === 'string') {
      out = await serve(ctx, (JSON.parse(pending) as RankedJob[]).filter((j) => !ctx.seen.has(j.id)), null);
    } else {
      let all = await readPool(redis, sources);
      const lastRun = Math.max(0, ...lastRuns.map((v) => Number(v) || 0));
      if (!all.length || Date.now() - lastRun > STALE_MS) {
        const outcome = await refreshFeeds(redis);
        if (outcome === 'busy' && !all.length) return json({ jobs: [], left, reason: 'warming' });
        if (outcome === 'done') all = await readPool(redis, sources);
      }
      out = await rankAndServe(ctx, all);
    }
    if (!out.ok) return out.error === 'breather' ? breather() : json({ error: out.error }, out.error === 'upstream' ? 502 : 503);
    return json(out.body);
  } catch (err) {
    // Never a raw crash: a slow or unreachable Redis is reported like any other outage.
    console.error('[jobs] failed:', (err as Error).message);
    return json({ error: 'unavailable' }, 503);
  }
};
