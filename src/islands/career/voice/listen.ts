// Hands-free answers: the microphone, a voice detector, on-device speech-to-text, and the turn-taking that decides when
// an answer is finished. Loaded only when a voice interview starts. Tests swap the microphone and the recogniser for
// scripted fakes (window.__ccVoiceTest) and drive the same turn-taking code.
import { SPOKEN_COMMAND, SpeechGate, decisive, delivery, isWords, needsNudge, turnDone, type Delivery } from '../../../lib/career/voice.ts';
import workletUrl from './mic-worklet.js?url&no-inline';
import workerUrl from './whisper.worker.ts?worker&url';

type Handler<T> = (v: T) => void;
/** Speech is "audio" from a real microphone; tests send its text directly. */
/** `loud`: how far it rose above the room's noise (dB), from a real microphone. */
export type Speech = { audio: Float32Array | { text: string }; ms: number; loud?: number };
export interface Mic {
  open(): Promise<void>;
  pause(): void;
  resume(): void;
  close(): void;
  on(e: 'speechstart', fn: Handler<void>): void;
  on(e: 'speech', fn: Handler<Speech>): void;
  on(e: 'silence', fn: Handler<number>): void;
  on(e: 'level', fn: Handler<number>): void;
}
export interface Ears {
  /** `onProgress(loaded, total)` in bytes while the model downloads (once; then the browser keeps it). */
  load(onProgress: (loaded: number, total: number) => void): Promise<void>;
  transcribe(audio: Speech['audio']): Promise<string>;
}
type TestHooks = { mic: () => Mic; ears: () => Ears; supported?: boolean };
const hooks = () => (globalThis as { __ccVoiceTest?: TestHooks }).__ccVoiceTest;

export const voiceSupported = () =>
  hooks()?.supported ?? (!!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly === 'object' && typeof Worker !== 'undefined');

type TT = { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(u: string): string }): { createScriptURL(u: string): string } } };
let policy: { createScriptURL(u: string): string } | null | undefined;
/** Under Trusted Types, scripts need vouched URLs: this policy vouches for exactly our worker and our worklet. */
function scriptUrl(u: string): string {
  if (policy === undefined) policy = (window as unknown as TT).trustedTypes?.createPolicy('voice', { createScriptURL: (x) => (x === workletUrl || x === workerUrl ? x : '') }) ?? null;
  return (policy ? policy.createScriptURL(u) : u) as string;
}

const RATE = 16_000;
const FRAME = 320; // 20 ms at 16 kHz

/** The real microphone, with a loudness-based voice detector whose noise floor adapts to the room. */
class RealMic implements Mic {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private on_: { [k: string]: Handler<never>[] } = {};
  private live = false;
  private gate = new SpeechGate();
  private seg: Float32Array[] = [];
  private peak = 0; // the loudest this stretch rose above the room
  private preroll: Float32Array[] = [];
  private pending = new Float32Array(0);
  private sinceSpeech = 0; // frames of silence since speech ended (or since listening began)

  on(e: string, fn: Handler<never>) {
    (this.on_[e] ??= []).push(fn);
  }
  private emit(e: string, v?: unknown) {
    for (const fn of this.on_[e] ?? []) (fn as Handler<unknown>)(v);
  }

