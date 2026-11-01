import Anthropic from '@anthropic-ai/sdk';
import type { APIRoute } from 'astro';
import { MODEL, SYSTEM, anthropic, asData, cleanProfile, isoDay, json } from '../../../lib/career/ai.ts';
import { DAILY_LIMITS, plausibleDay } from '../../../lib/career/limits.ts';
import { take, usageKey } from '../../../lib/career/quota.ts';
import { breather, overBudget, recordSpend } from '../../../lib/career/spend.ts';
import { MIN_FIT, RANK_JSON_SCHEMA, RankSchema, type RankedJob } from '../../../lib/career/types.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import companies from '../../../content/companies.json' with { type: 'json' };
import { ingest } from '../../../lib/jobs/ingest.ts';
import { candidates, type Tier } from '../../../lib/jobs/select.ts';
import { KEY, SERVED_TTL_S, parseIndex } from '../../../lib/jobs/store.ts';
import { SOURCES, type Company, type Job, type SourceId } from '../../../lib/jobs/types.ts';
import { clientIp, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

const PENDING_TTL_S = 6 * 3600;
const pendingKey = (deviceId: string, day: string) => `career:pending:${deviceId}:${day}`;
const TIER_NAMES: Record<Tier, string> = { 1: 'hour', 2: 'today', 3: 'week' };
/** The hourly ingest should keep the pool fresh; if it hasn't run for this long (or the pool is empty), fetch live. */
const STALE_MS = 3 * 3600_000;
const LIVE_BUDGET_MS = 20_000;
const REFRESH_LOCK = 'jobs:refresh:lock';

/** Live fallback: one request at a time fetches the sources (in parallel, ~20 s budget) and writes them to Redis. */
async function refreshPool(redis: NonNullable<ReturnType<typeof redisConfig>>): Promise<'done' | 'busy'> {
  const [lock] = await pipeline(redis, [['SET', REFRESH_LOCK, '1', 'NX', 'EX', 90]]);
  if (lock !== 'OK') return 'busy';
  try {
    const report = await ingest({ redis, companies: companies as Company[], deadline: Date.now() + LIVE_BUDGET_MS, concurrency: 6, pauseMs: 0 });
    console.log(`[jobs] live refresh: ${report.jobs} jobs`, report.sources);
  } catch (err) {
    console.error('[jobs] live refresh failed:', (err as Error).message);
  } finally {
    await pipeline(redis, [['DEL', REFRESH_LOCK]]).catch(() => {});
  }
  return 'done';
}

/**
 * Up to 5 fresh job cards per device per day (career-mode.md §3.3). Reads Redis (the hourly ingest fills it; if the pool is
 * empty or hasn't been refreshed for 3 h, this request fetches the sources live first), ranks
 * up to 25 candidates with one batched model call, keeps fit ≥ 55, never repeats a job. Cards are served a few at a time;
 * the rest of the ranked list waits (6 h) so "Show more" needs no second model call.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const redis = redisConfig();
  if (!redis) return json({ error: 'unavailable' }, 503);
  const check = await verifySigned(request, redis).catch(() => null);
  if (!check) return json({ error: 'unavailable' }, 503);
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
  const [used, served, pending, ...rest0] = await pipeline(redis, [
    ['HGET', usageKey(check.deviceId, day), 'jobs'],
    ['SMEMBERS', KEY.served(check.deviceId)],
    ['GET', pendingKey(check.deviceId, day)],
    ...sources.map((s) => ['GET', KEY.index(s)]),
    ...sources.map((s) => ['GET', KEY.lastRun(s)]),
  ]);
  let indexes = rest0.slice(0, sources.length);
  const lastRun = Math.max(0, ...rest0.slice(sources.length).map((v) => Number(v) || 0));
  const left = Math.max(0, DAILY_LIMITS.jobs - (Number(used) || 0));
  if (!left) return json({ jobs: [], left: 0, reason: 'limit' });
  const seen = new Set(Array.isArray(served) ? (served as string[]) : []);

  let ranked: RankedJob[] = [];
  let tier: Tier | null = null;
  if (body.more === true && typeof pending === 'string') {
    ranked = (JSON.parse(pending) as RankedJob[]).filter((j) => !seen.has(j.id));
  } else {
    let all = indexes.flatMap(parseIndex);
    if (!all.length || Date.now() - lastRun > STALE_MS) {
      const outcome = await refreshPool(redis);
      if (outcome === 'busy' && !all.length) return json({ jobs: [], left, reason: 'warming' });
      if (outcome === 'done') {
        indexes = await pipeline(redis, sources.map((s) => ['GET', KEY.index(s)]));
        all = indexes.flatMap(parseIndex);
      }
      if (!all.length) return json({ jobs: [], left, reason: 'empty' });
    }
    const picks = candidates(all, profile, seen);
    if (!picks.length) return json({ jobs: [], left, reason: 'none' });
    if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'unavailable' }, 503);
    if (await overBudget(redis)) return breather();
    tier = picks[0].tier;
    const results = await rank(picks.map((p) => p.job), profile, isoDay(body.today), request.signal, (u) => recordSpend(redis, u)).catch(() => null);
    if (!results) return json({ error: 'upstream' }, 502);
    const byId = new Map(picks.map((p) => [p.job.id, p.job]));
    ranked = results
      .filter((r) => r.fit >= MIN_FIT && byId.has(r.jobId)) // never pad with poor fits
      .sort((a, b) => b.fit - a.fit)
      .map((r) => ({ ...byId.get(r.jobId)!, fit: r.fit, why: r.why, gaps: r.gaps }));
  }

  const serve = ranked.slice(0, Math.min(want, left));
  const rest = ranked.slice(serve.length);
  if (!serve.length) {
    await pipeline(redis, [['DEL', pendingKey(check.deviceId, day)]]);
    return json({ jobs: [], left, reason: 'none' });
  }
  const quota = await take(redis, check.deviceId, clientIp(request, () => clientAddress), day, 'jobs', serve.length);
  if (!quota.ok) return json({ jobs: [], left: 0, reason: 'limit' });
  await pipeline(redis, [
    ['SADD', KEY.served(check.deviceId), ...serve.map((j) => j.id)],
    ['EXPIRE', KEY.served(check.deviceId), SERVED_TTL_S],
    rest.length ? ['SET', pendingKey(check.deviceId, day), JSON.stringify(rest), 'EX', PENDING_TTL_S] : ['DEL', pendingKey(check.deviceId, day)],
  ]);
  return json({ jobs: serve, left: left - serve.length, more: Math.min(rest.length, left - serve.length), tier: tier ? TIER_NAMES[tier] : undefined });
};

/** One batched ranking call: structured output, zod-checked, one retry with the error. */
export async function rank(jobs: Job[], profile: NonNullable<ReturnType<typeof cleanProfile>>, today: string, signal: AbortSignal, onUsage: (u: Anthropic.Usage) => void) {
  const list = jobs.map((j) => ({ jobId: j.id, title: j.title, company: j.company, location: j.location, remote: j.remote, snippet: j.snippet }));
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `task = "rank_jobs"\n<context>\n  <profile>${asData(JSON.stringify(profile))}</profile>\n  <today>${today}</today>\n</context>\n<jobs>\n${asData(JSON.stringify(list))}\n</jobs>\nScore every job. "why": exactly 2 short bullets from the profile; "gaps": up to 2 honest gaps (empty if none).`,
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await anthropic().messages.create(
      { model: MODEL, max_tokens: 4000, thinking: { type: 'disabled' }, output_config: { effort: 'low', format: { type: 'json_schema', schema: RANK_JSON_SCHEMA } }, system: SYSTEM, messages },
      { timeout: 25_000, signal },
    );
    onUsage(res.usage);
    const out = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {}
    const ok = RankSchema.safeParse(parsed);
    if (ok.success) return ok.data.results;
    messages.push({ role: 'assistant', content: out || '{}' }, { role: 'user', content: 'That JSON did not match the schema (fit is an integer 0–100, at most 2 why and 2 gaps). Return the corrected JSON only.' });
  }
  return null;
}
