import Anthropic from '@anthropic-ai/sdk';
import type { APIRoute } from 'astro';
import { GUIDE_MODEL, SYSTEM, anthropic, asData, cleanProfile, context, isoDay, json, noThinking, structured } from '../../../lib/career/ai.ts';
import { checkText } from '../../../lib/career/factcheck.ts';
import { plausibleDay } from '../../../lib/career/limits.ts';
import { take } from '../../../lib/career/quota.ts';
import { SONNET_RATES, breather, overBudget, recordSpend } from '../../../lib/career/spend.ts';
import { SSE_HEADERS, frame } from '../../../lib/career/stream.ts';
import { GUIDE_JSON_SCHEMA, GuideSchema, JobInputSchema, LIMITS_INPUT, type Guide } from '../../../lib/career/types.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { KEY } from '../../../lib/jobs/store.ts';
import { clientIp, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

/** Never used for research: job-review and job-board sites whose terms forbid automated collection. */
const BLOCKED = ['glassdoor.com', 'glassdoor.ca', 'glassdoor.co.uk', 'glassdoor.co.in', 'indeed.com', 'linkedin.com', 'ziprecruiter.com', 'monster.com', 'teamblind.com', 'comparably.com'];
const RESEARCH_TIMEOUT_MS = 90_000;
const WRITE_TIMEOUT_MS = 180_000;

type Source = { title: string; url: string };

/**
 * Public research on the company (its own site, blog, news): values, products, recent news, how it describes its
 * hiring. Sonnet with the web search tool; review sites are blocked. Returns short notes and the pages it cited.
 */
async function research(job: { title?: string; company?: string; description: string }, signal: AbortSignal, onUsage: (u: Anthropic.Usage) => void): Promise<{ notes: string; sources: Source[] }> {
  const content = `task = "prep_research"\n<job>\n${asData([job.title, job.company].filter(Boolean).join(' · '))}\n${asData(job.description.slice(0, 3000))}\n</job>`;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];
  const sources = new Map<string, Source>();
  let notes = '';
  for (let turn = 0; turn < 3; turn++) {
    const res = await anthropic().messages.create(
      {
        model: GUIDE_MODEL,
        max_tokens: 3000,
        thinking: noThinking(GUIDE_MODEL),
        system: SYSTEM,
        messages,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4, blocked_domains: BLOCKED }],
      },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(RESEARCH_TIMEOUT_MS)]) },
    );
    onUsage(res.usage);
    for (const block of res.content) {
      if (block.type !== 'text') continue;
      notes += block.text;
      for (const c of block.citations ?? []) if (c.type === 'web_search_result_location' && c.url) sources.set(c.url, { title: (c.title ?? c.url).slice(0, 200), url: c.url });
    }
    // A long server-side search loop pauses: send the turn back as-is and it resumes.
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  return { notes: notes.trim().slice(0, 6000), sources: [...sources.values()].slice(0, 10) };
}

/**
 * A detailed interview prep guide for one job, streamed (SSE): `progress` {text, chars?} while researching and
 * writing, then `result` {guide, flags} or `error`, then `done`. The visitor's own instructions decide its shape
 * ("a 3-day plan", "no behavioural questions"). 2 a day per device; Sonnet, so it costs more than other tools.
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
  const profile = cleanProfile(body.profile);
  const resume = typeof body.resume === 'string' ? body.resume.trim() : '';
  const day = typeof body.day === 'string' ? body.day : '';
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim().slice(0, 1000) : '';
  const jobIn = JobInputSchema.safeParse(body.job ?? {});
  if (!profile || resume.length < 150 || resume.length > LIMITS_INPUT.resume || !plausibleDay(day) || !jobIn.success) return json({ error: 'invalid' }, 400);

  let description = jobIn.data.description?.trim() ?? '';
  if (!description && jobIn.data.jobId) {
    const [stored] = await pipeline(redis, [['GET', KEY.description(jobIn.data.jobId)]]).catch(() => [null]);
    description = typeof stored === 'string' ? stored : '';
    if (!description) return json({ error: 'job-expired' }, 410);
  }
  if (description.length < 200) return json({ error: 'job-too-short' }, 422);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'unavailable' }, 503);
  if (await overBudget(redis)) return breather();

  const quota = await take(redis, check.deviceId, clientIp(request, () => clientAddress), day, 'guides');
  if (!quota.ok) return json({ error: 'limit', kind: 'guides' }, 429);
  const job = { title: jobIn.data.title, company: jobIn.data.company, description: description.slice(0, 12_000) };
  const onUsage = (u: Anthropic.Usage) => recordSpend(redis, u, SONNET_RATES);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(frame(event, data));
        } catch {}
      };
      try {
        send('progress', { text: `Researching ${job.company ?? 'the company'} on the public web…` });
        const found = await research(job, request.signal, onUsage).catch((err) => {
          console.error('[prep-guide] research failed:', (err as Error).message);
          return { notes: '', sources: [] as Source[] };
        });
        send('progress', { text: found.notes ? 'Writing your guide…' : "Couldn't reach the web just now: writing from the posting and your résumé…" });

        const ctx = context({ task: 'prep_guide', profile, resume, job, today: isoDay(body.today) });
        const extra = `${found.notes ? `\n<research>\n${asData(found.notes)}\n</research>` : ''}\n<instructions>${asData(instructions || 'none: use the default guide')}</instructions>`;
        let last = 0;
        const guide = await structured<Guide>(GUIDE_JSON_SCHEMA, GuideSchema, [{ role: 'user', content: `${ctx}${extra}` }], {
          label: 'prep_guide',
          model: GUIDE_MODEL,
          maxTokens: 14_000,
          timeoutMs: WRITE_TIMEOUT_MS,
          signal: request.signal,
          onUsage,
          onProgress: (chars) => {
            if (Date.now() - last < 1200) return;
            last = Date.now();
            send('progress', { text: 'Writing your guide…', chars });
          },
        });
        if (!guide) throw new Error('invalid-output');
        // The pages the research actually cited come first; the model's own list is kept only for real http(s) links.
        const seen = new Set<string>();
        guide.sources = [...found.sources, ...guide.sources.filter((s) => /^https?:\/\//.test(s.url))].filter((s) => !seen.has(s.url) && (seen.add(s.url), true)).slice(0, 12);
        const text = guide.sections.flatMap((s) => [s.intro ?? '', ...s.items.flatMap((i) => [i.title ?? '', i.text ?? '', ...i.bullets, i.why ?? '', ...i.answer])]).join('\n');
        const flags = checkText(text, profile, resume, [], [job.title ?? '', job.company ?? '', job.description, found.notes]);
        send('result', { guide, flags });
      } catch (err) {
        if (!request.signal.aborted) {
          console.error('[prep-guide] failed:', (err as Error).message);
          await quota.release().catch(() => {});
          send('error', { code: 'upstream' });
        }
      } finally {
        send('done', {});
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
};
