// Helpers for the /api/twin output contract: answer text, then one <meta>{…}</meta> block that is never streamed.

export const ACTIONS = ['download_resume', 'email', 'scroll:journey', 'scroll:blog'] as const;
export type TwinAction = (typeof ACTIONS)[number] | null;
export type TwinMeta = { cite: string[]; followups: string[]; action: TwinAction; unknown: boolean };
export type TwinErrorCode = 'rate_limited' | 'upstream' | 'invalid';

const OPEN = '<meta>';

/** Splits streamed text into visible tokens and the hidden meta block, even when `<meta>` arrives split across chunks. */
export class MetaSplitter {
  private pending = '';
  private meta: string | null = null;
  visible = '';

  push(chunk: string): string {
    if (this.meta !== null) {
      this.meta += chunk;
      return '';
    }
    const text = this.pending + chunk;
    const at = text.indexOf(OPEN);
    if (at >= 0) {
      this.meta = text.slice(at);
      this.pending = '';
      return this.emit(text.slice(0, at));
    }
    // Hold back a tail that could be the start of "<meta>".
    let keep = 0;
    for (let n = Math.min(OPEN.length - 1, text.length); n > 0; n--) {
      if (OPEN.startsWith(text.slice(-n))) {
        keep = n;
        break;
      }
    }
    this.pending = text.slice(text.length - keep);
    return this.emit(text.slice(0, text.length - keep));
  }

  end(): { tail: string; meta: string | null } {
    const tail = this.meta === null ? this.emit(this.pending) : '';
    this.pending = '';
    return { tail, meta: this.meta };
  }

  private emit(text: string) {
    this.visible += text;
    return text;
  }
}

const UNKNOWN = /not something I can answer|(?:isn't|is not|not) (?:in|on|part of) my r[ée]sum[ée]|can't answer (?:that|this) from my r[ée]sum[ée]|don't have (?:that|this) (?:in|on) my r[ée]sum[ée]/i;

/** Parses and validates the meta block: unknown cite ids are dropped, actions are whitelisted. */
export function parseMeta(raw: string | null, citeIds: readonly string[], answer: string): TwinMeta {
  let data: Record<string, unknown> = {};
  const body = raw?.replace(OPEN, '').split('</meta>')[0].trim();
  if (body) {
    try {
      data = JSON.parse(body);
    } catch {}
  }
  const allowed = new Set(citeIds);
  const cite = Array.isArray(data.cite) ? [...new Set(data.cite.filter((c): c is string => typeof c === 'string' && allowed.has(c)))].slice(0, 3) : [];
  const followups = Array.isArray(data.followups)
    ? data.followups.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map((f) => f.trim().slice(0, 80)).slice(0, 3)
    : [];
  const action = (ACTIONS as readonly string[]).includes(data.action as string) ? (data.action as TwinAction) : null;
  return { cite, followups, action, unknown: UNKNOWN.test(answer) };
}

/** Lower-case, trim, drop punctuation and collapse spaces: the answer-cache key for a first question. */
export const normaliseQuestion = (q: string) =>
  q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}{} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

export const stripHtml = (s: string) => s.replace(/<[^>]*>?/g, '');
