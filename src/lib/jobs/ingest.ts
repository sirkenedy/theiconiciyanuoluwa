// Job ingest (career-mode.md §3.3a), shared by the hourly GitHub Action (scripts/ingest-jobs.ts) and the live fallback
// in /api/career/jobs (when the pool is empty or stale). Fetches each source that is due, keeps its window, dedupes,
// writes descriptions only for new jobs, and never wipes a good index when a fetch fails.
import { pipeline, type Redis } from '../redis.ts';
import { BOARDS, SourceError, himalayas, jobicy, remotive } from './sources.ts';
import { INDEX_TTL_S, KEY, MAX_PER_SOURCE, dedupeKey, parseIndex } from './store.ts';
import { SOURCES, WINDOW_MS, type Company, type Fetched, type SourceId } from './types.ts';

export type IngestOptions = {
  redis: Redis | null; // null with `dry`
  companies: Company[];
  force?: boolean; // ignore each source's cadence
  dry?: boolean; // fetch and report, write nothing
  /** Live fallback: stop starting new board requests at this time (ms epoch); whatever arrived is still written. */
  deadline?: number;
  /** Board requests in flight per ATS (the hourly run is gentle: 1, with a pause). */
  concurrency?: number;
  pauseMs?: number;
  log?: (line: string) => void;
};
export type IngestReport = { commands: number; jobs: number; sources: Partial<Record<SourceId, string>> };

export async function ingest(o: IngestOptions): Promise<IngestReport> {
  const { companies, force = false, dry = false, concurrency = 1, pauseMs = 250, log = () => {} } = o;
  const now = Date.now();
  const ids = Object.keys(SOURCES) as SourceId[];
  const report: IngestReport = { commands: 0, jobs: 0, sources: {} };
  const run = async (cmds: (string | number)[][]) => {
    report.commands += cmds.length;
    return dry ? cmds.map(() => null) : pipeline(o.redis!, cmds);
  };
  const late = () => o.deadline !== undefined && Date.now() >= o.deadline;
  /** Live runs stop waiting for a slow source 5 s after the deadline (its request is abandoned, not the run). */
  const capped = <T>(p: Promise<T>): Promise<T> => {
    if (o.deadline === undefined) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cut = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('live deadline')), Math.max(0, o.deadline! + 5000 - Date.now()))));
    return Promise.race([p, cut]).finally(() => clearTimeout(timer));
  };

  async function boards(source: SourceId): Promise<Fetched[]> {
    const list = companies.filter((c) => c.active && c.ats === source);
    const out: Fetched[] = [];
    let failures = 0;
    let stop = false;
    let next = 0;
    // A small worker pool: each worker takes the next board until the list, the deadline or a 429 ends it.
    const worker = async () => {
      while (!stop && !late() && next < list.length) {
        const c = list[next++];
        try {
          out.push(...(await capped(BOARDS[source as keyof typeof BOARDS](c, now))));
        } catch (err) {
          failures++;
          log(`  ${source}/${c.token}: ${(err as Error).message}`);
          if (err instanceof SourceError && err.status === 429) stop = true;
        }
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    if (list.length && failures === list.length) throw new Error(`every ${source} board failed`);
    return out;
  }

  const fetchSource = (source: SourceId): Promise<Fetched[]> =>
    source === 'himalayas' ? capped(himalayas(now)) : source === 'remotive' ? capped(remotive(now)) : source === 'jobicy' ? capped(jobicy(now)) : boards(source);

  const state = await run(ids.flatMap((s) => [['GET', KEY.lastRun(s)], ['GET', KEY.index(s)]]));

  await Promise.all(
    ids.map(async (source, i) => {
      const last = Number(state[i * 2]) || 0;
      if (!force && now - last < (SOURCES[source].everyMinutes - 5) * 60_000) {
        report.sources[source] = `not due (last run ${Math.round((now - last) / 60_000)} min ago)`;
        return;
      }
      let fetched: Fetched[];
      try {
        fetched = await fetchSource(source);
      } catch (err) {
        // Keep the previous index: a failed fetch must not wipe good jobs. It still expires on its own after 50 h.
        report.sources[source] = `failed: ${(err as Error).message}`;
        return;
      }

      const seen = new Set<string>();
      // Real posting times first (they're what "posted ≤ 60 min" needs), then re-touched jobs, newest first within each.
      const kept = fetched
        .sort((a, b) => Number(a.job.time.kind === 'updated') - Number(b.job.time.kind === 'updated') || b.job.time.at - a.job.time.at)
        .filter(({ job }) => {
          const k = dedupeKey(job);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, MAX_PER_SOURCE);
      // A live run cut short by its deadline must not replace a fuller index with a partial one.
      const previous = parseIndex(state[i * 2 + 1]);
      if (late() && kept.length < previous.length) {
        report.sources[source] = `kept the previous ${previous.length} jobs (deadline)`;
        return;
      }

      const before = new Set(previous.map((j) => j.id));
      const fresh = kept.filter(({ job }) => !before.has(job.id));
      // Descriptions only for new jobs, in batches that stay well under Upstash's request size limit.
      let batch: (string | number)[][] = [];
      let bytes = 0;
      for (const { job, description } of fresh) {
        batch.push(['SET', KEY.description(job.id), description, 'EX', Math.ceil((SOURCES[source].windowMs ?? WINDOW_MS) / 1000)]);
        bytes += description.length * 2;
        if (bytes > 600_000) {
          await run(batch);
          batch = [];
          bytes = 0;
        }
      }
      if (batch.length) await run(batch);
      // A source cut short by the live deadline isn't marked as run, so the next hourly ingest completes it.
      await run([
        ['SET', KEY.index(source), JSON.stringify(kept.map((f) => f.job)), 'EX', INDEX_TTL_S],
        ...(late() ? [] : [['SET', KEY.lastRun(source), now]]),
      ]);
      report.jobs += kept.length;
      const posted = kept.filter(({ job }) => job.time.kind !== 'updated' && now - job.time.at <= 3600_000).length;
      report.sources[source] = `${String(kept.length).padStart(4)} jobs, ${String(fresh.length).padStart(4)} new, ${posted} posted in the last hour`;
    }),
  );
  return report;
}
