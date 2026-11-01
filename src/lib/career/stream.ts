// Streaming helpers for Career Coach chat: visible text, then an optional trailing <suggest>[…]</suggest> block that is
// held back from the stream (even when the tag arrives split across chunks) and parsed into quick-reply chips.

export class TagSplitter {
  private pending = '';
  private hidden: string | null = null;
  visible = '';
  private open: string;

  constructor(open: string) {
    this.open = open;
  }

  push(chunk: string): string {
    if (this.hidden !== null) {
      this.hidden += chunk;
      return '';
    }
    const text = this.pending + chunk;
    const at = text.indexOf(this.open);
    if (at >= 0) {
      this.hidden = text.slice(at);
      this.pending = '';
      return this.emit(text.slice(0, at));
    }
    let keep = 0;
    for (let n = Math.min(this.open.length - 1, text.length); n > 0; n--) {
      if (this.open.startsWith(text.slice(-n))) {
        keep = n;
        break;
      }
    }
    this.pending = text.slice(text.length - keep);
    return this.emit(text.slice(0, text.length - keep));
  }

  end(): { tail: string; hidden: string | null } {
    const tail = this.hidden === null ? this.emit(this.pending) : '';
    this.pending = '';
    return { tail, hidden: this.hidden };
  }

  private emit(text: string) {
    this.visible += text;
    return text;
  }
}

/** ≤ 3 short suggestions, plain strings only. */
export function parseSuggest(raw: string | null): string[] {
  const body = raw?.replace('<suggest>', '').split('</suggest>')[0].trim();
  if (!body) return [];
  try {
    const list: unknown = JSON.parse(body);
    if (!Array.isArray(list)) return [];
    return list.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim().slice(0, 60)).slice(0, 3);
  } catch {
    return [];
  }
}

const encoder = new TextEncoder();
export const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
export const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' };

/** Reads an SSE response body as {event, data} pairs (browser side). */
export async function* readEvents(res: Response): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}
