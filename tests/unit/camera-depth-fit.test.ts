import { describe, expect, it } from 'vitest';
import { fitConfidence, fitInverseDepthToFloor, inverseToMetric, resampleDepth } from '@/camera/depth/fit';
import { fillFloorDepth, PlanePriorDepthEstimator, toleranceForEstimatedDepth } from '@/camera/depth/prior';
import { StaticPoseSource } from '@/camera/pose/static';

const W = 64;
const H = 48;
const FOV = (50 * Math.PI) / 180;

function floorScene(): { floor: Float32Array; hits: number } {
  const pose = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: -0.35 }).pose;
  const floor = new Float32Array(W * H);
  const hits = fillFloorDepth(floor, W, H, pose, FOV, W / H);
  return { floor, hits };
}

describe('plane-prior depth', () => {
  it('sees the floor only below the horizon and depth grows toward the horizon', () => {
    const { floor, hits } = floorScene();
    expect(hits).toBeGreaterThan((W * H) / 3);
    expect(hits).toBeLessThan(W * H);
    // Bottom row is nearest, rows above are farther, top rows miss the floor.
    const bottom = floor[(H - 1) * W + W / 2] as number;
    const mid = floor[Math.floor(H * 0.75) * W + W / 2] as number;
    expect(bottom).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(bottom);
    expect(floor[W / 2]).toBe(0);
  });

  it('estimator submits and samples analytic depth tagged plane-prior with a widened tolerance', () => {
    const est = new PlanePriorDepthEstimator();
    const pose = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: -0.35 }).pose;
    const ok = est.submit({ width: W, height: H, rgba: new Uint8ClampedArray(W * H * 4), timestamp: 1 }, pose, { fovY: FOV, aspect: W / H, width: W, height: H });
    expect(ok).toBe(true);
    expect(est.latest?.source).toBe('plane-prior');
    const sample = est.sample(32, 24, pose, FOV, 32 / 24);
    expect(sample?.source).toBe('plane-prior');
    expect(sample!.toleranceM).toBeGreaterThanOrEqual(0.05);
    expect(toleranceForEstimatedDepth(3)).toBeCloseTo(0.24, 6);
    expect(toleranceForEstimatedDepth(0.2)).toBe(0.05);
  });
});

describe('inverse depth metric fit', () => {
  it('recovers scale and shift of synthetic affine inverse depth, ignoring an object outlier', () => {
    const { floor } = floorScene();
    const a = 2.5;
    const b = 0.3;
    const inverse = new Float32Array(W * H);
    for (let i = 0; i < inverse.length; i++) {
      const z = floor[i] as number;
      const trueZ = z > 0 ? z : 6; // wall/ceiling above the horizon
      inverse[i] = a / trueZ + b;
    }
    // A box standing on the floor: pixels in the lower-middle report a nearer depth than the floor.
    for (let y = Math.floor(H * 0.6); y < Math.floor(H * 0.8); y++) {
      for (let x = Math.floor(W * 0.4); x < Math.floor(W * 0.55); x++) {
        inverse[y * W + x] = a / 1.2 + b;
      }
    }
    const fit = fitInverseDepthToFloor(inverse, floor, { stride: 1 });
    expect(fit).not.toBeNull();
    expect(fit!.a).toBeCloseTo(a, 1);
    expect(fit!.b).toBeCloseTo(b, 1);
    expect(fit!.inlierFraction).toBeGreaterThan(0.8);

    const metric = new Float32Array(W * H);
    inverseToMetric(inverse, fit!, metric);
    // Floor pixels come back at their analytic depth; the box comes back at ~1.2 m.
    const i = (H - 2) * W + 3;
    expect(metric[i]).toBeCloseTo(floor[i] as number, 2);
    expect(metric[Math.floor(H * 0.7) * W + Math.floor(W * 0.45)]).toBeCloseTo(1.2, 1);
    const conf = fitConfidence(fit!, 1);
    expect(conf).toBeGreaterThan(0.5);
    expect(conf).toBeLessThanOrEqual(1);
  });

  it('returns null without enough floor samples', () => {
    const inverse = new Float32Array(W * H).fill(1);
    const floor = new Float32Array(W * H); // no floor anywhere
    expect(fitInverseDepthToFloor(inverse, floor)).toBeNull();
  });

  it('resamples nearest-neighbour preserving corner values', () => {
    const src = new Float32Array([1, 2, 3, 4]);
    const out = resampleDepth(src, 2, 2, 4, 4);
    expect(out[0]).toBe(1);
    expect(out[3]).toBe(2);
    expect(out[12]).toBe(3);
    expect(out[15]).toBe(4);
  });
});
