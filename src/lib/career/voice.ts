// Hands-free answers in a mock interview: when has the candidate finished, and how did they sound? Pure functions (no
// audio, no DOM), so the turn-taking rules are unit-tested. The text comes from on-device speech recognition.

/** "That's my answer", "so yeah, that's it": they're done, respond now. */
const FINISHED = /\b(that'?s (it|all|about it|my answer|everything)|that is (it|all|my answer)|that('?ll| will) be (all|it)|(i'?m|i am) (done|finished)|i'?ve finished|(and )?yeah,? that'?s (it|about it)|so that'?s (how|what|why) [^.?!]{0,40}|over to you)[.!]?\s*$/i;
/** "…thank you" closes an answer, not the "Okay, thank you" that opens one. */
const THANKS = /\b(thank you( very much)?|thanks( a lot)?)[.!]?\s*$/i;
/** Trailing off on "and…", "so…", "um…": still thinking, wait longer. */
const TRAILING = /(\b(and|so|but|because|or|um+|uh+|erm|er|like|then|which|that|to|the|a|an|with|of|for|my|our|when|where|if|also|basically)|,|…|\.\.\.)\s*$/i;
/** Commands said out loud ("repeat that", "skip", "let's stop here"): answered at once. */
export const SPOKEN_COMMAND = /^(please )?(can you |could you )?(repeat|say (that|it) again|come again|pardon)\b[^.?!]{0,30}[.?!]*$|^(skip|pass|next question)( (this|that)( one| question)?)?( please)?[.!]*$|^(end|stop|finish)( (the|this))?( interview)?( now| here| please)?[.!]*$|^let'?s (stop|end)( (here|now|there))?[.!]*$/i;

/** They said they're finished ("I am done", "that will be all", a closing "thank you") or gave a command: final. */
export const decisive = (text: string) => {
  const t = text.trim();
  const tail = t.split(/(?<=[.!?,])\s+/).at(-1) ?? t;
  return SPOKEN_COMMAND.test(t) || (t.split(/\s+/).length <= 8 && SPOKEN_COMMAND.test(tail)) || FINISHED.test(t) || (THANKS.test(t) && t.split(/\s+/).length >= 12);
};

/**
 * Real words, or the recogniser guessing at noise? A fan surge can come back as one word ("The", "So") spread over
 * seconds of sound; speech runs at about 2–3 words a second.
 */
/** What Whisper says when it hears near-silence: real only when said clearly out loud. */
const STOCK = /^\s*(thank you( very much| so much)?|thanks|hello|hi|hey|bye|goodbye|okay|ok|so|yes|yeah|um+|uh+|hmm+)[.!?,]*\s*$/i;

/** `loud`: how far the stretch rose above the room (dB) when known (a real microphone). */
export function isWords(text: string, ms: number, loud?: number) {
  const t = text.trim();
  if (ms < 250 || !t || !/\p{L}{2,}/u.test(t) || /^\s*([[(].*[\])]|thanks for watching[.!]?|you|\.+)\s*$/i.test(t)) return false;
  if (loud !== undefined && (loud < 12 || (STOCK.test(t) && loud < 20))) return false;
  const n = t.split(/\s+/).length;
  return n >= 2 ? n / (ms / 1000) >= 0.6 : ms <= 1500;
}

export const WAIT = { finished: 0, command: 0, sentence: 1800, shortSentence: 2600, unfinished: 4000, trailing: 6000, nudge: 10_000 } as const;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * After `silenceMs` of quiet, is the answer complete? `pending`: speech still being turned into text (never decide
 * before the last words are known). Long thinking pauses are normal: only a finished-sounding answer ends quickly.
 */
