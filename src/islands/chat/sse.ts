import type { TwinErrorCode, TwinMeta } from '../../lib/twin-stream';

export type TwinEvents = {
  token: (t: string) => void;
  meta: (meta: TwinMeta) => void;
  done: () => void;
  error: (code: TwinErrorCode) => void;
};

/** POSTs the conversation and dispatches the SSE events from /api/twin. Network failures surface as `upstream`. */
export async function streamTwin(messages: { role: 'user' | 'assistant'; content: string }[], on: TwinEvents, signal: AbortSignal) {
  let finished = false;
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    fn();
  };
  try {
    const res = await fetch('/api/twin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    });
    if (!res.ok || !res.body) return finish(() => on.error('upstream'));
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === 'token') on.token(payload.t);
        else if (event === 'meta') on.meta(payload);
        else if (event === 'done') finish(on.done);
        else if (event === 'error') finish(() => on.error(payload.code));
      }
    }
    finish(() => on.error('upstream'));
  } catch {
    if (!signal.aborted) finish(() => on.error('upstream'));
  }
}
