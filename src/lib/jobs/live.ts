// Runs the live keyword searches for one visitor and keeps what they find for everyone:
//   jobs:idx:search     JSON Job[] from Adzuna/Jooble (newest first, ≤ 1500, a month at most)
//   jobs:desc:<id>      descriptions, as for every other source
//   search:done         "<what>|<where>|<country>" → { label, at, found }: the same search isn't repeated for 6 h
//   search:companies    company names seen in results, for the hourly board discovery
//   search:calls:<source>:<UTC day>  calls made today, kept under each API's daily allowance
import { pipeline, type Redis } from '../redis.ts';
import { SEARCH, searchConfigured, type SearchQuery, type SearchSource } from './search.ts';
import { KEY, dedupeKey, parseIndex } from './store.ts';
import { MAX_DESCRIPTION, WINDOW_MS, type Job } from './types.ts';

export const SEARCH_INDEX = 'jobs:idx:search';
export const SEARCH_DONE = 'search:done';
export const SEARCH_COMPANIES = 'search:companies';
const REPEAT_MS = 6 * 3600_000;
const MAX_INDEX = 1500;
const TTL_S = Math.ceil(WINDOW_MS / 1000);

export type LiveProgress = { text: string };
export type LiveResult = { searched: string[]; reused: string[]; found: number; configured: boolean };

export async function liveSearch(redis: Redis, queries: SearchQuery[], onProgress: (p: LiveProgress) => void = () => {}): Promise<LiveResult> {
  const sources = (Object.keys(SEARCH) as SearchSource[]).filter(searchConfigured);
  const out: LiveResult = { searched: [], reused: [], found: 0, configured: sources.length > 0 };
  if (!sources.length || !queries.length) return out;

  const day = new Date().toISOString().slice(0, 10);
  const [done, ...calls] = (await pipeline(redis, [['HMGET', SEARCH_DONE, '_', ...queries.map((q) => q.key)], ...sources.map((s) => ['GET', `search:calls:${s}:${day}`])])) as [(string | null)[], ...(string | null)[]];
  const now = Date.now();
  const fresh = queries.filter((q, i) => {
    const prev = done?.[i + 1] ? (JSON.parse(done[i + 1]!) as { at: number }) : null;
    if (prev && now - prev.at < REPEAT_MS) {
      out.reused.push(q.label);
      onProgress({ text: `Already searched ${q.label} recently: using those results.` });
      return false;
    }
    return true;
  });
  const budget = new Map(sources.map((s, i) => [s, SEARCH[s].dailyCap - (Number(calls[i]) || 0)]));
  const made = new Map<SearchSource, number>(sources.map((s) => [s, 0]));

  const found: { job: Job; description: string }[] = [];
  const perQuery = new Map<string, number>();
  await Promise.all(
    fresh.flatMap((q) =>
      sources.map(async (s) => {
        if ((budget.get(s) ?? 0) <= 0) return onProgress({ text: `${SEARCH[s].name} has reached today's search allowance.` });
        budget.set(s, (budget.get(s) ?? 0) - 1);
        made.set(s, (made.get(s) ?? 0) + 1);
        onProgress({ text: `Searching ${SEARCH[s].name} for ${q.label}…` });
        try {
          const rows = await SEARCH[s].run(q);
          found.push(...rows);
          perQuery.set(q.key, (perQuery.get(q.key) ?? 0) + rows.length);
          onProgress({ text: `${SEARCH[s].name}: ${rows.length} recent ${rows.length === 1 ? 'role' : 'roles'} for ${q.label}.` });
        } catch (err) {
          console.error(`[jobs] ${s} search failed: ${(err as Error).message}`);
          onProgress({ text: `${SEARCH[s].name} didn't answer; carrying on.` });
        }
      }),
    ),
  );
  out.searched = fresh.map((q) => q.label);
  out.found = found.length;

  const writes: (string | number)[][] = [
    ...sources.map((s) => ['INCRBY', `search:calls:${s}:${day}`, made.get(s) ?? 0]),
    ...sources.map((s) => ['EXPIRE', `search:calls:${s}:${day}`, 2 * 86_400]),
    ...fresh.map((q) => ['HSET', SEARCH_DONE, q.key, JSON.stringify({ label: q.label, at: now, found: perQuery.get(q.key) ?? 0 })]),
  ];
  if (found.length) {
    const [rawIndex] = (await pipeline(redis, [['GET', SEARCH_INDEX]], 10_000)) as [string | null];
    const seen = new Set<string>();
    const merged = [...found.map((f) => f.job), ...parseIndex(rawIndex)]
      .filter((j) => now - j.time.at <= WINDOW_MS)
      .sort((a, b) => b.time.at - a.time.at)
      .filter((j) => {
        const k = dedupeKey(j);
        if (seen.has(k) || seen.has(j.id)) return false;
        seen.add(k);
        seen.add(j.id);
        return true;
      })
      .slice(0, MAX_INDEX);
    writes.push(['SET', SEARCH_INDEX, JSON.stringify(merged), 'EX', TTL_S]);
    for (const f of found) writes.push(['SET', KEY.description(f.job.id), f.description.slice(0, MAX_DESCRIPTION), 'EX', TTL_S, 'NX']);
    const companies = [...new Set(found.map((f) => f.job.company).filter((c) => c && c !== 'Company not listed'))];
    if (companies.length) writes.push(['SADD', SEARCH_COMPANIES, ...companies.slice(0, 200)]);
  }
  await pipeline(redis, writes, 20_000);
  return out;
}
