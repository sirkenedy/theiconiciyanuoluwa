// Ami's voice in a spoken mock interview. The natural voice is Kokoro (open source, on this device, downloaded once);
// until it's ready, or on a device too slow for it, the browser's own voice speaks. Lines are spoken as they arrive,
// sentence by sentence: the next sentence is made while the current one plays.
import workerUrl from './kokoro.worker.ts?worker&url';

type Hooked = { __ccVoiceTest?: { speaker?: () => Speaker } };
type TT = { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(u: string): string }): { createScriptURL(u: string): string } } };
let policy: { createScriptURL(u: string): string } | null | undefined;
/** Under Trusted Types a worker needs a vouched URL: this policy vouches for exactly the voice worker. */
function vouched(u: string): string {
  if (policy === undefined) policy = (globalThis as unknown as TT).trustedTypes?.createPolicy('ami-voice', { createScriptURL: (x) => (x === workerUrl ? x : '') }) ?? null;
  return (policy ? policy.createScriptURL(u) : u) as string;
}

export interface Speaker {
  /** Queues a line (spoken after anything already queued). `onLevel` (0–1) follows her voice, for the orb. Resolves when it has been spoken (or stopped). */
  speak(text: string, onLevel?: (v: number) => void): Promise<void>;
  stop(): void;
  /** Called inside the tap that starts the interview: browsers only allow sound after a tap. */
  unlock(): void;
  /** Starts the natural voice download (after the speech recogniser, so they don't compete). */
  prepare?(phrases: string[], onProgress?: (loaded: number, total: number) => void): Promise<void>;
  readonly available: boolean;
  readonly natural?: boolean;
}

const sentences = (text: string) => text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];

/** Natural-sounding English voices first (names differ by browser and system). */
const PREFERRED = [/natural/i, /neural/i, /google (uk|us) english/i, /samantha|ava|allison|serena|karen|moira|tessa/i, /aria|jenny|libby|sonia/i];

class BrowserSpeaker implements Speaker {
  private synth = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
  private voice: SpeechSynthesisVoice | null = null;
  private run = 0;
  private chain: Promise<void> = Promise.resolve();
  get available() {
    return !!this.synth;
  }

  private pick() {
    if (this.voice || !this.synth) return this.voice;
    const english = this.synth.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
    for (const re of PREFERRED) {
      const hit = english.find((v) => re.test(v.name));
      if (hit) return (this.voice = hit);
    }
    return (this.voice = english.find((v) => v.default) ?? english[0] ?? null);
  }

  unlock() {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    this.synth.speak(u);
    this.synth.getVoices();
  }

  stop() {
    this.run++;
    this.chain = Promise.resolve();
    this.synth?.cancel();
  }

  speak(text: string, onLevel?: (v: number) => void) {
    const run = this.run;
    this.chain = this.chain.then(async () => {
      for (const sentence of sentences(text)) {
        if (run !== this.run || !this.synth) return;
        await new Promise<void>((done) => {
          const u = new SpeechSynthesisUtterance(sentence);
          const v = this.pick();
          if (v) u.voice = v;
          u.lang = v?.lang ?? 'en-GB';
          u.onboundary = () => onLevel?.(0.7);
          // Some engines never fire "end": never wait longer than the sentence could take.
          const limit = setTimeout(done, 1500 + sentence.split(/\s+/).length * 450);
          u.onend = u.onerror = () => {
            clearTimeout(limit);
            done();
          };
          this.synth!.speak(u);
        });
      }
    });
    return this.chain;
  }
}

type Made = { samples: Float32Array; rate: number; ms: number };

/** Kokoro in a worker; plays through Web Audio (an analyser drives the orb). Falls back to the browser's voice. */
class NaturalSpeaker implements Speaker {
  readonly natural = true;
  private device = new BrowserSpeaker();
  private worker: Worker | null = null;
  private ready = false;
  private slow = false;
  private seq = 0;
  private waiting = new Map<number, (m: Made | null) => void>();
  private cache = new Map<string, Promise<Made | null>>();
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private run = 0;
  private chain: Promise<void> = Promise.resolve();
  private voiceName = 'af_heart';

  get available() {
    return true;
  }

  unlock() {
    this.device.unlock();
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
  }

