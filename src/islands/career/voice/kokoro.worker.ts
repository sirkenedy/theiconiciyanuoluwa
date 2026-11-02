// Ami's natural voice: Kokoro (82M, open source, Apache-2.0), 8-bit, ~92 MB downloaded once and kept by the browser.
// Text in, audio out, on this device. Uses the same ONNX runtime files as the speech recogniser (served from this site).
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import ortMjs from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url&no-inline';
import ortWasm from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url&no-inline';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
env.allowLocalModels = false;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

let tts: Promise<KokoroTTS> | null = null;
function load() {
  tts ??= KokoroTTS.from_pretrained(MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress_total' && p.total) self.postMessage({ type: 'progress', loaded: p.loaded ?? 0, total: p.total });
    },
  } as Parameters<typeof KokoroTTS.from_pretrained>[1]);
  return tts;
}

self.onmessage = async (e: MessageEvent<{ type: 'load' } | { type: 'say'; id: number; text: string; voice: string }>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load();
      self.postMessage({ type: 'ready' });
      return;
    }
    const started = performance.now();
    const audio = await (await load()).generate(msg.text, { voice: msg.voice as 'af_heart' });
    const samples = audio.audio as Float32Array;
    (self as unknown as Worker).postMessage({ type: 'audio', id: msg.id, samples, rate: audio.sampling_rate, ms: performance.now() - started }, [samples.buffer as ArrayBuffer]);
  } catch (err) {
    if (msg.type === 'load') tts = null;
    self.postMessage({ type: 'error', id: msg.type === 'say' ? msg.id : null, message: (err as Error).message });
  }
};
