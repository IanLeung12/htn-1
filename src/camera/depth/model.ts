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
import { fitConfidence, fitInverseDepthBand, fitInverseDepthToAnchors, fitInverseDepthToFloor, inverseToMetric, resampleDepth, type DepthAnchor, type InverseDepthFit } from './fit';

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
  readonly status: DepthStatus = { state: 'idle', backend: 'none', modelId: null, lastInferenceMs: 0, error: null, frames: 0, lastPublishedAt: -Infinity, fitMode: 'none' };
  private map: DepthMap | undefined = undefined;
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private readonly fallback: DepthEstimator | null;
  private readonly modelId: string;
  private readonly device: 'webgpu' | 'wasm' | 'auto';
  private readonly floorY: () => number;
  private floorScratch: Float32Array | null = null;
  private lastFit: InverseDepthFit | null = null;
  private lastFitConfidence = 0;
  /** Live adjustments (src/camera/tuning.ts): metric = fitted * scale + shift, then EMA-smoothed against the previous map. */
  adjust = { scale: 1, shiftM: 0, smoothing: 0 };
  /** Two-point metric anchors (near, far); when both are set they replace the ground-plane fit. */
  anchors: { near: DepthAnchor | null; far: DepthAnchor | null } = { near: null, far: null };
  /** Newest raw model output (relative inverse depth) for anchor sampling / diagnostics. */
  lastInverse: { data: Float32Array; width: number; height: number } | null = null;

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
    // Metric scale: never stop publishing. Anchor on the ground plane when it is in view;
    // otherwise keep the previous map's scale (temporal fit), then the last good fit, then
    // a bottom-band anchor. Each step lowers the confidence the map is tagged with.
    this.lastInverse = { data: inverse, width, height };
    let fit: InverseDepthFit | null = null;
    let mode = 'floor';
    let confidence = 0;
    let sumInv = 0;
    for (let i = 0; i < inverse.length; i++) sumInv += inverse[i] as number;
    const meanInverse = sumInv / Math.max(1, inverse.length);
    if (this.anchors.near && this.anchors.far) {
      fit = fitInverseDepthToAnchors(inverse, width, height, this.anchors.near, this.anchors.far);
      if (fit) {
        mode = 'anchors';
        confidence = 0.85;
        this.status.error = null;
      }
    }
    if (!fit && hits > 0) {
      fit = fitInverseDepthToFloor(inverse, floor);
      mode = 'floor';
    }
    if (fit && mode === 'floor') {
      confidence = fitConfidence(fit, meanInverse);
      this.status.error = null;
    } else if (!fit) {
      const prev = this.map && this.map.width === width && this.map.height === height ? this.map : null;
      if (prev) {
        fit = fitInverseDepthToFloor(inverse, prev.metric, { stride: 2 });
        mode = 'temporal';
        // Keep (capped) confidence rather than decaying it every temporal step: a level camera
        // never sees the ground again, and a geometric decay would silently disable picking.
        if (fit) confidence = Math.min(prev.confidence, 0.6);
      }
      if (!fit && this.lastFit) {
        fit = this.lastFit;
        mode = 'last-fit';
        confidence = Math.min(0.4, this.lastFitConfidence);
      }
      if (!fit) {
        // Bottom of the frame looks at the support surface: its distance from a camera at
        // height h pitched by p, given the half field of view f, is h / sin(f - p).
        const fwd = quatRotateVec3(pending.pose.rotation, { x: 0, y: 0, z: -1 });
        const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
        const down = Math.max(0.15, pending.fovY / 2 - pitch);
        const h = Math.max(0.1, pending.pose.position.y - this.floorY());
        fit = fitInverseDepthBand(inverse, width, height, h / Math.sin(down));
        mode = 'band';
        confidence = 0.3;
      }
      this.status.error = fit ? `no ground in view; scale from ${mode}` : 'metric fit failed';
    }
    if (!fit) {
      this.status.fitMode = 'none';
      return;
    }
    this.lastFit = fit;
    this.lastFitConfidence = confidence;
    this.status.fitMode = mode;
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
    this.status.frames += 1;
    this.status.lastPublishedAt = performance.now();
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
