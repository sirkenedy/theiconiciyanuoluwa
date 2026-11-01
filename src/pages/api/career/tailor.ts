import type { APIRoute } from 'astro';
import { cleanProfile, context, isoDay, json, structured } from '../../../lib/career/ai.ts';
import { checkResume } from '../../../lib/career/factcheck.ts';
import { plausibleDay } from '../../../lib/career/limits.ts';
import { take } from '../../../lib/career/quota.ts';
import { breather, overBudget, recordSpend } from '../../../lib/career/spend.ts';
import { SSE_HEADERS, frame } from '../../../lib/career/stream.ts';
import { ANALYSIS_JSON_SCHEMA, AnalysisSchema, AnswersSchema, JobInputSchema, LIMITS_INPUT, WRITE_JSON_SCHEMA, WriteSchema } from '../../../lib/career/types.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { KEY } from '../../../lib/jobs/store.ts';
import { clientIp, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

const MIN_RESUME = 150;
const MIN_JOB = 200;

/**
 * Tailor a résumé to a job, or improve it against the target role (career-mode.md §3.4–3.5), in two steps:
 *  - phase "analyze": match bullets + up to 3 quick questions (JSON; counts as a message)
 *  - phase "write": the tailored résumé, change log and keyword coverage (SSE progress, then the result; counts as one
 *    of today's tailored résumés), checked in code for anything not in the visitor's own résumé or answers.
 * A found job's description comes from Redis (stored at ingest); a pasted one comes in the request. No URL fetching.
 */
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
  const mode = body.mode === 'improve' ? 'improve' : 'tailor';
  const phase = body.phase === 'write' ? 'write' : 'analyze';
  const profile = cleanProfile(body.profile);
  const resume = typeof body.resume === 'string' ? body.resume.trim() : '';
  const day = typeof body.day === 'string' ? body.day : '';
  const answers = AnswersSchema.safeParse(body.answers ?? []);
  const jobIn = JobInputSchema.safeParse(body.job ?? {});
  if (!profile || resume.length < MIN_RESUME || resume.length > LIMITS_INPUT.resume || !plausibleDay(day) || !answers.success || !jobIn.success) {
    return json({ error: 'invalid' }, 400);
  }

  let job: { title?: string; company?: string; description: string } | null = null;
  if (mode === 'tailor') {
    let description = jobIn.data.description?.trim() ?? '';
    if (!description && jobIn.data.jobId) {
      const [stored] = await pipeline(redis, [['GET', KEY.description(jobIn.data.jobId)]]);
      description = typeof stored === 'string' ? stored : '';
      if (!description) return json({ error: 'job-expired' }, 410);
    }
    if (description.length < MIN_JOB) return json({ error: 'job-too-short' }, 422);
    job = { title: jobIn.data.title, company: jobIn.data.company, description };
  }
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'unavailable' }, 503);
  if (await overBudget(redis)) return breather();
  const onUsage = (u: Parameters<typeof recordSpend>[1]) => recordSpend(redis, u);

  const ip = clientIp(request, () => clientAddress);
  const ctxTask = `${mode}_${phase}`;
  const ctx = context({ task: ctxTask, profile, resume, job, answers: answers.data, today: isoDay(body.today) });

  if (phase === 'analyze') {
    const quota = await take(redis, check.deviceId, ip, day, 'messages');
    if (!quota.ok) return json({ error: 'limit', kind: 'messages' }, 429);
    const analysis = await structured(ANALYSIS_JSON_SCHEMA, AnalysisSchema, [{ role: 'user', content: ctx }], { label: ctxTask, maxTokens: 1500, signal: request.signal, onUsage }).catch((err) => {
      logFailure(ctxTask, err, request.signal);
      return null;
    });
    if (!analysis) {
      await quota.release();
      return json({ error: 'upstream' }, 502);
    }
    return json({ analysis });
  }

  const quota = await take(redis, check.deviceId, ip, day, 'tailored');
  if (!quota.ok) return json({ error: 'limit', kind: 'tailored' }, 429);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(frame(event, data));
      let last = 0;
      try {
        const result = await structured(WRITE_JSON_SCHEMA, WriteSchema, [{ role: 'user', content: ctx }], {
          label: ctxTask,
          maxTokens: 8000,
          signal: request.signal,
          timeoutMs: 55_000,
          onUsage,
          // Progress pings keep the connection alive and let the orb show work happening.
          onProgress: (chars) => {
            if (Date.now() - last < 1200) return;
            last = Date.now();
            send('progress', { chars });
          },
        });
        if (!result) throw new Error('invalid-output');
        if (mode === 'tailor') result.critique = [];
        const allowed = [job?.title, job?.company].filter((s): s is string => !!s);
        const flags = checkResume(result.tailored, profile, resume, answers.data, allowed);
        send('result', { result, flags });
        send('done', {});
      } catch (err) {
        logFailure(ctxTask, err, request.signal);
        if (!request.signal.aborted) {
          await quota.release().catch(() => {});
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

/** Why a call failed, without content: the error class and HTTP status (an Anthropic APIError), or a client abort. */
function logFailure(task: string, err: unknown, signal: AbortSignal) {
  if (signal.aborted) return;
  const e = err as { name?: string; status?: number };
  console.error(`[career] ${task}: ${e?.name ?? 'Error'}${e?.status ? ` ${e.status}` : ''}`);
}
