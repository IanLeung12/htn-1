import { describe, expect, it } from 'vitest';
import { fitInverseDepthToAnchors, inverseToMetric, sampleInverseMedian } from '@/camera/depth/fit';
import { DepthSurfaceEstimator } from '@/camera/surfaces/depth-surfaces';
import type { DepthMap } from '@/camera/contract';
import { StaticPoseSource } from '@/camera/pose/static';
import { fillFloorDepth } from '@/camera/depth/prior';

describe('two-point metric calibration', () => {
  it('recovers scale and shift from a near and a far anchor', () => {
    const w = 64;
    const h = 48;
    const a = 3.1;
    const b = 0.4;
    const trueZ = new Float32Array(w * h);
    const inverse = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const z = 0.5 + (4.5 * (h - 1 - y)) / (h - 1); // near at the bottom, far at the top
        trueZ[y * w + x] = z;
        inverse[y * w + x] = a / z + b;
      }
    }
    const near = { u: 0.5, v: 0.95, metres: trueZ[Math.floor(0.95 * h) * w + w / 2] as number };
    const far = { u: 0.5, v: 0.05, metres: trueZ[Math.floor(0.05 * h) * w + w / 2] as number };
    const fit = fitInverseDepthToAnchors(inverse, w, h, near, far)!;
    expect(fit).not.toBeNull();
    expect(fit.a).toBeCloseTo(a, 3);
    expect(fit.b).toBeCloseTo(b, 3);
    const metric = new Float32Array(w * h);
    inverseToMetric(inverse, fit, metric);
    for (let i = 0; i < metric.length; i += 97) expect(Math.abs((metric[i] as number) - (trueZ[i] as number))).toBeLessThan(0.01);
    expect(sampleInverseMedian(inverse, w, h, 0.5, 0.5)).toBeGreaterThan(0);
    expect(fitInverseDepthToAnchors(inverse, w, h, near, { ...far, metres: near.metres })).toBeNull();
  });
});

describe('ground anchor plane', () => {
  it('prefers the plane reaching lowest in the image over a larger one behind it', () => {
    // A camera 0.45 m above a desk (near, bottom of frame) looking level at a big bed top 0.3 m
    // below the desk further away: the desk must be the ground, not the (larger) bed.
    const W = 320;
    const H = 240;
    const fov = (50 * Math.PI) / 180;
    const pose = new StaticPoseSource({ cameraHeightM: 0.45, pitchRad: -0.15 }).pose;
    const desk = new Float32Array(W * H);
    fillFloorDepth(desk, W, H, pose, fov, W / H, 0);
    const bed = new Float32Array(W * H);
    fillFloorDepth(bed, W, H, pose, fov, W / H, -0.3);
    const metric = new Float32Array(W * H);
    for (let i = 0; i < metric.length; i++) {
      const d = desk[i] as number;
      const bd = bed[i] as number;
      // Desk ends 1.2 m out; beyond it the ray continues to the bed plane; above the horizon a far wall.
      metric[i] = d > 0 && d < 1.3 ? d : bd > 0 ? bd : 6;
    }
    const map: DepthMap = { width: W, height: H, metric, confidence: 0.9, source: 'monocular', pose, fovY: fov, aspect: W / H, timestamp: 1 };
    const est = new DepthSurfaceEstimator({ cameraHeightM: 0.45 });
    est.update(map, pose, 5000);
    expect(est.correction).not.toBeNull();
    // The desk band is a thin strip at the bottom of the frame; a few cm of height error is expected, the bed (0.75) is not.
    expect(Math.abs(est.correction!.heightM - 0.45)).toBeLessThan(0.1);
    const table = est.surfaces.find((s) => s.surface.label === 'table');
    expect(table).toBeDefined();
    expect(table!.surface.pose.position.y).toBeLessThan(-0.2);
  });
});
