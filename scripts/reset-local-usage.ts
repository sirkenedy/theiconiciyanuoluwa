// Resets the Career Coach limits for local testing only: `npm run reset:local-usage`.
// Deletes today's (and yesterday's, UTC) network counters for localhost addresses, never anyone else's, so it is safe
// even when .env points at the production Upstash database. Then clear this site's data in the browser
// (DevTools → Application → Clear site data) to start as a new device with fresh device counters.
import { digest, pipeline, redisConfig } from '../src/lib/redis.ts';

try {
  process.loadEnvFile('.env');
} catch {}

const redis = redisConfig();
if (!redis) {
  console.error('No UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env: nothing to reset.');
  process.exit(1);
}

const LOCAL = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', 'unknown'];
const days = [0, 1].map((back) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10));
const keys: string[] = [];
for (const ip of LOCAL) {
  const [net, reg] = await Promise.all([digest('career-ip', ip), digest('career-reg', ip)]);
  for (const day of days) keys.push(`career:ip:${net}:${day}`, `career:reg:${reg}:${day}`);
}

const [deleted] = (await pipeline(redis, [['DEL', ...keys]])) as [number];
console.log(`Reset local Career Coach limits (${deleted} counter${deleted === 1 ? '' : 's'} removed).`);
console.log('Now clear this site\'s data in the browser (DevTools → Application → Clear site data) and reload /career.');
