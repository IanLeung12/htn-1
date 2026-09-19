/**
 * Owner bug 1: the model estimator stopped publishing once the ground-anchored
 * fit failed (camera looking level, floor out of frame). It must keep
 * publishing with a fallback scale and a lower confidence.
 */
import { describe, expect, it } from 'vitest';
import { fitInverseDepthBand } from '@/camera/depth/fit';
import { mergeHorizontalPlanes, type PlaneFit } from '@/camera/surfaces/ransac';

describe('depth scale fallbacks', () => {
  it('band anchor gives a positive scale with zero shift', () => {
    const w = 32;
    const h = 24;
    const inverse = new Float32Array(w * h).fill(0.5);
    for (let y = h - 5; y < h; y++) for (let x = 0; x < w; x++) inverse[y * w + x] = 1.0; // nearer at the bottom
    const fit = fitInverseDepthBand(inverse, w, h, 2.0);
    expect(fit).not.toBeNull();
    expect(fit!.b).toBe(0);
    expect(fit!.a).toBeCloseTo(2.0, 6); // median 1.0 * 2 m
    expect(fitInverseDepthBand(new Float32Array(w * h), w, h, 2.0)).toBeNull();
  });
});

function fit(y: number, xmin: number, xmax: number, n: number): PlaneFit {
  return {
    normal: { x: 0, y: 1, z: 0 },
    d: -y,
    inliers: new Uint32Array(n),
    inlierFraction: n / 1000,
    centroid: { x: (xmin + xmax) / 2, y, z: -2 },
    extentMin: { x: xmin, y, z: -2.5 },
    extentMax: { x: xmax, y, z: -1.5 },
  };
}

describe('mergeHorizontalPlanes', () => {
  it('merges layered fits of one surface and keeps distinct ones', () => {
    const merged = mergeHorizontalPlanes([fit(0.13, -1, 1, 500), fit(0.16, -0.8, 1.2, 300), fit(0.26, -1, 1, 200), fit(0.75, 0, 1, 400), fit(0.2, 3, 4, 100)], 0.1);
    // 0.13/0.16 collapse (0.26 is 0.12 above their merged centroid); 0.75 and the far 0.2 stay.
    expect(merged.length).toBe(4);
    expect(merged[0]!.inliers.length).toBe(800);
    expect(merged[0]!.centroid.y).toBeCloseTo((0.13 * 500 + 0.16 * 300) / 800, 6);
    expect(merged.map((m) => m.centroid.y)).toEqual([...merged.map((m) => m.centroid.y)].sort((a, b) => a - b));
  });
});
