import type Anthropic from '@anthropic-ai/sdk';
import type { APIRoute } from 'astro';
import { GUIDE_MODEL, MODEL, SYSTEM, anthropic, asData, cleanProfile, context, isoDay, json, noThinking, structured } from '../../../lib/career/ai.ts';
import { checkText } from '../../../lib/career/factcheck.ts';
import { plausibleDay } from '../../../lib/career/limits.ts';
import { take } from '../../../lib/career/quota.ts';
import { SONNET_RATES, breather, overBudget, recordSpend } from '../../../lib/career/spend.ts';
import { SSE_HEADERS, frame } from '../../../lib/career/stream.ts';
import {
  FEEDBACK_JSON_SCHEMA,
  FeedbackSchema,
  InterviewSetupSchema,
  InterviewTurnSchema,
  JobInputSchema,
  LIMITS_INPUT,
  TranscriptSchema,
  interviewTurnJsonSchema,
  type Feedback,
  type Guide,
  type InterviewSetup,
  type InterviewTurn,
  type IvAction,
  type Transcript,
} from '../../../lib/career/types.ts';
import { rejected, verifySigned } from '../../../lib/career/verify.ts';
import { KEY } from '../../../lib/jobs/store.ts';
import { clientIp, pipeline, redisConfig, type Redis } from '../../../lib/redis.ts';

export const prerender = false;

/** Model calls one session may make (start + every turn); a long interview needs about 8 × 3 + 2. */
export const MAX_TURNS = 30;
const SESSION_TTL_S = 3 * 3600;
const MAX_FOLLOW_UPS = 2;
const sessionKey = (deviceId: string, sid: string) => `career:iv:${deviceId}:${sid}`;

/** Where the interview stands, counted from the transcript the client sends (the server keeps no transcript). */
export function progress(t: Transcript, setup: InterviewSetup) {
  let asked = 0;
  let followUps = 0;
  for (const e of t) {
    if (e.who !== 'ami') continue;
    if (e.kind === 'ask') {
      asked++;
      followUps = 0;
    } else if (e.kind === 'follow_up') followUps++;
  }
  const ended = t.some((e) => e.who === 'ami' && e.kind === 'end');
  const allowed: IvAction[] = [];
  if (!t.length) allowed.push('ask');
  else if (!ended) {
    if (asked < setup.questions) allowed.push('ask');
    if (followUps < MAX_FOLLOW_UPS && asked > 0) allowed.push('follow_up');
    allowed.push('reply');
    if (asked >= setup.questions || asked >= 2) allowed.push('end');
  }
  return { asked, followUps, ended, allowed };
}

const spokenLine = (v: NonNullable<Extract<Transcript[number], { who: 'you' }>['voice']>) =>
  `${v.seconds} s, ${v.wpm} words a minute, ${v.fillers} filler word${v.fillers === 1 ? '' : 's'}, ${v.longPauses} long pause${v.longPauses === 1 ? '' : 's'}`;
/**
 * The `say` string so far, read from JSON that is still being written ({"say":"Thanks. Now tell me…), so Ami can start
 * talking before the rest of her turn (action, note, the cleaned transcript) is done.
 */
