/**
 * Plane-prior depth: the analytic depth of the estimated floor plane seen
 * through the camera. It knows nothing about objects, so its confidence is
 * deliberately low (0.3) and frames built from it are tagged
 * `depthSource: 'plane-prior'`, which caps clean-plate tiers at C (see
 * docs/general-camera/architecture.md, truthfulness contract). It exists so
 * the capture pipeline has *some* depth to verify a support-surface plate
 * against when no model is available (and in e2e tests, which have no GPU
 * or network for the model).
 */
import type { Pose } from '@/core/types';
import type { CameraIntrinsics, DepthEstimator, DepthMap, DepthSample, DepthStatus, GrabbedFrame } from '../contract';
import { floorDepthForPixel } from '../surfaces/floor-prior';

export const PLANE_PRIOR_CONFIDENCE = 0.3;

/** Tolerance the capture pipeline should use for estimated depth at `depthM` metres. */
export function toleranceForEstimatedDepth(depthM: number, relative = 0.08, floorM = 0.05): number {
  return Math.max(floorM, relative * depthM);
}

/** Fill `out` (width*height) with the floor-plane depth per pixel; NaN-free (0 = no floor hit). */
export function fillFloorDepth(out: Float32Array, width: number, height: number, pose: Pose, fovY: number, aspect: number, floorY = 0): number {
  let hits = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = floorDepthForPixel(x + 0.5, y + 0.5, width, height, pose, fovY, aspect, floorY);
      const i = y * width + x;
      if (d === null || !(d > 0)) {
        out[i] = 0;
      } else {
        out[i] = d;
        hits += 1;
      }
    }
  }
  return hits;
}

export class PlanePriorDepthEstimator implements DepthEstimator {
  readonly status: DepthStatus = { state: 'ready', backend: 'analytic', modelId: 'floor-plane-prior', lastInferenceMs: 0, error: null };
  latest: DepthMap | undefined = undefined;

  constructor(private readonly floorY: () => number = () => 0) {}

  async start(): Promise<void> {
    this.status.state = 'ready';
  }

  submit(frame: GrabbedFrame, pose: Pose, intrinsics: CameraIntrinsics): boolean {
    const t0 = performance.now();
    const metric = new Float32Array(frame.width * frame.height);
    const aspect = frame.width / frame.height;
    fillFloorDepth(metric, frame.width, frame.height, pose, intrinsics.fovY, aspect, this.floorY());
    this.latest = {
      width: frame.width,
      height: frame.height,
      metric,
      confidence: PLANE_PRIOR_CONFIDENCE,
      source: 'plane-prior',
      pose,
      fovY: intrinsics.fovY,
      aspect,
      timestamp: frame.timestamp,
    };
    this.status.lastInferenceMs = performance.now() - t0;
    return true;
  }

  sample(width: number, height: number, pose: Pose, fovY: number, aspect: number): DepthSample | null {
    const metric = new Float32Array(width * height);
    const hits = fillFloorDepth(metric, width, height, pose, fovY, aspect, this.floorY());
    if (hits === 0) return null;
    // Tolerance for the typical floor distance in view (median of hits).
    let sum = 0;
    for (let i = 0; i < metric.length; i++) sum += metric[i] as number;
    const mean = sum / hits;
    return { metric, source: 'plane-prior', confidence: PLANE_PRIOR_CONFIDENCE, toleranceM: toleranceForEstimatedDepth(mean) };
  }

  dispose(): void {
    this.latest = undefined;
  }
}

export class NoDepthEstimator implements DepthEstimator {
  readonly status: DepthStatus = { state: 'unavailable', backend: 'none', modelId: null, lastInferenceMs: 0, error: null };
  readonly latest = undefined;
  async start(): Promise<void> {
    /* nothing to load */
  }
  submit(): boolean {
    return false;
  }
  sample(): DepthSample | null {
    return null;
  }
  dispose(): void {
    /* nothing to release */
  }
}
