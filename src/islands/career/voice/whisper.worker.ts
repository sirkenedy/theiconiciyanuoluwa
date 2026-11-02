// On-device speech recognition for mock interviews: Whisper (base, English, 8-bit, ~77 MB, downloaded once and cached by
// the browser) via Transformers.js. Audio in, text out; nothing is uploaded. Base hears real voices and accents far better
// than tiny.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
// The ONNX runtime is served from this site (not a CDN): its loader and WebAssembly binary, bundled by Vite.
import ortMjs from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url&no-inline';
import ortWasm from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url&no-inline';

const MODEL = 'onnx-community/whisper-base.en';
env.allowLocalModels = false;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function load() {
  asr ??= pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status: string; loaded?: number; total?: number }) => {
      // "progress_total" adds up every file of the model (encoder, decoder, tokenizer…).
      if (p.status === 'progress_total' && p.total) self.postMessage({ type: 'progress', loaded: p.loaded ?? 0, total: p.total });
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  return asr;
}

self.onmessage = async (e: MessageEvent<{ type: 'load' } | { type: 'transcribe'; id: number; audio: Float32Array }>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load();
      self.postMessage({ type: 'ready' });
    } else {
      // A whole answer can run past Whisper's 30-second window: read it in overlapping chunks.
      const long = msg.audio.length > 28 * 16_000;
      const out = (await (await load())(msg.audio, long ? { chunk_length_s: 30, stride_length_s: 5 } : {})) as { text: string };
      self.postMessage({ type: 'text', id: msg.id, text: out.text.trim() });
    }
  } catch (err) {
    if (msg.type === 'load') asr = null;
    self.postMessage({ type: 'error', id: msg.type === 'transcribe' ? msg.id : null, message: (err as Error).message });
  }
};
