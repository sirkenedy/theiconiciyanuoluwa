import Anthropic from '@anthropic-ai/sdk';
import type { APIRoute } from 'astro';
import { MODEL, SYSTEM, anthropic, asData, cleanProfile, cleanTurns, context, isoDay, json } from '../../../lib/career/ai.ts';
import { plausibleDay } from '../../../lib/career/limits.ts';
import { take } from '../../../lib/career/quota.ts';
import { breather, overBudget, recordSpend } from '../../../lib/career/spend.ts';
import { SSE_HEADERS, TagSplitter, frame, parseSuggest } from '../../../lib/career/stream.ts';
import { CHAT_TOOLS, ChatJobsSchema, JobInputSchema, LIMITS_INPUT, RecentJobsSchema, ToolCallSchema } from '../../../lib/career/types.ts';
import { KEY } from '../../../lib/jobs/store.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { clientIp, pipeline, redisConfig } from '../../../lib/redis.ts';

export const prerender = false;

const TIMEOUT_MS = 25_000;

/**
 * Coaching chat (task = "chat", streamed) and the rolling summary (task = "summarize", JSON). The client sends a compact
 * context every turn: the confirmed profile, a rolling summary of older turns and only the last 6 messages.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const redis = redisConfig();
  if (!redis) return json({ error: 'unavailable' }, 503);
  const check = await verifySigned(request, redis).catch(() => null);
  if (!check) return json({ error: 'unavailable' }, 503);
  if (!check.ok) return rejected(check);

  let body: { task?: unknown; messages?: unknown; profile?: unknown; jobs?: unknown; recent?: unknown; job?: unknown; summary?: unknown; day?: unknown; today?: unknown; want?: unknown };
  try {
    body = JSON.parse(check.body);
  } catch {
    return json({ error: 'invalid' }, 400);
  }
  const task = body.task === 'summarize' ? 'summarize' : 'chat';
  const day = typeof body.day === 'string' ? body.day : '';
  const summary = typeof body.summary === 'string' ? body.summary.slice(0, LIMITS_INPUT.summary) : '';
  const profile = body.profile == null ? null : cleanProfile(body.profile);
  // The cards on screen (≤ 10, compact), so the coach can talk about them without any server-side state.
  const jobs = body.jobs == null ? [] : ChatJobsSchema.safeParse(body.jobs).data;
  // Every job shown on this device in the last 7 days (newest first, with "Open job" clicks), kept on the device.
  const recent = body.recent == null ? [] : RecentJobsSchema.safeParse(body.recent).data;
  const turns = cleanTurns(body.messages, task === 'chat' ? LIMITS_INPUT.turns : LIMITS_INPUT.summarize, {
    userMax: LIMITS_INPUT.message,
    assistantMax: LIMITS_INPUT.answer,
  });
  if (!turns || !plausibleDay(day) || (body.profile != null && !profile) || !jobs || !recent) return json({ error: 'invalid' }, 400);
  if (task === 'chat' && turns.at(-1)!.role !== 'user') return json({ error: 'invalid' }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'unavailable' }, 503);
  if (await overBudget(redis)) return breather();

  const quota = await take(redis, check.deviceId, clientIp(request, () => clientAddress), day, task === 'chat' ? 'messages' : 'summaries');
  if (!quota.ok) return json({ error: 'limit', scope: quota.scope }, 429);

  // The job this conversation is about: a found job's description comes from Redis, a pasted one from the request.
  const jobIn = body.job == null ? null : JobInputSchema.safeParse(body.job);
  if (jobIn && !jobIn.success) return json({ error: 'invalid' }, 400);
  let job: { title?: string; company?: string; description: string } | null = null;
  if (jobIn?.success) {
    let description = jobIn.data.description ?? '';
    if (!description && jobIn.data.jobId) {
      const [stored] = await pipeline(redis, [['GET', KEY.description(jobIn.data.jobId)]]).catch(() => [null]);
      description = typeof stored === 'string' ? stored : '';
    }
    job = { title: jobIn.data.title, company: jobIn.data.company, description: description.slice(0, 6000) };
  }
  const ctx = context({ task, profile, job, jobs, recent: task === 'chat' ? recent : [], summary, today: isoDay(body.today) });

  if (task === 'summarize') {
    const transcript = turns.map((t) => `${t.role === 'user' ? 'Visitor' : 'Coach'}: ${t.content}`).join('\n\n');
    try {
      const res = await anthropic().messages.create(
        {
          model: MODEL,
          max_tokens: 600,
          thinking: { type: 'disabled' },
          output_config: { effort: 'low' },
          system: SYSTEM,
          messages: [{ role: 'user', content: `${ctx}\n\n<transcript>\n${asData(transcript)}\n</transcript>` }],
        },
        { timeout: TIMEOUT_MS, signal: request.signal },
      );
      recordSpend(redis, res.usage);
      const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text.trim() ?? '';
      if (!text || res.stop_reason === 'refusal') throw new Error('empty');
      return json({ summary: text.slice(0, LIMITS_INPUT.summary) });
    } catch {
      await quota.release();
      return json({ error: 'upstream' }, 502);
    }
  }

  // The whole chat goes every time (each request is stateless). Back-to-back turns from one side are merged; the context
  // that changes per message (today, recent jobs…) rides on the newest message, so everything before it is identical to
  // the last request and is read from the prompt cache (cache_control on the turn before the newest).
  const merged = turns.reduce<{ role: 'user' | 'assistant'; content: string }[]>((out, t) => {
    const prev = out.at(-1);
    if (prev?.role === t.role) prev.content += `\n\n${t.content}`;
    else out.push({ role: t.role, content: t.content });
    return out;
  }, []);
  const last = merged.length - 1;
  const messages: Anthropic.MessageParam[] = merged.map((t, i) => ({
    role: t.role,
    content: i === last ? `${ctx}\n\n${t.content}` : i === last - 1 ? [{ type: 'text', text: t.content, cache_control: { type: 'ephemeral' } }] : t.content,
  }));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(frame(event, data));
      const splitter = new TagSplitter('<suggest>');
      try {
        const response = anthropic().messages.stream(
          // Ami reads the whole message and either answers or picks a tool; the browser runs the tool's flow.
          // `want: "document"`: the visitor clearly asked for a résumé or letter (now, or earlier and still not made), so Ami
          // must start it (she still judges the job and the kind) instead of answering in chat.
          {
            model: MODEL,
            max_tokens: 1500,
            thinking: { type: 'disabled' },
            output_config: { effort: 'low' },
            system: SYSTEM,
            messages,
            tools: CHAT_TOOLS as unknown as Anthropic.Tool[],
            ...(body.want === 'document' ? { tool_choice: { type: 'tool' as const, name: 'make_document' } } : {}),
          },
          { signal: AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]) },
        );
        for await (const event of response) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const t = splitter.push(event.delta.text);
            if (t) send('token', { t });
          }
        }
        const final = await response.finalMessage();
        recordSpend(redis, final.usage);
        const { tail, hidden } = splitter.end();
        if (tail) send('token', { t: tail });
        const use = final.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        const tool = use ? ToolCallSchema.safeParse({ name: use.name, input: use.input }) : null;
        if (tool?.success) {
          // A tool, not an answer: the message isn't spent (the tool has its own daily limit).
          if (!splitter.visible.trim()) await quota.release().catch(() => {});
          send('tool', tool.data);
          send('done', {});
          return;
        }
        if (use && !splitter.visible.trim()) send('token', { t: "Sorry, I didn't catch that. Could you say it another way?" });
        if (final.stop_reason === 'refusal' && !splitter.visible.trim()) {
          send('token', { t: "That's outside what I can help with here. Ask me about your résumé, your job search or your next career move." });
        }
        send('suggest', { items: final.stop_reason === 'refusal' ? [] : parseSuggest(hidden) });
        send('done', {});
      } catch {
        if (!request.signal.aborted) {
          // Nothing reached the visitor: give the message back.
          if (!splitter.visible) await quota.release().catch(() => {});
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