export function partialSay(raw: string): string {
  const m = /"say"\s*:\s*"/.exec(raw);
  if (!m) return '';
  let out = '';
  for (let i = m.index + m[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[i + 1];
    if (n === undefined) return out; // an escape cut in half: wait for the rest
    if (n === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += ({ n: '\n', t: '\t', r: '', b: '', f: '' } as Record<string, string>)[n] ?? n;
      i += 1;
    }
  }
  return out;
}

/**
 * A corrected speech transcript is kept only if it is still their answer: nearly all of its words were in what was
 * heard, and it is about as long. Recognition slips get fixed; nothing gets added.
 */
export function sameAnswer(heard: string, fixed: string) {
  const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  const a = words(heard);
  const b = words(fixed);
  if (!a.length || !b.length || b.length > a.length * 1.25 + 4 || b.length < a.length * 0.6) return false;
  const pool = new Set(a);
  return b.filter((w) => pool.has(w)).length / b.length >= 0.7;
}

const transcriptText = (t: Transcript) =>
  t
    .map((e) => (e.who === 'ami' ? `Ami (${e.kind}): ${e.text}` : `Candidate: ${e.text}${e.voice ? `\n  [spoken: ${spokenLine(e.voice)}]` : ''}${e.note ? `\n  [your private note: ${e.note}]` : ''}`))
    .join('\n');

async function resolveJob(redis: Redis, job: { jobId?: string; title?: string; company?: string; description?: string }) {
  let description = job.description?.trim() ?? '';
  if (!description && job.jobId) {
    const [stored] = await pipeline(redis, [['GET', KEY.description(job.jobId)]]).catch(() => [null]);
    description = typeof stored === 'string' ? stored : '';
  }
  return { title: job.title, company: job.company, description: description.slice(0, 12_000) };
}

/** The scorecard as a guide document: the preview, PDF and print reuse the prep-guide renderer. */
export function scorecardGuide(f: Feedback, t: Transcript, job: { title?: string; company?: string }): Guide {
  const READY = { ready: 'Ready', almost: 'Almost ready', not_yet: 'Not ready yet' } as const;
  // Each main question's answers (the first answer plus answers to its follow-ups), for honest length notes; spoken
  // answers add how they sounded (measured on their device).
  const words: number[] = [];
  const spoken: { seconds: number; words: number; fillers: number; longPauses: number }[] = [];
  for (const e of t) {
    if (e.who === 'ami' && e.kind === 'ask') {
      words.push(0);
      spoken.push({ seconds: 0, words: 0, fillers: 0, longPauses: 0 });
    } else if (e.who === 'you' && words.length && e.text !== '(skipped)') {
      words[words.length - 1] += e.text.split(/\s+/).filter(Boolean).length;
      const v = e.voice;
      if (v) for (const k of ['seconds', 'words', 'fillers', 'longPauses'] as const) spoken[spoken.length - 1][k] += v[k];
    }
  }
  const pace = (s: { seconds: number; words: number }) => (s.seconds > 3 ? Math.round(s.words / (s.seconds / 60)) : 0);
  const say = (s: { seconds: number; words: number; fillers: number; longPauses: number }) =>
    [`${s.seconds} s`, pace(s) ? `${pace(s)} words a minute` : '', `${s.fillers} filler word${s.fillers === 1 ? '' : 's'}`, s.longPauses ? `${s.longPauses} long pause${s.longPauses === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  const talked = spoken.filter((s) => s.seconds > 0);
  const total = talked.reduce((a, s) => ({ seconds: a.seconds + s.seconds, words: a.words + s.words, fillers: a.fillers + s.fillers, longPauses: a.longPauses + s.longPauses }), { seconds: 0, words: 0, fillers: 0, longPauses: 0 });
  const sounded = talked.length
    ? [
        `Pace: ${pace(total)} words a minute (about 120–160 is easy to follow)`,
        `Average answer: ${Math.round(total.seconds / talked.length)} seconds (1–2 minutes suits most questions)`,
        `Filler words heard: ${total.fillers} (speech recognition misses some, so this is a minimum)`,
        `Long pauses (3 s or more): ${total.longPauses}`,
      ]
    : [];
  return {
    title: 'Interview scorecard',
    subtitle: [job.title, job.company].filter(Boolean).join(' · ') || 'Mock interview',
    note: 'Feedback from a practice interview with Ami. Scores are a guide to what to work on, not a prediction of the real result.',
    sections: [
      {
        heading: `Overall: ${f.score}/5 · ${READY[f.readiness]}`,
        intro: f.summary,
        items: [
          ...(f.strengths.length ? [{ kind: 'bullets' as const, title: 'What went well', text: null, bullets: f.strengths, why: null, answer: [] }] : []),
          ...(f.fixes.length ? [{ kind: 'bullets' as const, title: 'What to fix', text: null, bullets: f.fixes, why: null, answer: [] }] : []),
          ...(f.practise.length ? [{ kind: 'bullets' as const, title: 'Practise next', text: null, bullets: f.practise, why: null, answer: [] }] : []),
          ...(sounded.length ? [{ kind: 'bullets' as const, title: 'How you sounded', text: null, bullets: sounded, why: null, answer: [] }] : []),
        ],
      },
      {
        heading: 'Question by question',
        intro: null,
        items: f.questions.map((q, i) => ({
          kind: 'question' as const,
          title: `${q.question} (${q.score}/5)`,
          text: null,
          bullets: [
            ...q.strong.map((s) => `Strong: ${s}`),
            ...q.missing.map((m) => `Missing: ${m}`),
            ...(q.followups ? [`Follow-ups: ${q.followups}`] : []),
            ...(words[i] ? [`Answer length: ${words[i]} words`] : []),
            ...(spoken[i]?.seconds ? [`Delivery: ${say(spoken[i])}`] : []),
          ],
          why: null,
          answer: q.better,
        })),
      },
      {
        heading: 'Transcript',
        intro: null,
        items: t.slice(0, 40).map((e) => ({ kind: 'text' as const, title: e.who === 'ami' ? 'Ami' : 'You', text: e.text.slice(0, 2500), bullets: [], why: null, answer: [] })),
      },
    ],
    sources: [],
  };
}

/**
 * Mock interviews. `phase`:
 *  - "start": takes one of today's interviews, opens a session (a turn counter, nothing else) and asks the first question.
 *  - "turn": the whole transcript in, Ami's next line out (follow up, next question, reply, or close), as JSON.
 *  - "feedback": once per session, the scorecard (Sonnet), streamed like the prep guide.
 * The transcript lives on the device; every turn sends all of it, so Ami never loses context.
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
  const phase = body.phase;
  const profile = cleanProfile(body.profile);
  const resume = typeof body.resume === 'string' ? body.resume.trim() : '';
  const day = typeof body.day === 'string' ? body.day : '';
  const setup = InterviewSetupSchema.safeParse(body.setup);
  const transcript = TranscriptSchema.safeParse(body.transcript ?? []);
  const jobIn = JobInputSchema.safeParse(body.job ?? {});
  const sid = typeof body.sid === 'string' && /^[a-z0-9]{16,40}$/.test(body.sid) ? body.sid : null;
  if ((phase !== 'start' && phase !== 'turn' && phase !== 'feedback') || !profile || resume.length < 150 || resume.length > LIMITS_INPUT.resume || !plausibleDay(day) || !setup.success || !transcript.success || !jobIn.success) {
    return json({ error: 'invalid' }, 400);
  }
  if (phase !== 'start' && !sid) return json({ error: 'invalid' }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'unavailable' }, 503);
  if (await overBudget(redis)) return breather();

  // The job is read once, at the start, and kept with the session: later requests stay small (signed bodies ≤ 64 KB).
  type Job = { title?: string; company?: string; description: string };
  let job: Job;
  const key = phase === 'start' ? '' : sessionKey(check.deviceId, sid!);
  let turns = 0;
  let feedbackFirst = 0;
  if (phase === 'start') {
    job = await resolveJob(redis, jobIn.data);
    if (!job.description) return json({ error: 'job-expired' }, 410);
    if (job.description.length < 200) return json({ error: 'job-too-short' }, 422);
  } else {
    const out = await pipeline(redis, phase === 'turn' ? [['HINCRBY', key, 'turns', 1], ['HGET', key, 'job']] : [['HGET', key, 'job'], ['HSETNX', key, 'feedback', '1']]);
    const saved = (phase === 'turn' ? out[1] : out[0]) as string | null;
    if (phase === 'turn') turns = Number(out[0]);
    else feedbackFirst = Number(out[1]);
    if (!saved) {
      await pipeline(redis, [['DEL', key]]).catch(() => {});
      return json({ error: 'session-expired' }, 410);
    }
    job = JSON.parse(saved) as Job;
  }
  const t = transcript.data;
  const ctx = context({ task: phase === 'feedback' ? 'interview_feedback' : 'mock_interview', profile, resume, job, today: isoDay(body.today) });
  const setupText = `<setup>${asData(JSON.stringify({ questions: setup.data.questions, style: setup.data.style, instructions: setup.data.instructions || 'none' }))}</setup>`;

  if (phase === 'feedback') {
    if (!feedbackFirst) return json({ error: 'feedback-done' }, 409);
    if (!t.some((e) => e.who === 'you' && e.text !== '(skipped)')) {
      await pipeline(redis, [['HDEL', key, 'feedback']]).catch(() => {});
      return json({ error: 'no-answers' }, 422);
    }
    const onUsage = (u: Anthropic.Usage) => recordSpend(redis, u, SONNET_RATES);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(frame(event, data));
          } catch {}
        };
        try {
          send('progress', { text: 'Scoring your answers…' });
          let last = 0;
          const feedback = await structured<Feedback>(
            FEEDBACK_JSON_SCHEMA,
            FeedbackSchema,
            [{ role: 'user', content: `${ctx}\n${setupText}\n<interview>\n${asData(transcriptText(t))}\n</interview>` }],
            {
              label: 'interview_feedback',
              model: GUIDE_MODEL,
              maxTokens: 8000,
              timeoutMs: 120_000,
              signal: request.signal,
              onUsage,
              onProgress: (chars) => {
                if (Date.now() - last < 1200) return;
                last = Date.now();
                send('progress', { text: 'Writing your scorecard…', chars });
              },
            },
          );
          if (!feedback) throw new Error('invalid-output');
          const guide = scorecardGuide(feedback, t, job);
          // The stronger answers must use only their real experience: the résumé, the profile and what they said here.
          const said = t.filter((e) => e.who === 'you').map((e) => e.text);
          const text = feedback.questions.flatMap((q) => [...q.better, ...q.strong]).join('\n');
          const flags = checkText(text, profile, resume, [], [job.title ?? '', job.company ?? '', job.description, ...said]);
          send('result', { feedback, guide, flags });
        } catch (err) {
          if (!request.signal.aborted) {
            console.error('[interview] feedback failed:', (err as Error).message);
            await pipeline(redis, [['HDEL', key, 'feedback']]).catch(() => {});
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
  }

  // start / turn
  let session = sid;
  let release: (() => Promise<void>) | null = null;
  if (phase === 'start') {
    if (t.length) return json({ error: 'invalid' }, 400);
    const quota = await take(redis, check.deviceId, clientIp(request, () => clientAddress), day, 'interviews');
    if (!quota.ok) return json({ error: 'limit', kind: 'interviews' }, 429);
    session = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
    await pipeline(redis, [['HSET', sessionKey(check.deviceId, session), 'turns', 1, 'job', JSON.stringify(job)], ['EXPIRE', sessionKey(check.deviceId, session), SESSION_TTL_S]]);
    release = quota.release;
  } else {
    if (turns > MAX_TURNS) return json({ error: 'limit', kind: 'turns' }, 429);
    release = async () => void (await pipeline(redis, [['HINCRBY', key, 'turns', -1]]));
    if (t.at(-1)?.who !== 'you') return json({ error: 'invalid' }, 400);
  }

  const state = progress(t, setup.data);
  const last = t.at(-1);
  if (!state.allowed.length) return json({ error: 'ended' }, 409);
  const status = [
    `Main questions asked: ${state.asked} of ${setup.data.questions}.`,
    `Follow-ups on the current question: ${state.followUps} of ${MAX_FOLLOW_UPS} at most.`,
    `Allowed now: ${state.allowed.join(', ')}.`,
    !t.length ? 'This is the opening: greet them and ask the first main question.' : '',
    typeof body.acked === 'string' && body.acked ? `You already acknowledged their answer out loud ("${asData(body.acked.slice(0, 60))}"): don't open with another thank-you; go straight on.` : '',
    last?.who === 'you' && last.voice ? 'Their latest answer was spoken and turned into text on their device: return `heard`, the transcript with recognition slips fixed.' : 'Their latest answer was typed (or there is none): `heard` is null.',
    !state.allowed.includes('ask') && state.allowed.includes('end')
      ? t.some((e) => e.who === 'ami' && e.kind === 'reply' && /questions? for me/i.test(e.text))
        ? 'All main questions are done and you have asked if they have questions: answer any they ask (reply), then close (end).'
        : 'All main questions are done: unless you are following up, ask whether they have any questions for you (reply).'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  // The résumé, the job and the setup are the same every turn: cached, so a long interview stays cheap.
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: `${ctx}\n${setupText}`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `<interview>\n${t.length ? asData(transcriptText(t)) : '(not started)'}\n</interview>\n<status>\n${status}\n</status>` },
      ],
    },
  ];
  const schema = interviewTurnJsonSchema(state.allowed);
  const onUsage = (u: Anthropic.Usage) => recordSpend(redis, u);
  const finish = (turn: InterviewTurn) => {
    // Only a spoken answer can be corrected, and only if the correction is still their answer.
    const spokenLast = last?.who === 'you' && !!last.voice;
    const heard = spokenLast && turn.heard?.trim() && sameAnswer(last.text, turn.heard) ? turn.heard.trim() : null;
    // Whether a spoken answer was corrected (never its words): for diagnosing transcripts without logging anyone's answer.
    if (spokenLast) console.info(`[interview] heard: ${!turn.heard?.trim() ? 'none returned' : !heard ? 'rejected by the guard' : heard === last.text.trim() ? 'unchanged' : 'corrected'}`);
    return { ...turn, react: turn.react ?? 'neutral', note: t.length ? turn.note : null, heard };
  };
  const fail = async () => {
    await release?.().catch(() => {});
    if (phase === 'start') await pipeline(redis, [['DEL', sessionKey(check.deviceId, session!)]]).catch(() => {});
  };

  if (phase === 'start') {
    const turn = await structured<InterviewTurn>(schema, InterviewTurnSchema, messages, { label: 'mock_interview', maxTokens: 900, timeoutMs: 30_000, signal: request.signal, onUsage }).catch((err) => {
      console.error('[interview] turn failed:', (err as Error).message);
      return null;
    });
    if (!turn || !state.allowed.includes(turn.action)) {
      await fail();
      return json({ error: 'upstream' }, 502);
    }
    return json({ sid: session, turn: finish(turn) });
  }

  // A turn streams (SSE): `say` {text} as Ami's words are written (she starts speaking at once), then `turn` {turn}
  // with everything else, or `error`; then `done`.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(frame(event, data));
        } catch {}
      };
      try {
        const live = anthropic().messages.stream(
          { model: MODEL, max_tokens: 1400, thinking: noThinking(MODEL), output_config: { effort: 'low', format: { type: 'json_schema', schema } }, system: SYSTEM, messages },
          { signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) },
        );
        let raw = '';
        let said = 0;
        live.on('text', (delta) => {
          raw += delta;
          const say = partialSay(raw);
          if (say.length > said) {
            send('say', { text: say.slice(said) });
            said = say.length;
          }
        });
        const res = await live.finalMessage();
        onUsage(res.usage);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {}
        let turn: InterviewTurn | null = InterviewTurnSchema.safeParse(parsed).data ?? null;
        if (!turn || !state.allowed.includes(turn.action)) {
          // Rare: the streamed JSON didn't fit. One careful retry; what was already shown is replaced.
          turn = await structured<InterviewTurn>(schema, InterviewTurnSchema, messages, { label: 'mock_interview', maxTokens: 900, timeoutMs: 30_000, signal: request.signal, onUsage });
          if (!turn || !state.allowed.includes(turn.action)) throw new Error('invalid-output');
          send('replace', { text: turn.say });
        }
        send('turn', { turn: finish(turn) });
      } catch (err) {
        if (!request.signal.aborted) {
          console.error('[interview] turn failed:', (err as Error).message);
          await fail();
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
