/**
 * ModelDepthEstimator: monocular depth from Depth Anything V2 small running
 * in a Web Worker (src/camera/depth/worker.ts), scaled to metres by fitting
 * the model's relative inverse depth against the floor prior (fit.ts).
 *
 * Off-loop by construction: `submit` posts a frame and returns; the result
 * arrives on a message and becomes `latest`. While the model is loading or
 * unavailable, an optional fallback estimator (the plane prior) answers
 * instead so callers always see *something* honestly tagged.
 */
import type { Pose } from '@/core/types';
import { quatRotateVec3 } from '@/core/math';
import type { CameraIntrinsics, DepthEstimator, DepthMap, DepthSample, DepthStatus, GrabbedFrame } from '../contract';
import { fillFloorDepth, toleranceForEstimatedDepth } from './prior';
import { fitConfidence, fitInverseDepthToFloor, inverseToMetric, resampleDepth } from './fit';

export const DEFAULT_DEPTH_MODEL_ID = 'onnx-community/depth-anything-v2-small';
/** Longest side handed to the model (multiple of the 14 px ViT patch after the processor's own resize). */
export const MODEL_INPUT_WIDTH = 252;
/** A depth map older than this is not resampled into a capture frame. */
const MAX_SAMPLE_AGE_MS = 1500;
/** Camera rotation beyond this (rad) between the map and a capture invalidates reuse. */
const MAX_SAMPLE_ROTATION_RAD = 0.05;

export interface ModelDepthOptions {
  modelId?: string;
  device?: 'webgpu' | 'wasm' | 'auto';
  fallback: DepthEstimator | null;
  floorY?: () => number;
}

interface Pending {
  id: number;
  pose: Pose;
  fovY: number;
  aspect: number;
  timestamp: number;
}

export class ModelDepthEstimator implements DepthEstimator {
  readonly status: DepthStatus = { state: 'idle', backend: 'none', modelId: null, lastInferenceMs: 0, error: null };
  private map: DepthMap | undefined = undefined;
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private readonly fallback: DepthEstimator | null;
  private readonly modelId: string;
  private readonly device: 'webgpu' | 'wasm' | 'auto';
  private readonly floorY: () => number;
  private floorScratch: Float32Array | null = null;
  /** Live adjustments (src/camera/tuning.ts): metric = fitted * scale + shift, then EMA-smoothed against the previous map. */
  adjust = { scale: 1, shiftM: 0, smoothing: 0 };

  constructor(opts: ModelDepthOptions) {
    this.fallback = opts.fallback;
    this.modelId = opts.modelId ?? DEFAULT_DEPTH_MODEL_ID;
    this.device = opts.device ?? 'auto';
    this.floorY = opts.floorY ?? (() => 0);
    this.status.modelId = this.modelId;
  }

  get latest(): DepthMap | undefined {
    return this.map ?? this.fallback?.latest;
  }

