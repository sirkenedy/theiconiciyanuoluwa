import type { APIRoute } from 'astro';
import { MODEL, SYSTEM, anthropic, cleanProfile, context, isoDay, json } from '../../../lib/career/ai.ts';
import { checkText } from '../../../lib/career/factcheck.ts';
import { plausibleDay } from '../../../lib/career/limits.ts';
import { take } from '../../../lib/career/quota.ts';
import { breather, overBudget, recordSpend } from '../../../lib/career/spend.ts';
import { SSE_HEADERS, frame } from '../../../lib/career/stream.ts';
import { AnswersSchema, JobInputSchema, LIMITS_INPUT } from '../../../lib/career/types.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { KEY } from '../../../lib/jobs/store.ts';
import { clientIp, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

/** A ≤ 300-word cover letter for a found or pasted job, streamed; then the same no-fabrication check as résumés. */
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
  const profile = cleanProfile(body.profile);
  const resume = typeof body.resume === 'string' ? body.resume.trim() : '';
  const day = typeof body.day === 'string' ? body.day : '';
  const answers = AnswersSchema.safeParse(body.answers ?? []);
  const jobIn = JobInputSchema.safeParse(body.job ?? {});
  if (!profile || resume.length < 150 || resume.length > LIMITS_INPUT.resume || !plausibleDay(day) || !answers.success || !jobIn.success) return json({ error: 'invalid' }, 400);

  let description = jobIn.data.description?.trim() ?? '';
  if (!description && jobIn.data.jobId) {
    const [stored] = await pipeline(redis, [['GET', KEY.description(jobIn.data.jobId)]]);
    description = typeof stored === 'string' ? stored : '';
    if (!description) return json({ error: 'job-expired' }, 410);
  }
  if (description.length < 200) return json({ error: 'job-too-short' }, 422);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'unavailable' }, 503);
  if (await overBudget(redis)) return breather();

  const quota = await take(redis, check.deviceId, clientIp(request, () => clientAddress), day, 'letters');
  if (!quota.ok) return json({ error: 'limit', kind: 'letters' }, 429);
  const job = { title: jobIn.data.title, company: jobIn.data.company, description };
  const ctx = context({ task: 'cover_letter', profile, resume, job, answers: answers.data, today: isoDay(body.today) });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(frame(event, data));
      let text = '';
      try {
        const response = anthropic().messages.stream(
          { model: MODEL, max_tokens: 1200, thinking: { type: 'disabled' }, output_config: { effort: 'low' }, system: SYSTEM, messages: [{ role: 'user', content: ctx }] },
          { signal: AbortSignal.any([request.signal, AbortSignal.timeout(40_000)]) },
        );
        for await (const event of response) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const t = event.delta.text.replace(/<\/?letter>/g, '');
            text += t;
            if (t) send('token', { t });
          }
        }
        const final = await response.finalMessage();
        recordSpend(redis, final.usage);
        if (final.stop_reason === 'refusal' || !text.trim()) throw new Error('empty');
        // A letter opens with a greeting. Anything else is the model talking to the visitor ("tell me if you're
        // eligible…"): show it as a message, don't save it as a document, and don't count it as today's letter.
        if (!/^\s*(dear|hello|hi|hey|greetings|to (the )?(hiring|whom|recruit))/i.test(text)) {
          await quota.release().catch(() => {});
          send('message', { text: text.trim() });
          send('done', {});
          return;
        }
        // A letter may name the employer, its product and team: anything that appears in the job description itself.
        const allowed = [job.title, job.company, job.description].filter((s): s is string => !!s);
        send('flags', { flags: checkText(text, profile, resume, answers.data, allowed) });
        send('done', {});
      } catch {
        if (!request.signal.aborted) {
          if (!text) await quota.release().catch(() => {});
          send('error', { code: 'upstream' });
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
};
