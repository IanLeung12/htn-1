/**
 * Textureless holes in stereo depth (the bare desk): the plane-aware fill's CPU
 * reference, weighted RANSAC, picking through a hole onto a fitted surface, and
 * the stereo estimator's sample()/DepthMap having the monocular shape so the
 * pointer/pick path treats both alike.
 */
import { describe, expect, it } from 'vitest';
import { planeFillDisparity } from '@/camera/stereo/census';
import { ransacPlane } from '@/camera/surfaces/ransac';
import { nearestValidDepth, pickFromMapRobust, pickOnSurfaceThroughHole, pixelRay } from '@/camera/pick';
import { WebGL2StereoDepthEstimator } from '@/camera/stereo/stereo-depth';
import { ModelDepthEstimator } from '@/camera/depth/model';
import type { DepthMap } from '@/camera/contract';
import type { Surface } from '@/core/types';

describe('planeFillDisparity (CPU reference of the matcher final pass)', () => {
  const W = 64;
  const H = 48;
  const truth = (x: number, y: number): number => 12 + 0.15 * x - 0.05 * y;
  const field = (holes: [number, number, number, number][]): Float32Array => {
    const d = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = truth(x, y);
    for (const [x0, y0, x1, y1] of holes) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d[y * W + x] = 0;
    return d;
  };

  it('fills a small hole from the local plane with confidence 0.4, exactly on a planar field', () => {
    const d = field([[20, 20, 29, 29]]);
    const { disp, confidence } = planeFillDisparity(d, W, H);
    for (let y = 20; y < 29; y++) {
      for (let x = 20; x < 29; x++) {
        expect(Math.abs(disp[y * W + x]! - truth(x, y))).toBeLessThan(1e-3);
        expect(confidence[y * W + x]!).toBeCloseTo(0.4, 5);
      }
    }
    expect(confidence[0]).toBe(1);
  });

  it('leaves the middle of a large hole invalid (< 20% valid neighbours) and fills only its rim', () => {
    const d = field([[10, 10, 50, 40]]);
    const { disp, confidence } = planeFillDisparity(d, W, H);
    expect(disp[25 * W + 30]).toBe(0);
    expect(confidence[25 * W + 30]).toBe(0);
    // 3 px inside the edge: the 15x15 window still reaches 4 valid columns (60 of 224 = 27%).
    expect(disp[25 * W + 13]!).toBeGreaterThan(0);
    expect(Math.abs(disp[25 * W + 13]! - truth(13, 25))).toBeLessThan(1e-3);
  });

  it('refuses a neighbourhood that is not one plane (two depths across the hole)', () => {
    const d = field([[28, 20, 36, 28]]);
    for (let y = 0; y < H; y++) for (let x = 36; x < W; x++) d[y * W + x] = 40; // a near object right of the hole
    const { disp } = planeFillDisparity(d, W, H, { maxRmsPx: 2 });
    expect(disp[24 * W + 32]).toBe(0);
  });
});

describe('ransacPlane with per-point weights', () => {
  function cloud(): { points: Float32Array; weights: Float32Array } {
    const pts: number[] = [];
    const w: number[] = [];
    // Plane A (y = 0): 120 points, weight 1. Plane B (y = 0.5): 200 points, weight 0.3.
    for (let i = 0; i < 120; i++) {
      pts.push((i % 12) * 0.1, 0, -1 - Math.floor(i / 12) * 0.1);
      w.push(1);
    }
    for (let i = 0; i < 200; i++) {
      pts.push((i % 20) * 0.1, 0.5, -1 - Math.floor(i / 20) * 0.1);
      w.push(0.3);
    }
    return { points: Float32Array.from(pts), weights: Float32Array.from(w) };
  }

  it('unweighted, the larger plane wins; weighted, the trusted plane wins', () => {
    const { points, weights } = cloud();
    const plain = ransacPlane(points, { thresholdM: 0.02, iterations: 300, minInliers: 50, normalHint: { x: 0, y: 1, z: 0 }, maxNormalAngleRad: 0.3 })!;
    expect(Math.abs(plain.centroid.y - 0.5)).toBeLessThan(0.01);
    const weighted = ransacPlane(points, { thresholdM: 0.02, iterations: 300, minInliers: 50, normalHint: { x: 0, y: 1, z: 0 }, maxNormalAngleRad: 0.3, weights })!;
    expect(Math.abs(weighted.centroid.y)).toBeLessThan(0.01);
    expect(weighted.inliers.length).toBe(120);
  });
});