export function turnDone(text: string, silenceMs: number, pending = false): boolean {
  const t = text.trim();
  if (pending || !t) return false;
  if (decisive(t) && !FINISHED.test(t) && !THANKS.test(t)) return silenceMs >= WAIT.command;
  if (FINISHED.test(t) || (THANKS.test(t) && words(t) >= 12)) return silenceMs >= WAIT.finished;
  if (TRAILING.test(t)) return silenceMs >= WAIT.trailing;
  if (/[.!?]["')\]]?\s*$/.test(t)) return silenceMs >= (words(t) < 12 ? WAIT.shortSentence : WAIT.sentence);
  return silenceMs >= WAIT.unfinished;
}

/** Nothing said yet for a while: a gentle "take your time" (once), never a move on. */
export const needsNudge = (text: string, silenceMs: number) => !text.trim() && silenceMs >= WAIT.nudge;

/** Speech recognition tidies speech, so fillers it keeps are a lower bound. */
const FILLERS: [string, RegExp][] = [
  ['um', /\b(um+|erm+|uh+|er|hmm+)\b/gi],
  ['like', /\blike,/gi],
  ['you know', /\byou know\b(?! (what|how|that|why|when|where|who))/gi],
  ['basically', /\bbasically\b/gi],
  ['kind of', /\b(kind|sort) of\b/gi],
  ['I mean', /(^|[,.!?]\s*)i mean\b/gi],
  ['actually', /\bactually\b/gi],
];

export type Delivery = { seconds: number; words: number; wpm: number; fillers: number; fillerWords: string[]; longPauses: number };

/** One spoken answer: `segments` are the stretches of speech (text + duration), `pauses` the silences between them. */
export function delivery(segments: { text: string; ms: number }[], pauses: number[]): Delivery {
  const text = segments.map((s) => s.text).join(' ');
  const ms = segments.reduce((n, s) => n + s.ms, 0) + pauses.reduce((n, p) => n + p, 0);
  const count = words(text);
  const found: string[] = [];
  let fillers = 0;
  for (const [name, re] of FILLERS) {
    const n = text.match(re)?.length ?? 0;
    if (n) found.push(name);
    fillers += n;
  }
  const seconds = Math.round(ms / 1000);
  return { seconds, words: count, wpm: ms > 3000 ? Math.round(count / (ms / 60_000)) : 0, fillers, fillerWords: found, longPauses: pauses.filter((p) => p >= 3000).length };
}

/** "64 s · 142 words a minute · 3 filler words (um, like) · 1 long pause" */
export function deliveryLine(d: Pick<Delivery, 'seconds' | 'wpm' | 'fillers' | 'longPauses'> & { fillerWords?: string[] }) {
  return [
    `${d.seconds} s`,
    d.wpm ? `${d.wpm} words a minute` : '',
    `${d.fillers} filler word${d.fillers === 1 ? '' : 's'}${d.fillerWords?.length ? ` (${d.fillerWords.join(', ')})` : ''}`,
    d.longPauses ? `${d.longPauses} long pause${d.longPauses === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Speech or not, one 20 ms frame at a time (its loudness in dB). The room's noise floor is the quietest 200 ms block of
 * the last 3 s, tracked all the time; speech starts on sound clearly above it. It ends after 600 ms that are near the
 * floor or clearly quieter than they were speaking, so a steady fan or a raised microphone gain can't hold it open.
 */
export class SpeechGate {
  floor = -60;
  speaking = false;
  private blocks: number[] = [];
  private blockMin = 0;
  private blockN = 0;
  private run = 0;
  private quiet = 0;
  private level = -30;
  private smooth = -60;
  private noise = -60; // the room between utterances, right now (a fan that just became audible counts)

  private primed = false;

  frame(db: number): 'start' | 'end' | null {
    if (!this.primed) {
      // The first sound heard is the room (they haven't been asked anything yet): start from it, not from silence.
      this.primed = true;
      this.smooth = this.noise = db;
    }
    this.smooth = this.smooth * 0.7 + db * 0.3; // ~100 ms average: a wobbling fan doesn't flicker into "speech"
    this.blockMin = this.blockN === 0 ? db : Math.min(this.blockMin, db);
    if (++this.blockN === 10) {
      this.blocks.push(this.blockMin);
      if (this.blocks.length > 15) this.blocks.shift();
      this.blockN = 0;
      if (this.blocks.length >= 3) this.floor = Math.max(-90, Math.min(...this.blocks));
    }
    if (!this.speaking) {
      this.noise = this.noise * 0.95 + this.smooth * 0.05;
      this.run = db > Math.max(this.floor + 12, this.noise + 10, -55) ? this.run + 1 : 0;
      if (this.run < 4) return null;
      this.speaking = true;
      this.quiet = 0;
      this.level = db;
      return 'start';
    }
    const quietNow = this.smooth < Math.max(this.floor + 6, -55) || this.smooth < this.level - 10;
    // Only clearly voiced frames teach it how loud they speak, so trailing noise can't drag that level down.
    if (this.smooth > this.level - 6) this.level = this.level * 0.95 + this.smooth * 0.05;
    this.quiet = quietNow ? this.quiet + 1 : 0;
    if (this.quiet < 30) return null;
    this.speaking = false;
    this.run = 0;
    this.noise = this.smooth;
    return 'end';
  }

  /** How far above the room this frame is (dB, smoothed): real speech stands well clear of it. */
  get above() {
    return this.smooth - this.floor;
  }

  /** A dip between words while they talk: a good place to cut a long stretch so it's read while they go on. */
  get dip() {
    return this.speaking && this.smooth < this.level - 6;
  }

  /** Frames of quiet at the end of the speech just ended (part of the silence after it). */
  get trailing() {
    return this.quiet;
  }

  reset() {
    this.speaking = false;
    this.run = this.quiet = 0;
  }
}
