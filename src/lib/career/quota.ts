// Server-side daily quotas: one Redis round trip to take a unit, a second only to give it back when over the limit.
import { DEVICE_LIMITS, IP_LIMITS, type CountedKind } from './limits.ts';
import { digest, pipeline, type Redis } from '../redis.ts';

export const usageKey = (deviceId: string, day: string) => `career:use:${deviceId}:${day}`;
export const ipUsageKey = async (ip: string) => `career:ip:${await digest('career-ip', ip)}:${new Date().toISOString().slice(0, 10)}`;
const TTL = 2 * 86_400;

export type Taken = { ok: true; release: () => Promise<void> } | { ok: false; scope: 'device' | 'ip' };

/** Takes `amount` of `kind` for today on both the device and the IP. `release` refunds it (e.g. the model call failed). */
export async function take(redis: Redis, deviceId: string, ip: string, day: string, kind: CountedKind, amount = 1): Promise<Taken> {
  const dev = usageKey(deviceId, day);
  const ipKey = await ipUsageKey(ip);
  const out = await pipeline(redis, [
    ['HINCRBY', dev, kind, amount],
    ['EXPIRE', dev, TTL],
    ['HINCRBY', ipKey, kind, amount],
    ['EXPIRE', ipKey, TTL],
  ]);
  const release = async () => {
    await pipeline(redis, [['HINCRBY', dev, kind, -amount], ['HINCRBY', ipKey, kind, -amount]]);
  };
  const deviceOver = Number(out[0]) > DEVICE_LIMITS[kind];
  const ipOver = Number(out[2]) > IP_LIMITS[kind];
  if (deviceOver || ipOver) {
    await release();
    return { ok: false, scope: deviceOver ? 'device' : 'ip' };
  }
  return { ok: true, release };
}
