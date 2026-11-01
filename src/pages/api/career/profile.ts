import Anthropic from '@anthropic-ai/sdk';
import type { APIRoute } from 'astro';
import { MODEL, SYSTEM, anthropic, cleanProfile, context, isoDay, json } from '../../../lib/career/ai.ts';
import { plausibleDay } from '../../../lib/career/limits.ts';
import { take } from '../../../lib/career/quota.ts';
import { breather, overBudget, recordSpend } from '../../../lib/career/spend.ts';
import { LIMITS_INPUT, PROFILE_JSON_SCHEMA, type Profile } from '../../../lib/career/types.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { clientIp, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

const MIN_TEXT = 150;

/** Résumé text → structured Profile. The text is processed and forgotten; nothing about it is stored server-side. */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const redis = redisConfig();
  if (!redis) return json({ error: 'unavailable' }, 503);
  const check = await verifySigned(request, redis).catch(() => null);
  if (!check) return json({ error: 'unavailable' }, 503);
  if (!check.ok) return rejected(check);

  let body: { text?: unknown; day?: unknown; today?: unknown };
  try {
    body = JSON.parse(check.body);
  } catch {
    return json({ error: 'invalid' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const day = typeof body.day === 'string' ? body.day : '';
  if (text.length < MIN_TEXT) return json({ error: 'too-short' }, 422);
  if (text.length > LIMITS_INPUT.resume) return json({ error: 'too-long' }, 413);
  if (!plausibleDay(day)) return json({ error: 'invalid' }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'unavailable' }, 503);
  if (await overBudget(redis)) return breather();

  const quota = await take(redis, check.deviceId, clientIp(request, () => clientAddress), day, 'uploads');
  if (!quota.ok) return json({ error: 'limit', scope: quota.scope }, 429);

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: context({ task: 'profile', resume: text, today: isoDay(body.today) }) }];
  try {
    // Structured output constrains the shape; zod re-checks it. One retry with the validation error, then give up.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await anthropic().messages.create(
        {
          model: MODEL,
          max_tokens: 4096,
          thinking: { type: 'disabled' },
          output_config: { effort: 'low', format: { type: 'json_schema', schema: PROFILE_JSON_SCHEMA } },
          system: SYSTEM,
          messages,
        },
        { timeout: 25_000, signal: request.signal },
      );
      recordSpend(redis, res.usage);
      if (res.stop_reason === 'refusal') break;
      const out = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
      let parsed: unknown;
      let problem = '';
      try {
        parsed = JSON.parse(out);
      } catch {
        problem = 'The reply was not valid JSON.';
      }
      const profile: Profile | null = parsed === undefined ? null : cleanProfile(parsed);
      if (profile) return json({ profile });
      problem ||= 'The JSON did not match the Profile shape (check types, lengths and allowed values).';
      messages.push({ role: 'assistant', content: out || '{}' }, { role: 'user', content: `${problem} Return the corrected Profile JSON only.` });
    }
    await quota.release();
    return json({ error: 'invalid-output' }, 502);
  } catch {
    await quota.release();
    return json({ error: 'upstream' }, 502);
  }
};
