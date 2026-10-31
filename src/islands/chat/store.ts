import data from '../../content/twin-client.json';
import { tokenise, type Placeholder } from '../../lib/twin-privacy';
import type { TwinErrorCode, TwinMeta } from '../../lib/twin-stream';
import { streamTwin } from './sse';

export type OrbState = 'idle' | 'typing' | 'thinking' | 'streaming' | 'answered' | 'unknown' | 'error';
export type Message = {
  id: number;
  role: 'user' | 'assistant';
  /** Tokenised text ({{NAME}} etc.); expanded only when rendered. */
  text: string;
  status: 'thinking' | 'streaming' | 'done' | 'error';
  meta?: TwinMeta;
  error?: TwinErrorCode;
  local?: boolean;
};
export type State = {
  messages: Message[];
  busy: boolean;
  orb: OrbState;
  /** The inline card shows the conversation only after the visitor uses it, so restoring a chat can't shift the hero. */
  inlineActive: boolean;
  cardVisible: boolean;
  open: boolean;
};

const STORAGE_KEY = 'twin-v1';
const HISTORY = 6;
const FAKE_TYPING_MS = 350;
const pairs = data.pairs as [string, Placeholder][];
export const twinData = data;

let state: State = { messages: restore(), busy: false, orb: 'idle', inlineActive: false, cardVisible: true, open: false };
const listeners = new Set<(s: State) => void>();
let nextId = state.messages.reduce((n, m) => Math.max(n, m.id), 0) + 1;
let controller: AbortController | null = null;

export const getState = () => state;
export function subscribe(fn: (s: State) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
}
const update = (id: number, patch: Partial<Message>) =>
  setState({ messages: state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) });

function restore(): Message[] {
  try {
    return (JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as Message[]).filter((m) => m.status === 'done' || m.status === 'error');
  } catch {
    return [];
  }
}
function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.messages.filter((m) => m.status === 'done' || m.status === 'error')));
  } catch {}
}

let announce: (text: string) => void = () => {};
export const setAnnouncer = (fn: (text: string) => void) => (announce = fn);

/** Reveals an already-known answer word by word, then settles (instant FAQ answers and fallbacks). */
function typeOut(id: number, text: string, finish: Partial<Message>, orb: OrbState) {
  const words = text.match(/\S+\s*/g) ?? [text];
  const started = performance.now();
  setState({ orb: 'streaming' });
  const step = (now: number) => {
    const shown = Math.min(words.length, Math.ceil(((now - started) / FAKE_TYPING_MS) * words.length));
    update(id, { text: words.slice(0, shown).join(''), status: shown < words.length ? 'streaming' : 'done' });
    if (shown < words.length) requestAnimationFrame(step);
    else {
      update(id, { text, ...finish });
      setState({ busy: false, orb });
      persist();
      announce(text);
    }
  };
  requestAnimationFrame(step);
}

/** Best keyword overlap with a FAQ question; used when the model can't be reached. */
export function matchFaq(question: string) {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const asked = words(question);
  let best: { a: string; score: number } | null = null;
  for (const f of data.faq) {
    const q = words(f.q);
    const score = [...q].filter((w) => asked.has(w)).length / Math.max(1, q.size);
    if (!best || score > best.score) best = { a: f.a, score };
  }
  return best && best.score >= 0.5 && !/\[[^\]]+\]/.test(best.a) ? best.a : null;
}

export function askLocal(question: string, answer: string) {
  if (state.busy) return;
  const user: Message = { id: nextId++, role: 'user', text: tokenise(question, pairs), status: 'done' };
  const reply: Message = { id: nextId++, role: 'assistant', text: '', status: 'streaming', local: true, meta: { cite: [], followups: [], action: null, unknown: false } };
  setState({ messages: [...state.messages, user, reply], busy: true, inlineActive: true });
  typeOut(reply.id, tokenise(answer, pairs), { status: 'done' }, 'answered');
}

const FALLBACK: Record<TwinErrorCode, string> = {
  rate_limited: "I've answered a lot of questions in a short time, so I'm taking a breather.",
  upstream: "I can't reach my answers right now.",
  invalid: "I couldn't read that question — try asking it a little differently.",
};

/** Sends a question to /api/twin. Returns false (and changes nothing) while an answer is still in progress. */
export function ask(question: string): boolean {
  const text = question.trim().slice(0, 500);
  if (!text || state.busy) return false;
  const user: Message = { id: nextId++, role: 'user', text: tokenise(text, pairs), status: 'done' };
  const reply: Message = { id: nextId++, role: 'assistant', text: '', status: 'thinking' };
  const history = [...state.messages, user]
    .filter((m) => m.status === 'done' && m.text)
    .slice(-HISTORY)
    .map((m) => ({ role: m.role, content: m.text }));
  setState({ messages: [...state.messages, user, reply], busy: true, orb: 'thinking', inlineActive: true });
  announce('Thinking…');

  controller = new AbortController();
  let buffer = '';
  let frame = 0;
  // One DOM write per animation frame, however fast tokens arrive.
  const flush = () => {
    frame = 0;
    update(reply.id, { text: buffer, status: 'streaming' });
  };
  streamTwin(
    history,
    {
      token: (t) => {
        buffer += t;
        if (state.orb !== 'streaming') setState({ orb: 'streaming' });
        if (!frame) frame = requestAnimationFrame(flush);
      },
      meta: (meta) => update(reply.id, { meta }),
      done: () => {
        cancelAnimationFrame(frame);
        const meta = state.messages.find((m) => m.id === reply.id)?.meta;
        update(reply.id, { text: buffer.trimEnd(), status: 'done' });
        setState({ busy: false, orb: meta?.unknown ? 'unknown' : 'answered' });
        persist();
        announce(buffer);
      },
      error: (code) => {
        cancelAnimationFrame(frame);
        const faq = code !== 'invalid' ? matchFaq(text) : null;
        const message = faq ? `${FALLBACK[code]} Here's a quick answer I keep handy: ${faq}` : FALLBACK[code];
        update(reply.id, { status: 'streaming', error: code, meta: { cite: [], followups: [], action: 'email', unknown: false } });
        typeOut(reply.id, tokenise(message, pairs), { status: 'error', error: code }, 'error');
      },
    },
    controller.signal,
  );
  return true;
}

export function stop() {
  if (!controller || !state.busy) return;
  controller.abort();
  const last = state.messages.at(-1);
  if (last?.role === 'assistant') update(last.id, { status: last.text ? 'done' : 'error', text: last.text || 'Stopped.' });
  setState({ busy: false, orb: 'idle' });
  persist();
}
