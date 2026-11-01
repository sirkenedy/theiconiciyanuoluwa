// Shared Claude plumbing for Career Coach. Every task uses the Haiku-class model (career-mode.md §5); Haiku 5.5 rejects
// non-default sampling, so no temperature is sent. The static instructions are one cached system block.
import Anthropic from '@anthropic-ai/sdk';
import { CAREER_PROMPT } from '../../content/career-prompt.ts';
import { ProfileSchema, type ChatTurn, type Profile } from './types.ts';

export const MODEL = 'claude-haiku-5-5';

let client: Anthropic | null = null;
export const anthropic = () => (client ??= new Anthropic({ maxRetries: 1 }));

export const SYSTEM: Anthropic.TextBlockParam[] = [{ type: 'text', text: CAREER_PROMPT, cache_control: { type: 'ephemeral' } }];

/** Visitor-supplied text sits inside tags the prompt treats as data; it must not be able to close them early. */
const TAGS = /<\/?\s*(context|profile|resume|jobs?|answers|summary|today|task|suggest|tailored|changes|ats|letter)\b[^>]*>/gi;
export const asData = (s: string) => s.replace(TAGS, '');

/** The per-request `<context>` block (career-mode.md §4.5): compact, so conversations stay cheap at any length. */
export function context(parts: {
  task: string;
  profile?: Profile | null;
  resume?: string;
  job?: { title?: string; company?: string; description: string } | null;
  answers?: { question: string; answer: string }[];
  jobs?: unknown[];
  summary?: string;
  today: string;
}) {
  return [
    `task = "${parts.task}"`,
    '<context>',
    parts.profile ? `  <profile>${asData(JSON.stringify(parts.profile))}</profile>` : '  <profile>none yet</profile>',
    parts.resume ? `  <resume>\n${asData(parts.resume)}\n  </resume>` : '',
    parts.job ? `  <job>\n${asData([parts.job.title, parts.job.company].filter(Boolean).join(' · '))}\n${asData(parts.job.description)}\n  </job>` : '',
    parts.answers?.length ? `  <answers>${asData(JSON.stringify(parts.answers))}</answers>` : '',
    parts.jobs?.length ? `  <jobs>${asData(JSON.stringify(parts.jobs))}</jobs>` : '',
    parts.summary ? `  <summary>${asData(parts.summary)}</summary>` : '',
    `  <today>${parts.today}</today>`,
    '</context>',
  ]
    .filter(Boolean)
    .join('\n');
}

export const isoDay = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10));

export function cleanProfile(input: unknown): Profile | null {
  const parsed = ProfileSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Turns from the client: alternating-ish user/assistant, bounded in count and length, ending with the visitor. */
export function cleanTurns(input: unknown, max: number, { userMax, assistantMax }: { userMax: number; assistantMax: number }): ChatTurn[] | null {
  if (!Array.isArray(input) || !input.length || input.length > max) return null;
  const turns: ChatTurn[] = [];
  for (const m of input) {
    const role = m?.role;
    const content = typeof m?.content === 'string' ? m.content.trim() : '';
    if ((role !== 'user' && role !== 'assistant') || !content) return null;
    if (content.length > (role === 'user' ? userMax : assistantMax)) return null;
    turns.push({ role, content: asData(content) });
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  return turns.length ? turns : null;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * One structured-output call: JSON-schema constrained, streamed internally (long outputs stay clear of HTTP timeouts),
 * zod-validated, retried once with the validation error. `onProgress` gets the characters written so far.
 */
export async function structured<T>(
  schema: Record<string, unknown>,
  validate: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; code: string }[] } } },
  messages: Anthropic.MessageParam[],
  opts: { label: string; maxTokens: number; signal: AbortSignal; timeoutMs?: number; onProgress?: (chars: number) => void; onUsage?: (u: Anthropic.Usage) => void },
): Promise<T | null> {
  const history = [...messages];
  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = anthropic().messages.stream(
      { model: MODEL, max_tokens: opts.maxTokens, thinking: { type: 'disabled' }, output_config: { effort: 'low', format: { type: 'json_schema', schema } }, system: SYSTEM, messages: history },
      { signal: AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 25_000)]) },
    );
    let chars = 0;
    if (opts.onProgress) stream.on('text', (delta) => opts.onProgress!((chars += delta.length)));
    const res = await stream.finalMessage();
    opts.onUsage?.(res.usage);
    if (res.stop_reason === 'refusal') {
      console.error(`[career] ${opts.label}: model refused`);
      return null;
    }
    const out = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {}
    const ok = validate.safeParse(parsed);
    if (ok.success) return ok.data;
    // Shape only (paths and zod codes), never the content: diagnosable 502s without logging anyone's résumé.
    const why = parsed === undefined ? 'unparseable JSON' : ok.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'} ${i.code}`).join(', ');
    console.error(`[career] ${opts.label}: invalid output (attempt ${attempt + 1}, stop ${res.stop_reason}, ${res.usage.output_tokens}/${opts.maxTokens} tokens): ${why}`);
    history.push({ role: 'assistant', content: out || '{}' }, { role: 'user', content: 'That JSON did not match the schema (check types, lengths and allowed values). Return the corrected JSON only.' });
  }
  return null;
}