  prepare(phrases: string[], onProgress?: (loaded: number, total: number) => void) {
    if (this.worker) return Promise.resolve();
    this.worker = new Worker(vouched(workerUrl), { type: 'module' });
    return new Promise<void>((resolve, reject) => {
      this.worker!.onmessage = (e: MessageEvent<{ type: string; id?: number; samples?: Float32Array; rate?: number; ms?: number; loaded?: number; total?: number; message?: string }>) => {
        const m = e.data;
        if (m.type === 'progress' && m.total) onProgress?.(m.loaded ?? 0, m.total);
        else if (m.type === 'ready') {
          this.ready = true;
          // Short reactions are made now, so they play the instant an answer ends. The first also times this device:
          // if it can't make speech faster than it plays, she keeps the device voice (no gaps, no waiting).
          const [first, ...rest] = phrases;
          if (first) {
            const timing = this.make(first);
            this.cache.set(first, timing);
            void timing.then((got) => {
              if (!got || this.tooSlow(got)) {
                this.slow = true;
                console.info('[voice] the natural voice is too slow on this device; using the device voice');
                return;
              }
              for (const p of rest) this.cache.set(p, this.make(p));
            });
          }
          resolve();
        } else if (m.type === 'audio' || (m.type === 'error' && m.id != null)) {
          this.waiting.get(m.id!)?.(m.type === 'audio' ? { samples: m.samples!, rate: m.rate!, ms: m.ms ?? 0 } : null);
          this.waiting.delete(m.id!);
        } else if (m.type === 'error') {
          this.worker = null;
          reject(new Error(m.message));
        }
      };
      this.worker!.onerror = (e) => {
        e.preventDefault();
        this.ready = false;
        for (const done of this.waiting.values()) done(null);
        this.waiting.clear();
        reject(new Error(e.message || 'voice worker failed'));
      };
      this.worker!.postMessage({ type: 'load' });
    });
  }

  /** Slower than real time (with a margin): it would leave gaps between her sentences. */
  private tooSlow(m: Made) {
    return m.ms > Math.max(1500, (m.samples.length / m.rate) * 1000 * 1.2);
  }

  private make(text: string): Promise<Made | null> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    if (!this.worker || !this.ready) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      const limit = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, 12_000);
      this.waiting.set(id, (m) => {
        clearTimeout(limit);
        resolve(m);
      });
      this.worker!.postMessage({ type: 'say', id, text, voice: this.voiceName });
    });
  }

  stop() {
    this.run++;
    this.chain = Promise.resolve();
    try {
      this.source?.stop();
    } catch {}
    this.device.stop();
  }

  speak(text: string, onLevel?: (v: number) => void) {
    const run = this.run;
    // Each sentence starts being made now (the worker queues them), so the next is ready while this one plays.
    const parts = this.ready && !this.slow ? sentences(text).map((s) => ({ s, made: this.make(s) })) : null;
    this.chain = this.chain.then(async () => {
      if (run !== this.run) return;
      if (!parts) return this.device.speak(text, onLevel);
      for (const { s, made } of parts) {
        if (run !== this.run) return;
        // She never waits on the natural voice: a sentence that isn't ready within a moment is said by the device voice.
        const got = await Promise.race([made, new Promise<null>((r) => setTimeout(() => r(null), 900))]);
        if (run !== this.run) return;
        if (!got) {
          await this.device.speak(s, onLevel);
          continue;
        }
        if (this.tooSlow(got)) this.slow = true;
        await this.play(got, run, onLevel);
      }
    });
    return this.chain;
  }

  private play(m: Made, run: number, onLevel?: (v: number) => void) {
    return new Promise<void>((done) => {
      if (run !== this.run) return done();
      this.ctx ??= new AudioContext();
      const buffer = this.ctx.createBuffer(1, m.samples.length, m.rate);
      buffer.copyToChannel(m.samples as Float32Array<ArrayBuffer>, 0);
      const src = this.ctx.createBufferSource();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      src.buffer = buffer;
      src.connect(analyser).connect(this.ctx.destination);
      const data = new Uint8Array(analyser.fftSize);
      let raf = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 4));
        raf = requestAnimationFrame(tick);
      };
      src.onended = () => {
        cancelAnimationFrame(raf);
        if (this.source === src) this.source = null;
        done();
      };
      this.source = src;
      src.start();
      if (onLevel) raf = requestAnimationFrame(tick);
    });
  }
}

/** `natural`: Kokoro (with the browser voice as fallback); otherwise the browser's voice only. */
export const makeSpeaker = (natural: boolean): Speaker => (globalThis as Hooked).__ccVoiceTest?.speaker?.() ?? (natural ? new NaturalSpeaker() : new BrowserSpeaker());