  async open() {
    // Asked for inside the Start tap when possible (phones only show the permission prompt for a tap).
    this.stream = await (takeEarlyMic() ?? requestMic());
    try {
      this.ctx = new AudioContext({ sampleRate: RATE });
    } catch {
      this.ctx = new AudioContext();
    }
    await this.ctx.audioWorklet.addModule(scriptUrl(workletUrl));
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, 'cc-mic');
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // keeps the graph running without playing the microphone back
    src.connect(node).connect(mute).connect(this.ctx.destination);
    const ratio = this.ctx.sampleRate / RATE;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.feed(ratio === 1 ? e.data : downsample(e.data, ratio));
    this.live = true;
  }
  pause() {
    this.live = false;
    this.reset();
  }
  resume() {
    this.reset();
    this.live = true;
    void this.ctx?.resume();
  }
  close() {
    this.live = false;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close();
  }
  private reset() {
    this.gate.reset();
    this.sinceSpeech = 0;
    this.seg = [];
    this.preroll = [];
  }

  private feed(samples: Float32Array) {
    if (!this.live) return;
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) this.frame(all.subarray(i, i + FRAME).slice());
    this.pending = all.slice(i);
  }

  private frame(f: Float32Array) {
    let sum = 0;
    for (const s of f) sum += s * s;
    const db = 10 * Math.log10(sum / f.length + 1e-10);
    this.emit('level', Math.min(1, Math.max(0, (db + 65) / 45)));
    const was = this.gate.speaking;
    const change = this.gate.frame(db);
    if (!was) {
      this.preroll.push(f);
      if (this.preroll.length > 15) this.preroll.shift();
      if (change === 'start') {
        this.seg = [...this.preroll];
        this.peak = this.gate.above;
        this.emit('speechstart');
        return;
      }
      if (++this.sinceSpeech % 5 === 0) this.emit('silence', this.sinceSpeech * 20);
      return;
    }
    this.seg.push(f);
    this.peak = Math.max(this.peak, this.gate.above);
    // Long stretches are read in pieces while they keep talking (at a dip after 6 s, or at 15 s), so little is left to
    // read when they stop and Ami answers quickly.
    const long = (this.seg.length >= 300 && this.gate.dip) || this.seg.length >= 750;
    if (change === 'end' || long) {
      const trailing = change === 'end' ? this.gate.trailing : 0;
      this.emit('speech', { audio: concat(this.seg), ms: Math.max(0, this.seg.length - trailing) * 20, loud: this.peak });
      this.seg = [];
      this.peak = 0;
      if (change === 'end') {
        this.preroll = [];
        this.sinceSpeech = trailing;
      }
    }
  }
}

function concat(parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** To 16 kHz by averaging each window (a simple low-pass): picking single samples would alias and blur the words. */
function downsample(input: Float32Array, ratio: number) {
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j];
    out[i] = sum / Math.max(1, to - from);
  }
  return out;
}

/** Whisper in a worker, so the page never freezes while it listens. */
class RealEars implements Ears {
  private worker?: Worker;
  private seq = 0;
  private waiting = new Map<number, (text: string) => void>();
  load(onProgress: (loaded: number, total: number) => void) {
    this.worker ??= new Worker(scriptUrl(workerUrl), { type: 'module' });
    return new Promise<void>((resolve, reject) => {
      this.worker!.onmessage = (e: MessageEvent<{ type: string; id?: number; text?: string; loaded?: number; total?: number; message?: string }>) => {
        const m = e.data;
        if (m.type === 'progress' && m.total) onProgress(m.loaded ?? 0, m.total);
        else if (m.type === 'ready') resolve();
        else if (m.type === 'text' || (m.type === 'error' && m.id != null)) {
          this.waiting.get(m.id!)?.(m.text ?? '');
          this.waiting.delete(m.id!);
        } else if (m.type === 'error') reject(new Error(m.message));
      };
      this.worker!.onerror = (e) => {
        e.preventDefault();
        for (const done of this.waiting.values()) done('');
        this.waiting.clear();
        reject(new Error(e.message || 'speech worker failed'));
      };
      this.worker!.postMessage({ type: 'load' });
    });
  }
  transcribe(audio: Speech['audio']) {
    if (!(audio instanceof Float32Array)) return Promise.resolve(audio.text);
    const id = ++this.seq;
    return new Promise<string>((resolve) => {
      // Never wait forever: a stalled or crashed worker gives up after 20 s (the turn goes on with what was heard).
      const limit = setTimeout(() => {
        this.waiting.delete(id);
        resolve('');
      }, 20_000);
      this.waiting.set(id, (text) => {
        clearTimeout(limit);
        resolve(text);
      });
      this.worker!.postMessage({ type: 'transcribe', id, audio }); // copied, not moved: the answer is read again whole
    });
  }
}

export const makeMic = (): Mic => hooks()?.mic() ?? new RealMic();

const requestMic = () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
let early: Promise<MediaStream> | null = null;
/** Call synchronously inside the tap that starts a spoken interview: the permission prompt appears right then. */
export function askForMicNow() {
  if (hooks() || !navigator.mediaDevices?.getUserMedia) return;
  early = requestMic();
  early.catch(() => {}); // handled when the microphone is opened
}
function takeEarlyMic() {
  const p = early;
  early = null;
  return p;
}

