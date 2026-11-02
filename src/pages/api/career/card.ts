import type { APIRoute } from 'astro';
import { json } from '../../../lib/career/ai.ts';
import { cardCaption, cardSecret, cardToken, cleanCard, type CardFormat } from '../../../lib/career/card.ts';
import { cardPng } from '../../../lib/career/card-image.ts';
import { plausibleDay } from '../../../lib/career/limits.ts';
import { take } from '../../../lib/career/quota.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { clientIp, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

/** Shared cards per UTC day: a count only (nothing about who, or what was on them). */
export const sharedKey = (day = new Date().toISOString().slice(0, 10)) => `career:cards:shared:${day}`;
export const visitsKey = (day = new Date().toISOString().slice(0, 10)) => `career:cards:visits:${day}`;
const COUNTER_TTL_S = 400 * 86_400;
const FORMATS: CardFormat[] = ['square', 'story', 'wide'];

/**
 * "Share my progress". `mode`:
 *  - "preview": the card as a PNG while they choose what to show (not counted as a share, nothing kept).
 *  - "share": the signed link (the card lives in the link itself), its image and a caption; counts one share.
 */
export const POST: APIRoute = async ({ request, clientAddress, site }) => {
  const redis = redisConfig();
  if (!redis) return json({ error: 'unavailable' }, 503);
  const check = await verifySigned(request, redis).catch(() => null);
  if (!check) return json({ error: 'unavailable' }, 503);
  if (!check.ok) return rejected(check);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(check.body);
  } catch {
    return json({ error: 'invalid' }, 400);
  }
  const card = cleanCard(body.card);
  const format = FORMATS.includes(body.format as CardFormat) ? (body.format as CardFormat) : 'square';
  const day = typeof body.day === 'string' ? body.day : '';
  if (!card || !plausibleDay(day) || (body.mode !== 'preview' && body.mode !== 'share')) return json({ error: 'invalid' }, 400);
  const ip = clientIp(request, () => clientAddress);
  const host = new URL(site ?? request.url).host;

  if (body.mode === 'preview') {
    const quota = await take(redis, check.deviceId, ip, day, 'previews');
    if (!quota.ok) return json({ error: 'limit', kind: 'previews' }, 429);
    const png = await cardPng(card, format, host);
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  }

  const quota = await take(redis, check.deviceId, ip, day, 'cards');
  if (!quota.ok) return json({ error: 'limit', kind: 'cards' }, 429);
  const token = await cardToken(card, cardSecret());
  await pipeline(redis, [['INCR', sharedKey()], ['EXPIRE', sharedKey(), COUNTER_TTL_S]]).catch(() => {});
  const url = new URL(`/career/card/${token}`, site ?? request.url).toString();
  return json({ token, url, image: `${url}.png?f=${format}`, caption: cardCaption(card, url) });
};
