// "Share my progress" cards: what one holds, and the signed link that carries it. Everything on a card is chosen by
// the visitor; it lives only in the link (base64url JSON + an HMAC), never in a database. The signature means a shared
// link can't be edited into other numbers. Pure (Web Crypto only): used by the API, the card page and the tests.

export type CardFormat = 'square' | 'story' | 'wide';
export const CARD_SIZES: Record<CardFormat, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
  wide: { width: 1200, height: 630 },
};

export type CardData = {
  /** Their name, only if they chose to show it. */
  name: string | null;
  period: 'week' | 'all';
  applied: number | null;
  interviews: number | null;
  offers: number | null;
  /** Mock interviews done. */
  practice: number | null;
  /** Mock interview score, first → latest (out of 5). */
  score: [number, number] | null;
  /** One line from their latest scorecard ("Clear, measurable results"). */
  highlight: string | null;
  /** This week's applications goal: done, of (reached or not). */
  goal: [number, number] | null;
  /** The role they're going for ("Senior Product Manager"). */
  role: string | null;
  /** Jobs Ami found for them. */
  found: number | null;
  /** Tailored résumés, cover letters and prep guides made. */
  docs: number | null;
  /** Companies they've applied to or are interviewing with (only if they chose to name them). */
  companies: string[] | null;
  /** Their top skills. */
  skills: string[] | null;
  /** A short, fun story Ami wrote about their search (they can edit it). */
  story: string | null;
};

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(999, Math.round(v))) : null);
const score = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(5, Math.round(v * 10) / 10)) : null);
/** Plain text only, one line: names and highlights come from the visitor. */
const line = (v: unknown, max: number) => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return t || null;
};

/** Anything in: a valid, bounded card out (or null). */
export function cleanCard(input: unknown): CardData | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  const pair = (v: unknown, f: (x: unknown) => number | null): [number, number] | null => {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const a = f(v[0]);
    const b = f(v[1]);
    return a === null || b === null ? null : [a, b];
  };
  const list = (v: unknown, n: number, max: number) => {
    if (!Array.isArray(v)) return null;
    const out = v.map((x) => line(x, max)).filter((x): x is string => !!x).slice(0, n);
    return out.length ? out : null;
  };
  const card: CardData = {
    name: line(c.name, 30),
    period: c.period === 'all' ? 'all' : 'week',
    applied: count(c.applied),
    interviews: count(c.interviews),
    offers: count(c.offers),
    practice: count(c.practice),
    score: pair(c.score, score),
    highlight: line(c.highlight, 90),
    goal: pair(c.goal, count),
    role: line(c.role, 60),
    found: count(c.found),
    docs: count(c.docs),
    companies: list(c.companies, 3, 30),
    skills: list(c.skills, 3, 24),
    story: line(c.story, 280),
  };
  if (card.goal && card.goal[1] < 1) card.goal = null;
  const something = [card.applied, card.interviews, card.offers, card.practice, card.found, card.docs].some((n) => n !== null) || card.score || card.highlight || card.story;
  return something ? card : null;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

async function key(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(`ami-card:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function mac(secret: string, body: string) {
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(body))).slice(0, 12));
}

/** Short keys keep links short. */
const pack = (c: CardData) => ({ n: c.name, p: c.period === 'all' ? 1 : 0, a: c.applied, i: c.interviews, o: c.offers, m: c.practice, s: c.score, h: c.highlight, g: c.goal, r: c.role, f: c.found, d: c.docs, c: c.companies, k: c.skills, t: c.story });
const unpack = (o: Record<string, unknown>) =>
  cleanCard({ name: o.n, period: o.p === 1 ? 'all' : 'week', applied: o.a, interviews: o.i, offers: o.o, practice: o.m, score: o.s, highlight: o.h, goal: o.g, role: o.r, found: o.f, docs: o.d, companies: o.c, skills: o.k, story: o.t });

export async function cardToken(card: CardData, secret: string) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(pack(card))));
  return `${body}.${await mac(secret, body)}`;
}

/** The card a link carries, or null if it was changed or isn't a card link. */
export async function readCardToken(token: string, secret: string): Promise<CardData | null> {
  const m = /^([A-Za-z0-9_-]{8,2400})\.([A-Za-z0-9_-]{16})$/.exec(token);
  if (!m) return null;
  const expected = await mac(secret, m[1]);
  if (expected.length !== m[2].length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  if (diff) return null;
  try {
    return unpack(JSON.parse(new TextDecoder().decode(fromB64url(m[1]))));
  } catch {
    return null;
  }
}

/** The signing secret: CARD_SECRET, else one derived from the server's own Redis token (both server-only). */
export const cardSecret = () => process.env.CARD_SECRET || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || 'local-dev-only';

/** The caption that goes with a card ("This week: 6 applications, 2 interviews. …"). */
export function cardCaption(c: CardData, url: string) {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const facts = [
    c.applied !== null ? plural(c.applied, 'application') : '',
    c.interviews !== null ? plural(c.interviews, 'interview') : '',
    c.offers ? plural(c.offers, 'offer') : '',
    c.practice !== null ? plural(c.practice, 'mock interview') : '',
  ].filter(Boolean);
  const when = c.period === 'week' ? 'This week' : 'My job search so far';
  const parts = [facts.length ? `${when}: ${facts.join(', ')}.` : '', c.score ? `My interview practice score went from ${c.score[0]} to ${c.score[1]} out of 5.` : ''];
  return `${parts.filter(Boolean).join(' ')} I'm practising with Ami, a free AI career coach. Try it: ${url}`.trim();
}
