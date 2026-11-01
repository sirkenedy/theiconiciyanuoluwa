// Shared by /api/career/jobs (the pool) and /api/career/job-search (live search): pick candidates, rank them with one
// batched model call, keep fit ≥ 55, serve a few now and park the rest for "Show more", never repeating a job.
import Anthropic from '@anthropic-ai/sdk';
import { MODEL, SYSTEM, anthropic, asData, type cleanProfile } from '../career/ai.ts';
import { take } from '../career/quota.ts';
import { overBudget, recordSpend } from '../career/spend.ts';
import { MIN_FIT, RANK_JSON_SCHEMA, RankSchema, type RankedJob } from '../career/types.ts';
import { pipeline, type Redis } from '../redis.ts';
import type { Place } from './geo.ts';
import { candidates, type Tier } from './select.ts';
import { DEMAND, DEMAND_LAST, KEY, SERVED_TTL_S, demandRoles } from './store.ts';
import type { Job } from './types.ts';

const PENDING_TTL_S = 6 * 3600;
export const pendingKey = (deviceId: string, day: string) => `career:pending:${deviceId}:${day}`;
const TIER_NAMES: Record<Tier, string> = { 1: 'hour', 2: 'today', 3: 'month' };

export type Profile = NonNullable<ReturnType<typeof cleanProfile>>;
export type JobsBody = {
  jobs: RankedJob[];
  left: number;
  more?: number;
  tier?: string;
  /** Why nothing was served: today's limit, nothing relevant, the pool is empty, or another request is filling it. */
  reason?: 'limit' | 'none' | 'empty' | 'warming';
  /** How many jobs were looked at, so "no matches" can say so honestly. */
  checked?: number;
  /** Live search only: what was searched (or reused), and whether any search service is set up. */
  searched?: string[];
  searchable?: boolean;
  /** Nothing fit, so this country was noted for the hourly board discovery ("Nigeria"). */
  demand?: string;
};
export type Served = { ok: true; body: JobsBody } | { ok: false; error: 'unavailable' | 'breather' | 'upstream' };
export type ServeContext = { redis: Redis; deviceId: string; ip: string; day: string; today: string; profile: Profile; place: Place; want: number; left: number; seen: Set<string>; signal: AbortSignal };


/** Nothing fit: note the visitor's country (and the roles they want), never who they are. */
async function noteDemand(ctx: ServeContext): Promise<string | undefined> {
  const { country, name } = ctx.place;
  if (!country) return undefined;
  const roles = ctx.profile.targetRoles.slice(0, 3).map((r) => r.trim().slice(0, 60)).filter(Boolean);
  await pipeline(ctx.redis, [
    ['HINCRBY', DEMAND, country, 1],
    ['HSET', DEMAND_LAST, country, String(Date.now())],
    ...(roles.length ? [['SADD', demandRoles(country), ...roles]] : []),
  ]).catch(() => {});
  return name ?? country.toUpperCase();
}

export async function rankAndServe(ctx: ServeContext, all: Job[]): Promise<Served> {
  const picks = candidates(all, ctx.profile, ctx.seen, Date.now(), ctx.place);
  if (!picks.length) return { ok: true, body: { jobs: [], left: ctx.left, reason: all.length ? 'none' : 'empty', checked: all.length, demand: await noteDemand(ctx) } };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'unavailable' };
  if (await overBudget(ctx.redis)) return { ok: false, error: 'breather' };
  const results = await rank(picks.map((p) => p.job), ctx.profile, ctx.today, ctx.signal, (u) => recordSpend(ctx.redis, u), ctx.place).catch(() => null);
  if (!results) return { ok: false, error: 'upstream' };
  const byId = new Map(picks.map((p) => [p.job.id, p.job]));
  const ranked = results
    .filter((r) => r.fit >= MIN_FIT && byId.has(r.jobId)) // never pad with poor fits
    .sort((a, b) => b.fit - a.fit)
    .map((r) => ({ ...byId.get(r.jobId)!, fit: r.fit, why: r.why, gaps: r.gaps }));
  return serve(ctx, ranked, picks[0].tier, all.length);
}

/** Serves the best few now (taking quota for exactly those) and parks the rest for "Show more". */
export async function serve(ctx: ServeContext, ranked: RankedJob[], tier: Tier | null, checked?: number): Promise<Served> {
  const { redis, deviceId, day } = ctx;
  const now = ranked.slice(0, Math.min(ctx.want, ctx.left));
  const rest = ranked.slice(now.length);
  if (!now.length) {
    await pipeline(redis, [['DEL', pendingKey(deviceId, day)]]);
    return { ok: true, body: { jobs: [], left: ctx.left, reason: 'none', checked, demand: tier === null ? undefined : await noteDemand(ctx) } };
  }
  const quota = await take(redis, deviceId, ctx.ip, day, 'jobs', now.length);
  if (!quota.ok) return { ok: true, body: { jobs: [], left: 0, reason: 'limit' } };
  await pipeline(redis, [
    ['SADD', KEY.served(deviceId), ...now.map((j) => j.id)],
    ['EXPIRE', KEY.served(deviceId), SERVED_TTL_S],
    rest.length ? ['SET', pendingKey(deviceId, day), JSON.stringify(rest), 'EX', PENDING_TTL_S] : ['DEL', pendingKey(deviceId, day)],
  ]);
  return { ok: true, body: { jobs: now, left: ctx.left - now.length, more: Math.min(rest.length, ctx.left - now.length), tier: tier ? TIER_NAMES[tier] : undefined } };
}

/** One batched ranking call: structured output, zod-checked, one retry with the error. */
export async function rank(jobs: Job[], profile: Profile, today: string, signal: AbortSignal, onUsage: (u: Anthropic.Usage) => void, place?: Place) {
  const list = jobs.map((j) => ({ jobId: j.id, title: j.title, company: j.company, location: j.location, remote: j.remote, salary: j.salary, snippet: j.snippet }));
  const where = place?.name ? `\n  <candidate_country>${asData(place.name)}${place.from === 'network' ? ' (from their network; the résumé names no country)' : ''}</candidate_country>` : '';
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `task = "rank_jobs"\n<context>\n  <profile>${asData(JSON.stringify(profile))}</profile>\n  <today>${today}</today>${where}\n</context>\n<jobs>\n${asData(JSON.stringify(list))}\n</jobs>\nScore every job. "why": exactly 2 short bullets from the profile; "gaps": up to 2 honest gaps (empty if none). If the job says the candidate can't do it from their country or time zone (e.g. "Colombia only", "must be US-based"), it is not a fit: score it below 40.`,
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await anthropic().messages.create(
      { model: MODEL, max_tokens: 7000, thinking: { type: 'disabled' }, output_config: { effort: 'low', format: { type: 'json_schema', schema: RANK_JSON_SCHEMA } }, system: SYSTEM, messages },
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