/** One speech model per page, started early (when the setup card appears) so it's usually ready by "Start". */
let ears: Ears | null = null;
let ready: Promise<void> | null = null;
const progress = { loaded: 0, total: 0, listeners: new Set<(loaded: number, total: number) => void>() };
export function warmEars(onProgress?: (loaded: number, total: number) => void): { ears: Ears; ready: Promise<void> } {
  ears ??= hooks()?.ears() ?? new RealEars();
  if (onProgress) {
    progress.listeners.add(onProgress);
    if (progress.total) onProgress(progress.loaded, progress.total);
  }
  ready ??= ears
    .load((loaded, total) => {
      Object.assign(progress, { loaded, total });
      for (const fn of progress.listeners) fn(loaded, total);
    })
    .catch((err) => {
      ready = null; // a later try can download again
      throw err;
    });
  return { ears, ready };
}

/** Whisper's guesses for silence or noise ("[BLANK_AUDIO]", "(coughs)", "Thank you."), dropped. */
const NOISE = /^\s*([[(].*[\])]|thanks for watching[.!]?|you|\.+)\s*$/i;

type Callbacks = {
  onLive(text: string): void;
  onAnswer(text: string, d: Delivery): void;
  /** They kept talking after an answer was sent: true if it could be taken back (Ami hadn't replied yet). */
  onBargeIn(): boolean;
  onNudge(): void;
  /** They've stopped and the answer is being finished (last words read): show it, so it never looks stuck. */
  onReading(): void;
  /** They (re)started talking. */
  onSpeech(): void;
};

/**
 * Turn-taking: collects one answer from stretches of speech, decides when it's finished (turnDone), and hands it over.
 * Only real words count: a fan, a cough or a bump that the recogniser turns into nothing changes nothing (it doesn't
 * reopen the answer, cancel its final reading, take back a sent answer, or reset the "they've stopped" clock).
 */
export class VoiceTurns {
  private segments: { text: string; ms: number; audio?: Float32Array }[] = [];
  private pauses: number[] = [];
  private pending = 0;
  private silence = 0; // since the last sound the microphone heard (noise included)
  private carry = 0; // quiet before noise that turned out not to be words: still part of their silence
  private heard = false;
  private nudged = false;
  private state: 'off' | 'listening' | 'final' | 'sent' = 'off';
  private sent: { segments: { text: string; ms: number; audio?: Float32Array }[]; pauses: number[] } | null = null;
  private final = 0; // which whole-answer read is current (more words cancel it)
  private forced = false;
  private forceTimer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0; // which answer a stretch of speech belongs to (listen() starts a new one)
  private startQuiet = 0; // how long they'd been quiet when the current sound began

  constructor(
    private mic: Mic,
    private ears: Ears,
    private cb: Callbacks,
  ) {
    // A sound restarts the clock; if it turns out not to be words, the quiet before it is given back (carry).
    mic.on('speechstart', () => {
      this.startQuiet = this.quiet();
      this.silence = 0;
      this.carry = 0;
    });
    mic.on('speech', (s) => {
      if (this.state === 'off') return;
      const gen = this.gen;
      const before = this.startQuiet;
      // Too quiet to be speech (a breath, the room): never sent to the recogniser, which would invent "Thank you."
      if (s.loud !== undefined && s.loud < 12) {
        this.carry += before + s.ms;
        this.check();
        return;
      }
      this.pending++;
      ears
        .transcribe(s.audio)
        .catch(() => '')
        .then((text) => {
          this.pending--;
          if (gen !== this.gen) return; // from an answer that's already over
          if (!isWords(text, s.ms, s.loud) || this.echo(text)) {
            this.carry += before + s.ms; // not speech: the quiet goes on
            this.check();
            return;
          }
          this.carry = 0;
          const seg = { text, ms: s.ms, ...(s.audio instanceof Float32Array ? { audio: s.audio } : {}) };
          if (this.state === 'sent') {
            // More words after the answer went: take it back and continue it, if Ami hasn't replied yet.
            if (!this.sent || !cb.onBargeIn()) return;
            this.segments = this.sent.segments;
            this.pauses = this.sent.pauses;
            this.sent = null;
          }
          if (this.state === 'final') this.final++; // more words while it was being read whole: not finished
          this.state = 'listening';
          if (this.heard) this.pauses.push(before);
          this.heard = true;
          this.segments.push(seg);
          cb.onSpeech();
          cb.onLive(this.text());
          this.check();
        });
    });
    mic.on('silence', (ms) => {
      this.silence = ms;
      this.check();
    });
  }

  private quiet() {
    return this.silence + this.carry;
  }

