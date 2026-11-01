import type { APIRoute } from 'astro';
import { cleanProfile, isoDay, json } from '../../../lib/career/ai.ts';
import { DAILY_LIMITS, plausibleDay } from '../../../lib/career/limits.ts';
import { take, usageKey } from '../../../lib/career/quota.ts';
import { breather, overBudget } from '../../../lib/career/spend.ts';
import { SSE_HEADERS, frame } from '../../../lib/career/stream.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { SEARCH_INDEX, liveSearch } from '../../../lib/jobs/live.ts';
import { queriesFor } from '../../../lib/jobs/search.ts';
import { rankAndServe, type ServeContext } from '../../../lib/jobs/serve.ts';
import { KEY, parseIndex } from '../../../lib/jobs/store.ts';
import { placeFor } from '../../../lib/jobs/geo.ts';
import { SOURCES, type SourceId } from '../../../lib/jobs/types.ts';
import { clientIp, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

/**
 * Live job search, streamed (Server-Sent Events): when the shared pool has nothing that fits, search Adzuna and Jooble
 * with the visitor's role, level and place, keep only roles from the last month, save them for everyone, then rank and
 * serve like /api/career/jobs. Events: `progress` {text} while searching, then `result` (the same body as
 * /api/career/jobs, plus `searched`) or `error`, then `done`. The progress lines keep the connection alive.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const redis = redisConfig();
  if (!redis) return json({ error: 'unavailable' }, 503);
  let ctx: ServeContext;
  let anywhere = false;
  try {
    const check = await verifySigned(request, redis);
    if (!check.ok) return rejected(check);
    let body: { profile?: unknown; day?: unknown; today?: unknown; count?: unknown; anywhere?: unknown };
    try {
      body = JSON.parse(check.body);
    } catch {
      return json({ error: 'invalid' }, 400);
    }
    const profile = cleanProfile(body.profile);
    const day = typeof body.day === 'string' ? body.day : '';
    if (!profile || !plausibleDay(day)) return json({ error: 'invalid' }, 400);
    anywhere = body.anywhere === true;

    const [used, served] = await pipeline(redis, [['HGET', usageKey(check.deviceId, day), 'jobs'], ['SMEMBERS', KEY.served(check.deviceId)]]);
    const left = Math.max(0, DAILY_LIMITS.jobs - (Number(used) || 0));
    if (!left) return json({ jobs: [], left: 0, reason: 'limit' });
    if (await overBudget(redis)) return breather();
    ctx = {
      redis,
      deviceId: check.deviceId,
      ip: clientIp(request, () => clientAddress),
      day,
      today: isoDay(body.today),
      profile,
      place: placeFor(profile.location ?? profile.identity.location, request.headers),
      want: Math.min(10, Math.max(1, Number(body.count) || 10)),
      left,
      seen: new Set(Array.isArray(served) ? (served as string[]) : []),
      signal: request.signal,
    };
  } catch (err) {
    console.error('[job-search] failed:', (err as Error).message);
    return json({ error: 'unavailable' }, 503);
  }

  const quota = await take(redis, ctx.deviceId, ctx.ip, ctx.day, 'searches').catch(() => null);
  if (!quota) return json({ error: 'unavailable' }, 503);
  if (!quota.ok) return json({ error: 'limit', kind: 'searches', scope: quota.scope }, 429);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(frame(event, data));
        } catch {}
      };
      try {
        const queries = queriesFor(ctx.profile, { anywhere, place: ctx.place });
        const live = await liveSearch(redis, queries, (p) => send('progress', p));
        // A search that ran nothing new (not set up, or all reused) gives the day's search back.
        if (!live.searched.length) await quota.release().catch(() => {});
        send('progress', { text: 'Ranking what I found against your profile…' });
        const sources = Object.keys(SOURCES) as SourceId[];
        const all = (await pipeline(redis, [...sources.map((s) => ['GET', KEY.index(s)]), ['GET', SEARCH_INDEX]], 15_000)).flatMap(parseIndex);
        const out = await rankAndServe(ctx, all);
        if (!out.ok) send('error', { code: out.error });
        else send('result', { ...out.body, searched: [...live.searched, ...live.reused], searchable: live.configured });
      } catch (err) {
        console.error('[job-search] failed:', (err as Error).message);
        await quota.release().catch(() => {});
        send('error', { code: 'unavailable' });
      } finally {
        send('done', {});
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
};
