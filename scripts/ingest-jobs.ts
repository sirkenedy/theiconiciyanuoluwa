// Hourly job ingest (career-mode.md §3.3a), run by .github/workflows/ingest-jobs.yml. Fetches each source that is due
// (Himalayas daily, Remotive every 6 h, the rest hourly), keeps the last 48 h, dedupes and writes to Upstash Redis.
// The same code (src/lib/jobs/ingest.ts) also runs live from /api/career/jobs when the pool is empty or stale.
// `node scripts/ingest-jobs.ts` · `--force` ignores cadences · `--dry` fetches and reports without writing.
import { readFileSync } from 'node:fs';
import { redisConfig } from '../src/lib/redis.ts';
import { ingest } from '../src/lib/jobs/ingest.ts';
import type { Company } from '../src/lib/jobs/types.ts';

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

const companies = JSON.parse(readFileSync('src/content/companies.json', 'utf8')) as Company[];
const report = await ingest({ redis, companies, force, dry, log: (line) => console.warn(line) });
for (const [source, line] of Object.entries(report.sources)) console.log(`${source.padEnd(10)} ${line}`);
console.log(`${dry ? '[dry run] would use' : 'used'} ${report.commands} Redis commands`);
