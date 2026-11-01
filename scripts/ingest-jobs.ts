// Hourly job ingest (career-mode.md §3.3a), run by .github/workflows/ingest-jobs.yml. Fetches each source that is due
// (Himalayas daily, Remotive every 6 h, the rest hourly), keeps the last 48 h, dedupes and writes to Upstash Redis.
// The same code (src/lib/jobs/ingest.ts) also runs live from /api/career/jobs when the pool is empty or stale.
// `node scripts/ingest-jobs.ts` · `--force` ignores cadences · `--dry` fetches and reports without writing.
import { readFileSync } from 'node:fs';
import { redisConfig } from '../src/lib/redis.ts';
import { ingest } from '../src/lib/jobs/ingest.ts';
import { boardKey, discover, discoveredBoards } from '../src/lib/jobs/discover.ts';
import { SEARCH_COMPANIES, SEARCH_INDEX } from '../src/lib/jobs/live.ts';
import { REGION_COMPANIES } from '../src/lib/jobs/regions.ts';
import { DEMAND, DEMAND_LAST, KEY, parseIndex } from '../src/lib/jobs/store.ts';
import { SOURCES, type Company, type SourceId } from '../src/lib/jobs/types.ts';
import { pipeline } from '../src/lib/redis.ts';

const force = process.argv.includes('--force');
const dry = process.argv.includes('--dry');
if (!dry && process.env.CI !== 'true' && !process.env.UPSTASH_REDIS_REST_URL && !process.env.KV_REST_API_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {}
}
const redis = redisConfig();
if (!redis && !dry) {
  console.error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or run with --dry).');
  process.exit(1);
}

// The hand-made list plus every board discovered so far (both fetched each hour).
const listed = JSON.parse(readFileSync('src/content/companies.json', 'utf8')) as Company[];
const found = redis ? await discoveredBoards(redis) : [];
const known = new Set(listed.map((c) => boardKey(c.ats, c.token)));
const companies = [...listed, ...found.filter((c) => !known.has(boardKey(c.ats, c.token)))];
console.log(`boards: ${listed.filter((c) => c.active).length} listed + ${companies.length - listed.length} discovered`);

const report = await ingest({ redis, companies, force, dry, log: (line) => console.warn(line) });
for (const [source, line] of Object.entries(report.sources)) console.log(`${source.padEnd(10)} ${line}`);
console.log(`${dry ? '[dry run] would use' : 'used'} ${report.commands} Redis commands`);

// Discovery: hiring pages linked from the pool, and companies seen in live searches since the last run.
if (redis && !dry) {
  const ids = Object.keys(SOURCES) as SourceId[];
  const [names, demand, demandAt, ...indexes] = (await pipeline(
    redis,
    [['SPOP', SEARCH_COMPANIES, 40], ['HGETALL', DEMAND], ['HGETALL', DEMAND_LAST], ...ids.map((s) => ['GET', KEY.index(s)]), ['GET', SEARCH_INDEX]],
    20_000,
  )) as [string[] | null, string[] | null, string[] | null, ...(string | null)[]];
  const pool = indexes.flatMap(parseIndex);
  // Countries where people found nothing in the last 2 weeks, most asked first: try their starter companies.
  const pairs = (flat: string[] | null) => new Map(Array.from({ length: (flat?.length ?? 0) / 2 }, (_, i) => [flat![i * 2], Number(flat![i * 2 + 1])]));
  const asked = pairs(demand);
  const last = pairs(demandAt);
  const countries = [...asked.keys()].filter((c) => Date.now() - (last.get(c) ?? 0) < 14 * 86_400_000 && REGION_COMPANIES[c]).sort((a, b) => asked.get(b)! - asked.get(a)!);
  if (countries.length) console.log(`demand: ${countries.map((c) => `${c} ×${asked.get(c)}`).join(', ')}`);
  const regionCompanies = countries.flatMap((country) => REGION_COMPANIES[country].map((company) => ({ company, country })));
  const d = await discover(redis, pool, names ?? [], companies, (line) => console.log(line), regionCompanies);
  console.log(`discovery: ${d.checked} checked, ${d.added.length} added, ${d.skipped.length} skipped`);
  for (const s of d.skipped) console.log(`  - ${s.key}: ${s.reason}${s.policy ? ' (policy)' : ''}`);
}
