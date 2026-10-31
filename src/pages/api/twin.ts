import Anthropic from '@anthropic-ai/sdk';
import type { APIRoute } from 'astro';
import { CITE_IDS, RESUME_HASH, SYSTEM_PROMPT } from '../../content/twin-prompt.ts';
import { clientIp, digest, pipeline, redisConfig } from '../../lib/redis.ts';
import { MetaSplitter, normaliseQuestion, parseMeta, stripHtml, type TwinErrorCode, type TwinMeta } from '../../lib/twin-stream.ts';

export const prerender = false;

const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 350;
const MAX_INPUT = 500;
const MAX_ANSWER = 2000;
const MAX_TURNS = 6;
const TIMEOUT_MS = 15_000;
const CACHE_TTL_S = 24 * 3600;
const LIMITS = [
  { name: 'h', seconds: 3600, max: 20 },
  { name: 'd', seconds: 86_400, max: 60 },
];

type Turn = Anthropic.MessageParam & { content: string };

let anthropic: Anthropic | null = null;
const client = () => (anthropic ??= new Anthropic({ maxRetries: 0 }));

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  'x-accel-buffering': 'no',
};

/** A one-event stream for failures that happen before the model is called (still a 200, so browsers log nothing). */
const failure = (code: TwinErrorCode) =>
  new Response(new ReadableStream({ start: (c) => (c.enqueue(frame('error', { code })), c.close()) }), { headers: SSE_HEADERS });

function cleanTurns(input: unknown): Turn[] | null {
  if (!Array.isArray(input)) return null;
  const turns: Turn[] = [];
  for (const m of input.slice(-MAX_TURNS)) {
    const role = m?.role;
    const content = typeof m?.content === 'string' ? stripHtml(m.content).trim() : '';
    if ((role !== 'user' && role !== 'assistant') || !content) return null;
    if (content.length > (role === 'user' ? MAX_INPUT : MAX_ANSWER)) return null;
    turns.push({ role, content });
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  return turns.length && turns.at(-1)!.role === 'user' ? turns : null;
}

// ---- rate limiting: Redis fixed windows (20/hour, 60/day per IP), in-memory per instance without Redis ----
const local = new Map<string, number[]>();
async function rateLimited(ip: string): Promise<boolean> {
  const redis = redisConfig();
  const now = Date.now();
  if (!redis) {
    const hits = (local.get(ip) ?? []).filter((t) => now - t < 86_400_000);
    hits.push(now);
    local.set(ip, hits);
    return LIMITS.some((l) => hits.filter((t) => now - t < l.seconds * 1000).length > l.max);
  }
  const id = await digest('twin', ip);
  const keys = LIMITS.map((l) => `rl:twin:${l.name}:${id}:${Math.floor(now / 1000 / l.seconds)}`);
  try {
    const out = await pipeline(redis, keys.flatMap((k, i) => [['INCR', k], ['EXPIRE', k, LIMITS[i].seconds + 60]]));
    return LIMITS.some((l, i) => Number(out[i * 2]) > l.max);
  } catch {
    return false;
  }
}

// ---- answer cache: identical first questions, keyed by normalised question + résumé hash ----
type Cached = { text: string; meta: TwinMeta };
async function cacheKey(turns: Turn[]) {
  if (turns.length !== 1) return null;
  return `twin:a:${RESUME_HASH}:${await digest('q', normaliseQuestion(turns[0].content), 12)}`;
}
async function readCache(key: string | null): Promise<Cached | null> {
  const redis = redisConfig();
  if (!key || !redis) return null;
  try {
    const [hit] = await pipeline(redis, [['GET', key]]);
    return typeof hit === 'string' ? (JSON.parse(hit) as Cached) : null;
  } catch {
    return null;
  }
}
function writeCache(key: string | null, value: Cached) {
  const redis = redisConfig();
  if (key && redis) pipeline(redis, [['SET', key, JSON.stringify(value), 'EX', CACHE_TTL_S]]).catch(() => {});
}

/** Warm-up: the client sends HEAD on first focus of the chat input so the first question skips the cold start. */
export const HEAD: APIRoute = () => {
  if (process.env.ANTHROPIC_API_KEY) client();
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: { messages?: unknown };
  try {
    body = await request.json();
  } catch {
    return failure('invalid');
  }
  const turns = cleanTurns(body.messages);
  if (!turns) return failure('invalid');
  if (await rateLimited(clientIp(request, () => clientAddress))) return failure('rate_limited');
  if (!process.env.ANTHROPIC_API_KEY) return failure('upstream');

  const key = await cacheKey(turns);
  const cached = await readCache(key);
  const debug = process.env.TWIN_DEBUG === '1';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(frame(event, data));
      if (cached) {
        for (const word of cached.text.match(/\S+\s*/g) ?? []) send('token', { t: word });
        send('meta', cached.meta);
        send('done', { cached: true });
        controller.close();
        return;
      }

      const splitter = new MetaSplitter();
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]);
      try {
        const response = client().messages.stream(
          {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            // Fastest first token: no thinking, low effort. (Haiku 5.5 rejects non-default temperature, so none is sent.)
            thinking: { type: 'disabled' },
            output_config: { effort: 'low' },
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            messages: turns,
          },
          { signal },
        );
        for await (const event of response) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const t = splitter.push(event.delta.text);
            if (t) send('token', { t });
          }
        }
        const final = await response.finalMessage();
        const { tail, meta: raw } = splitter.end();
        if (tail) send('token', { t: tail });

        let meta = parseMeta(raw, CITE_IDS, splitter.visible);
        if (final.stop_reason === 'refusal') {
          if (!splitter.visible.trim()) send('token', { t: "That's not something I can help with here — feel free to email me instead." });
          meta = { cite: [], followups: [], action: 'email', unknown: true };
        }
        send('meta', meta);
        send('done', debug ? { usage: final.usage } : {});
        if (final.stop_reason === 'end_turn') writeCache(key, { text: splitter.visible.trimEnd(), meta });
      } catch (err) {
        // A visitor pressing Stop aborts the request; there is nobody left to tell.
        if (!request.signal.aborted) send('error', { code: 'upstream' satisfies TwinErrorCode });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
};