/** A stereo-shaped DepthMap: level camera 0.5 m above a plane at y = 0, a hole around the query pixel. */
function stereoMap(hole: { x0: number; y0: number; x1: number; y1: number } | null): DepthMap {
  const width = 64;
  const height = 64;
  const fovY = Math.PI / 2;
  const metric = new Float32Array(width * height);
  const weight = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const ndcY = 1 - (2 * (y + 0.5)) / height;
    for (let x = 0; x < width; x++) {
      if (ndcY >= 0) continue; // above the horizon: nothing (a far wall would be here)
      const depth = 0.5 / -ndcY; // ray dir y = ndcY * tan(fov/2) = ndcY; plane y = 0 at t = 0.5 / -ndcY
      const inHole = hole && x >= hole.x0 && x < hole.x1 && y >= hole.y0 && y < hole.y1;
      metric[y * width + x] = inHole ? 0 : depth;
      weight[y * width + x] = inHole ? 0 : 1;
    }
  }
  return { width, height, metric, weight, confidence: 0.6, source: 'stereo', pose: { position: { x: 0, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, fovY, aspect: 1, timestamp: 1000 };
}

const DESK: Surface = { id: 'desk', kind: 'table', orientation: 'horizontal', aabb: { min: { x: -2, y: 0, z: -4 }, max: { x: 2, y: 0, z: 0 } }, anchorId: 'room-anchor', lastChanged: 0 } as unknown as Surface;

describe('picking through a stereo hole', () => {
  it('nearestValidDepth finds the closest matched pixel and pickOnSurfaceThroughHole lands on the desk', () => {
    const map = stereoMap({ x0: 24, y0: 40, x1: 40, y1: 56 });
    expect(pickFromMapRobust(map, 32, 48, null)).toBeNull();
    const near = nearestValidDepth(map, 32, 48, 24)!;
    expect(near).not.toBeNull();
    expect(near.distancePx).toBeLessThanOrEqual(9);
    const pick = pickOnSurfaceThroughHole(map, 32, 48, null, [DESK])!;
    expect(pick).not.toBeNull();
    expect(pick.mode).toBe('surface');
    expect(pick.confidence).toBe(0.5);
    expect(Math.abs(pick.point.y)).toBeLessThan(1e-6);
    // The pixel ray at row 48 (ndcY ~ -0.52) meets y = 0 at ~0.97 m forward.
    const ray = pixelRay(map, 32, 48, null);
    expect(Math.abs(pick.point.z - ray.direction.z * 0.5 / -ray.direction.y)).toBeLessThan(1e-6);
    expect(-pick.point.z).toBeGreaterThan(0.9);
    expect(-pick.point.z).toBeLessThan(1.05);
  });

  it('gives up on a hole larger than the search radius and on a surface that is not near the depth', () => {
    const big = stereoMap({ x0: 4, y0: 33, x1: 60, y1: 64 });
    expect(pickOnSurfaceThroughHole(big, 32, 50, null, [DESK], 24)).toBeNull();
    const map = stereoMap({ x0: 24, y0: 40, x1: 40, y1: 56 });
    const shelf: Surface = { ...DESK, id: 'shelf', aabb: { min: { x: -2, y: 0.3, z: -4 }, max: { x: 2, y: 0.3, z: 0 } } };
    expect(pickOnSurfaceThroughHole(map, 32, 48, null, [shelf])).toBeNull();
  });
});

describe('stereo estimator sample()/DepthMap match the monocular shape', () => {
  it('sample() resamples the newest map like ModelDepthEstimator and reports source stereo', () => {
    const map = stereoMap(null);
    const est = new WebGL2StereoDepthEstimator({ getCalibration: () => undefined });
    (est as unknown as { map: DepthMap }).map = map;
    expect(est.latest).toBe(map);
    const s = est.sample(32, 32, map.pose, map.fovY, 1)!;
    expect(s).not.toBeNull();
    expect(s.metric.length).toBe(32 * 32);
    expect(s.source).toBe('stereo');
    expect(s.confidence).toBe(0.6);
    expect(s.toleranceM).toBeGreaterThan(0);
    // Same field set as the monocular estimator's sample (the capture pipeline reads exactly these).
    const mono = new ModelDepthEstimator({ fallback: null });
    (mono as unknown as { map: DepthMap }).map = { ...map, source: 'monocular' };
    const m = mono.sample(32, 32, map.pose, map.fovY, 1)!;
    expect(Object.keys(s).sort()).toEqual(Object.keys(m).sort());
    // A pixel-sized request (the width/height are pixels, not NDC) gives an empty grid for both.
    expect(est.sample(0.5, 0.6, map.pose, map.fovY, 1)!.metric.length).toBe(0);
    expect(mono.sample(0.5, 0.6, map.pose, map.fovY, 1)!.metric.length).toBe(0);
    // The DepthMap itself carries the same fields as a monocular map plus per-pixel weight.
    const monoKeys = ['width', 'height', 'metric', 'confidence', 'source', 'pose', 'fovY', 'aspect', 'timestamp'];
    for (const k of monoKeys) expect(k in map).toBe(true);
    expect(map.weight).toBeInstanceOf(Float32Array);
    // And the pick path reads it without knowing the source.
    expect(pickFromMapRobust(map, 32, 60, null)).not.toBeNull();
  });
});
