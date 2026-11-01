import type { APIRoute } from 'astro';
import { DAILY_LIMITS, IP_LIMITS, plausibleDay, type Usage, type UsageKind } from '../../../lib/career/limits.ts';
import { ipUsageKey, usageKey } from '../../../lib/career/quota.ts';
import { overBudget } from '../../../lib/career/spend.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { clientIp, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Today's remaining quotas: the tighter of this device's and this network's, so the sidebar matches what a request
 * will get. `day` is the device's local date (limits reset at its midnight); it's part of the signed path. */
export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const redis = redisConfig();
  if (!redis) return json({ error: 'unavailable' }, 503);
  try {
    const check = await verifySigned(request, redis);
    if (!check.ok) return rejected(check);

    const day = url.searchParams.get('day') ?? '';
    if (!plausibleDay(day)) return json({ error: 'invalid' }, 400);

    const kinds = Object.keys(DAILY_LIMITS) as UsageKind[];
    const ipKey = await ipUsageKey(clientIp(request, () => clientAddress));
    const [dev, net] = (await pipeline(redis, [['HMGET', usageKey(check.deviceId, day), ...kinds], ['HMGET', ipKey, ...kinds]])) as (string | null)[][];
    const used = Object.fromEntries(
      kinds.map((k, i) => {
        const left = Math.min(DAILY_LIMITS[k] - (Number(dev?.[i]) || 0), IP_LIMITS[k] - (Number(net?.[i]) || 0));
        return [k, Math.min(DAILY_LIMITS[k], Math.max(0, DAILY_LIMITS[k] - left))];
      }),
    ) as Usage['used'];
    return json({ day, limits: DAILY_LIMITS, used, breather: await overBudget(redis) } satisfies Usage);
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
};