  private text() {
    return this.segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  private check() {
    if (this.state !== 'listening') return;
    const text = this.text();
    const quiet = this.quiet();
    if (!this.nudged && !this.heard && needsNudge(text, quiet)) {
      this.nudged = true;
      this.cb.onNudge();
    }
    if (quiet >= 1200 && this.pending > 0 && text) this.cb.onReading();
    // "I am done": nothing heard after it matters, so don't wait for it to be read (it may only be the fan).
    const final = !!text && decisive(text);
    if (!final && !(this.forced && this.pending === 0 && text) && !turnDone(text, quiet, this.pending > 0)) return;
    this.finish();
  }

  private finish() {
    const text = this.text();
    if (!text) return;
    this.forced = false;
    clearTimeout(this.forceTimer);
    const segments = this.segments;
    const pauses = this.pauses;
    const audio = segments.filter((s) => s.audio).map((s) => s.audio!);
    // Short bursts are read without context: a short answer (≤ 20 s) is read again whole, which is more accurate. A long
    // one isn't (it would take many seconds on a phone or laptop): its slips are fixed by Ami, who knows the context.
    const seconds = audio.reduce((n, a) => n + a.length, 0) / RATE;
    // "I am done" is final: sent at once, so nothing heard after it (a fan, a word guessed from noise) can reopen it.
    if (audio.length > 1 && seconds <= 20 && !decisive(text)) {
      this.cb.onReading();
      const run = ++this.final;
      this.state = 'final';
      const gap = new Float32Array(RATE / 4);
      const whole = new Float32Array(audio.reduce((n, a) => n + a.length + gap.length, 0));
      let o = 0;
      for (const a of audio) {
        whole.set(a, o);
        o += a.length + gap.length;
      }
      // At most 4 s: if the whole read is slow, the pieces already heard are good enough.
      const fallback = setTimeout(() => run === this.final && this.state === 'final' && this.send(text, segments, pauses), 4000);
      this.ears
        .transcribe(whole)
        .catch(() => '')
        .then((better) => {
          clearTimeout(fallback);
          if (run !== this.final || this.state !== 'final') return;
          this.send(better && !NOISE.test(better) && /\p{L}{2,}/u.test(better) ? better : text, segments, pauses);
        });
      return;
    }
    this.send(text, segments, pauses);
  }

  private send(text: string, segments: VoiceTurns['segments'], pauses: number[]) {
    this.sent = SPOKEN_COMMAND.test(text) ? null : { segments, pauses };
    this.state = 'sent';
    this.cb.onAnswer(text, delivery(segments, pauses));
  }

  /** They tapped "done": the answer goes now (after the last words are read, 3 s at most). */
  finishNow() {
    if (this.state === 'final') {
      this.final++;
      this.send(this.text(), this.segments, this.pauses);
      return true;
    }
    if (this.state !== 'listening' || (!this.text() && !this.pending)) return false;
    this.forced = true;
    this.cb.onReading();
    clearTimeout(this.forceTimer);
    this.forceTimer = setTimeout(() => this.state === 'listening' && this.forced && this.finish(), 3000);
    this.check();
    return true;
  }

  /** Her own short reply ("Mm-hm, thank you.") picked up by the microphone is not them talking. */
  private ignored = '';
  ignore(phrase: string) {
    this.ignored = phrase;
  }
  private echo(text: string) {
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    return !!this.ignored && norm(text) === norm(this.ignored);
  }

  /** Ami is speaking: the microphone rests (so she doesn't hear herself) and the turn waits. */
  hold() {
    if (this.state === 'off') return;
    this.state = 'sent';
    this.sent = null;
    this.gen++;
    this.mic.pause();
  }

  /** A fresh answer (after Ami's question appears). */
  listen() {
    this.gen++;
    this.forced = false;
    clearTimeout(this.forceTimer);
    this.segments = [];
    this.pauses = [];
    this.sent = null;
    this.silence = 0;
    this.carry = 0;
    this.heard = false;
    this.nudged = false;
    this.state = 'listening';
    this.mic.resume();
    this.cb.onLive('');
  }
  /** Paused by them, or while the page is hidden: what was said so far stays. */
  pause() {
    if (this.state === 'off') return;
    this.mic.pause();
  }
  resume() {
    if (this.state === 'off') return;
    this.silence = 0;
    this.mic.resume();
  }
  stop() {
    this.state = 'off';
    clearTimeout(this.forceTimer);
    this.mic.close();
  }
}