  async start(): Promise<void> {
    if (this.worker) return;
    if (this.fallback) await this.fallback.start();
    if (typeof Worker === 'undefined') {
      this.status.state = 'unavailable';
      this.status.error = 'Web Workers unavailable';
      return;
    }
    this.status.state = 'loading';
    await new Promise<void>((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      } catch (err) {
        this.status.state = 'unavailable';
        this.status.error = err instanceof Error ? err.message : String(err);
        resolve();
        return;
      }
      this.worker = worker;
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type: string; [k: string]: unknown };
        if (msg.type === 'ready') {
          this.status.state = 'ready';
          this.status.backend = msg.backend === 'webgpu' ? 'webgpu' : 'wasm';
          this.status.error = null;
          resolve();
        } else if (msg.type === 'error') {
          if (this.status.state === 'loading') {
            this.status.state = 'unavailable';
            this.status.backend = 'none';
            resolve();
          }
          this.status.error = String(msg.message);
          this.pending = null;
        } else if (msg.type === 'depth') {
          this.onDepth(msg as unknown as { id: number; width: number; height: number; inverse: ArrayBuffer; ms: number });
        }
      };
      worker.onerror = (event) => {
        this.status.error = event.message || 'worker error';
        if (this.status.state === 'loading') {
          this.status.state = 'unavailable';
          resolve();
        }
        this.pending = null;
      };
      worker.postMessage({ type: 'init', modelId: this.modelId, device: this.device });
    });
  }

  submit(frame: GrabbedFrame, pose: Pose, intrinsics: CameraIntrinsics): boolean {
    if (this.status.state !== 'ready' || !this.worker) {
      return this.fallback ? this.fallback.submit(frame, pose, intrinsics) : false;
    }
    if (this.pending) return false;
    const id = this.nextId++;
    this.pending = { id, pose: { position: { ...pose.position }, rotation: { ...pose.rotation } }, fovY: intrinsics.fovY, aspect: frame.width / frame.height, timestamp: frame.timestamp };
    const rgba = new Uint8ClampedArray(frame.rgba); // copy: the grab buffer may be reused by the caller
    this.worker.postMessage({ type: 'infer', id, width: frame.width, height: frame.height, rgba: rgba.buffer }, [rgba.buffer]);
    return true;
  }

  private onDepth(msg: { id: number; width: number; height: number; inverse: ArrayBuffer; ms: number }): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.id !== msg.id) return;
    this.status.lastInferenceMs = msg.ms;
    const inverse = new Float32Array(msg.inverse);
    const { width, height } = msg;
    if (!this.floorScratch || this.floorScratch.length !== width * height) this.floorScratch = new Float32Array(width * height);
    const floor = this.floorScratch;
    const hits = fillFloorDepth(floor, width, height, pending.pose, pending.fovY, pending.aspect, this.floorY());
    const fit = hits > 0 ? fitInverseDepthToFloor(inverse, floor) : null;
    if (!fit) {
      // Cannot scale to metres (no floor in view): keep the previous map; the fallback stays honest.
      this.status.error = 'metric fit failed (no floor in view)';
      return;
    }
    this.status.error = null;
    const metric = new Float32Array(width * height);
    inverseToMetric(inverse, fit, metric);
    const { scale, shiftM, smoothing } = this.adjust;
    const prev = this.map && this.map.width === width && this.map.height === height ? this.map.metric : null;
    const keep = prev && smoothing > 0 ? Math.min(0.95, smoothing) : 0;
    for (let i = 0; i < metric.length; i++) {
      let m = metric[i] as number;
      if (m > 0) m = m * scale + shiftM;
      if (keep > 0) {
        const p = prev![i] as number;
        if (p > 0 && m > 0) m = m * (1 - keep) + p * keep;
      }
      metric[i] = m > 0 ? m : 0;
    }
    let sum = 0;
    for (let i = 0; i < inverse.length; i++) sum += inverse[i] as number;
    const confidence = fitConfidence(fit, sum / inverse.length);
    this.map = {
      width,
      height,
      metric,
      confidence,
      source: 'monocular',
      pose: pending.pose,
      fovY: pending.fovY,
      aspect: pending.aspect,
      timestamp: pending.timestamp,
    };
  }

  sample(width: number, height: number, pose: Pose, fovY: number, aspect: number): DepthSample | null {
    const map = this.map;
    if (map && performance.now() - map.timestamp < MAX_SAMPLE_AGE_MS && rotationBetween(map.pose, pose) < MAX_SAMPLE_ROTATION_RAD) {
      const metric = resampleDepth(map.metric, map.width, map.height, width, height);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < metric.length; i++) {
        const d = metric[i] as number;
        if (d > 0) {
          sum += d;
          n += 1;
        }
      }
      const mean = n > 0 ? sum / n : 2;
      return { metric, source: 'monocular', confidence: map.confidence, toleranceM: toleranceForEstimatedDepth(mean) };
    }
    return this.fallback ? this.fallback.sample(width, height, pose, fovY, aspect) : null;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
    this.map = undefined;
    this.fallback?.dispose();
  }
}

function rotationBetween(a: Pose, b: Pose): number {
  const fa = quatRotateVec3(a.rotation, { x: 0, y: 0, z: -1 });
  const fb = quatRotateVec3(b.rotation, { x: 0, y: 0, z: -1 });
  const dot = Math.max(-1, Math.min(1, fa.x * fb.x + fa.y * fb.y + fa.z * fb.z));
  return Math.acos(dot);
}
