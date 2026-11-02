import type Anthropic from '@anthropic-ai/sdk';
import type { APIRoute } from 'astro';
import { asData, cleanProfile, context, isoDay, json, structured } from '../../../lib/career/ai.ts';
import { cleanCard } from '../../../lib/career/card.ts';
import { plausibleDay } from '../../../lib/career/limits.ts';
import { take } from '../../../lib/career/quota.ts';
import { breather, overBudget, recordSpend } from '../../../lib/career/spend.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { clientIp, redisConfig } from '../../../lib/redis.ts';
import { z } from 'zod';

export const prerender = false;

/** Styles to keep each story fresh ("Another one" moves to the next). */
export const STORY_STYLES = [
  'an open letter to a company they are talking to (or to recruiters)',
  'live sports commentary',
  'a movie trailer voice-over',
  'a breaking news headline and one line of report',
  'a weather forecast',
  'a nature documentary narrator',
  'a confident LinkedIn humble-brag that knows it is one',
] as const;

const StorySchema = z.object({ story: z.string().transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, 280)) });
const STORY_JSON = { type: 'object', properties: { story: { type: 'string' } }, required: ['story'], additionalProperties: false };

/** Every number in the story must be one on the card: a fun story, never an invented result. */
export function storyNumbersOk(story: string, card: NonNullable<ReturnType<typeof cleanCard>>) {
  const allowed = new Set(
    [card.applied, card.interviews, card.offers, card.practice, card.found, card.docs, ...(card.score ?? []), ...(card.goal ?? [])].filter((n): n is number => n !== null).map(String),
  );
  return (story.match(/\d+(?:\.\d+)?/g) ?? []).every((n) => allowed.has(n));
}

/** A short, fun story for a progress card, from what they chose to show (and their field). Haiku; a few a day. */
export const POST: APIRoute = async ({ request, clientAddress }) => {
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
  const card = cleanCard({ ...(body.card as object), story: null });
  const profile = cleanProfile(body.profile);
  const day = typeof body.day === 'string' ? body.day : '';
  const style = STORY_STYLES[Math.abs(Number(body.style) || 0) % STORY_STYLES.length];
  if (!card || !profile || !plausibleDay(day)) return json({ error: 'invalid' }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'unavailable' }, 503);
  if (await overBudget(redis)) return breather();
  const quota = await take(redis, check.deviceId, clientIp(request, () => clientAddress), day, 'stories');
  if (!quota.ok) return json({ error: 'limit', kind: 'stories' }, 429);

  // Their field, not their history: role, seniority, skills (no employers, no contact details).
  const field = { headline: profile.identity.headline, targetRoles: profile.targetRoles, seniority: profile.seniority, skills: profile.skills.flatMap((g) => g.items).slice(0, 8) };
  const prompt = `${context({ task: 'card_story', profile: null, today: isoDay(body.today) }).replace('<profile>none yet</profile>', `<profile>${asData(JSON.stringify(field))}</profile>`)}\n<card>${asData(JSON.stringify(card))}</card>\n<style>${style}</style>`;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await structured<z.infer<typeof StorySchema>>(STORY_JSON, StorySchema, messages, { label: 'card_story', maxTokens: 300, timeoutMs: 20_000, signal: request.signal, onUsage: (u) => recordSpend(redis, u) }).catch(() => null);
    if (out?.story && storyNumbersOk(out.story, card)) return json({ story: out.story, style });
    if (out?.story) messages.push({ role: 'assistant', content: JSON.stringify(out) }, { role: 'user', content: 'That story uses a number that is not on the card. Use only the card\'s numbers (or none). Return the corrected JSON only.' });
  }
  await quota.release().catch(() => {});
  return json({ error: 'upstream' }, 502);
};
