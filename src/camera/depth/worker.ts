/**
 * Depth estimation Web Worker: runs Depth Anything V2 small through
 * transformers.js (ONNX Runtime Web, WebGPU with WASM fallback) off the
 * main thread. One inference at a time; the main thread drops frames while
 * one is in flight (see ModelDepthEstimator).
 *
 * Messages in:  { type: 'init', modelId, device: 'webgpu' | 'wasm' | 'auto', dtype? }
 *               { type: 'infer', id, width, height, rgba: ArrayBuffer }
 * Messages out: { type: 'ready', backend }
 *               { type: 'error', message }
 *               { type: 'depth', id, width, height, inverse: ArrayBuffer, ms }
 */
import { pipeline, RawImage, env } from '@huggingface/transformers';

type DepthPipeline = (image: RawImage) => Promise<{ predicted_depth: { data: Float32Array | number[]; dims: number[] } }>;

let estimator: DepthPipeline | null = null;
const ctx = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void };

interface InitMessage {
  type: 'init';
  modelId: string;
  device: 'webgpu' | 'wasm' | 'auto';
  dtype?: string;
}
interface InferMessage {
  type: 'infer';
  id: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

async function load(modelId: string, device: 'webgpu' | 'wasm', dtype?: string): Promise<void> {
  env.allowLocalModels = false;
  const options: Record<string, unknown> = { device };
  if (dtype) options.dtype = dtype;
  else if (device === 'webgpu') options.dtype = 'fp16';
  else options.dtype = 'q8';
  estimator = (await pipeline('depth-estimation', modelId, options)) as unknown as DepthPipeline;
}

async function init(msg: InitMessage): Promise<void> {
  const candidates: ('webgpu' | 'wasm')[] = msg.device === 'auto' ? ['webgpu', 'wasm'] : [msg.device];
  let lastError: unknown = null;
  for (const device of candidates) {
    if (device === 'webgpu' && !('gpu' in navigator)) continue;
    try {
      await load(msg.modelId, device, msg.dtype);
      postMessage({ type: 'ready', backend: device });
      return;
    } catch (err) {
      lastError = err;
      estimator = null;
    }
  }
  postMessage({ type: 'error', message: lastError instanceof Error ? lastError.message : String(lastError ?? 'no backend') });
}

async function infer(msg: InferMessage): Promise<void> {
  if (!estimator) {
    postMessage({ type: 'error', message: 'not ready' });
    return;
  }
  const t0 = performance.now();
  try {
    const image = new RawImage(new Uint8ClampedArray(msg.rgba), msg.width, msg.height, 4);
    const out = await estimator(image);
    const tensor = out.predicted_depth;
    const dims = tensor.dims;
    const h = dims[dims.length - 2] ?? msg.height;
    const w = dims[dims.length - 1] ?? msg.width;
    const inverse = tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data);
    const copy = new Float32Array(inverse); // detach from the runtime's buffer
    ctx.postMessage({ type: 'depth', id: msg.id, width: w, height: h, inverse: copy.buffer, ms: performance.now() - t0 }, [copy.buffer]);
  } catch (err) {
    postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (event: MessageEvent<InitMessage | InferMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') void init(msg);
  else if (msg.type === 'infer') void infer(msg);
};
