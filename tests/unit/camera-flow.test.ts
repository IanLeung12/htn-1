import { describe, expect, it } from 'vitest';
import { detectCorners, rotationFromFlow, summarizeFlow, trackLK } from '@/camera/pose/flow';
import { quatFromAxisAngle, quatRotateVec3 } from '@/core/math';
import { cropWorld, makeSyntheticWorld } from './helpers/syntheticTexture';

const WIDTH = 160;
const HEIGHT = 120;
const PAD = 16;

// A big textured "world" buffer; frame0/frame1 are exact-pixel crops of it,
// so a crop offset by (dx, dy) is a pixel-perfect ground-truth translation -
// the recovered flow can be checked against an exact expected value rather
// than merely "roughly right".
const world = makeSyntheticWorld(WIDTH + 2 * PAD, HEIGHT + 2 * PAD, 1234);
const frame0 = cropWorld(world, PAD, PAD, WIDTH, HEIGHT);

const SHIFT_DX = 3;
const SHIFT_DY = -2;
// Content translated by (SHIFT_DX, SHIFT_DY): frame1(x,y) = frame0(x - dx, y - dy),
// i.e. crop the world window offset by (-dx, -dy) relative to frame0's window.
const frame1 = cropWorld(world, PAD - SHIFT_DX, PAD - SHIFT_DY, WIDTH, HEIGHT);

describe('detectCorners', () => {
  it('finds >= 30 corners spread over >= 20 grid cells', () => {
    const corners = detectCorners(frame0, WIDTH, HEIGHT);
    const count = corners.length / 2;
    expect(count).toBeGreaterThanOrEqual(30);

    const cells = new Set<string>();
    for (let i = 0; i < count; i++) {
      const x = corners[i * 2]!;
      const y = corners[i * 2 + 1]!;
      cells.add(`${Math.floor(x / 16)},${Math.floor(y / 16)}`);
    }
    expect(cells.size).toBeGreaterThanOrEqual(20);
  });
});

describe('trackLK', () => {
  it('recovers the known (3, -2) px translation for >= 80% of corners', () => {
    const corners = detectCorners(frame0, WIDTH, HEIGHT);
    const count = corners.length / 2;
    const { flow, status } = trackLK(frame0, frame1, WIDTH, HEIGHT, corners);

    let good = 0;
    for (let i = 0; i < count; i++) {
      if (status[i] !== 1) continue;
      const dx = flow[i * 2]!;
      const dy = flow[i * 2 + 1]!;
      if (Math.abs(dx - SHIFT_DX) < 0.3 && Math.abs(dy - SHIFT_DY) < 0.3) good++;
    }
    expect(good / count).toBeGreaterThanOrEqual(0.8);
  });

  it('summarizeFlow reports the expected median magnitude', () => {
    const corners = detectCorners(frame0, WIDTH, HEIGHT);
    const { flow, status } = trackLK(frame0, frame1, WIDTH, HEIGHT, corners);
    const summary = summarizeFlow(flow, status);
    const expectedMagnitude = Math.hypot(SHIFT_DX, SHIFT_DY); // sqrt(9+4) ~= 3.6056
    expect(summary.medianMagnitudePx).toBeCloseTo(expectedMagnitude, 0);
    expect(Math.abs(summary.medianMagnitudePx - expectedMagnitude)).toBeLessThan(0.3);
    expect(summary.meanDx).toBeCloseTo(SHIFT_DX, 0);
    expect(summary.meanDy).toBeCloseTo(SHIFT_DY, 0);
    expect(summary.coherence).toBeGreaterThan(0.8);
  });

  it('a static pair (same image) yields near-zero median flow magnitude', () => {
    const corners = detectCorners(frame0, WIDTH, HEIGHT);
    const { flow, status } = trackLK(frame0, frame0, WIDTH, HEIGHT, corners);
    const summary = summarizeFlow(flow, status);
    expect(summary.medianMagnitudePx).toBeLessThan(0.2);
  });
});

describe('rotationFromFlow sign convention', () => {
  // Verified numerically against src/capture/geom.ts's projectPoint (pinhole
  // model: camera looks down local -Z, +Y up, pixel y=0 is the top row):
  // rotating the camera by quatFromAxisAngle({x:0,y:1,z:0}, yawRad) - the
  // SAME positive-yaw convention StaticPoseSource/OrientationPoseSource use
  // - moves a fixed world point's pixel x by *+yawRad*focalPx* (to first
  // order). So rotationFromFlow needs no extra sign flip: yawRad =
  // meanDx / focalPx directly recovers the yaw that was actually applied
  // via quatFromAxisAngle(+Y, yawRad).
  //
  // One consequence: content flowing LEFT (negative meanDx) yields a
  // NEGATIVE yawRad here. Plugged back into quatFromAxisAngle({x:0,y:1,z:0},
  // yawRad), a negative yawRad rotates the camera's forward vector (which
  // starts at -Z) towards +X - i.e. it is the yaw a real rightward pan of
  // the camera would need (a pan right swings the heading towards +X and
  // makes a fixed point in front of the camera slide left across the
  // frame). That is what this test asserts.
  it('content flowing left (dx < 0) yields a negative yaw that rotates the forward vector toward +X', () => {
    const focalPx = 100;
    const summary = { tracked: 50, total: 50, meanDx: -5, meanDy: 0, medianMagnitudePx: 5, coherence: 1 };
    const { yawRad } = rotationFromFlow(summary, focalPx);

    expect(yawRad).toBeLessThan(0);
    expect(yawRad).toBeCloseTo(-0.05, 5);

    const rotated = quatRotateVec3(quatFromAxisAngle({ x: 0, y: 1, z: 0 }, yawRad), { x: 0, y: 0, z: -1 });
    expect(rotated.x).toBeGreaterThan(0);
  });

  it('content flowing up (dy < 0) yields a negative pitch (looking down)', () => {
    const focalPx = 100;
    const summary = { tracked: 50, total: 50, meanDx: 0, meanDy: -4, medianMagnitudePx: 4, coherence: 1 };
    const { pitchRad } = rotationFromFlow(summary, focalPx);

    expect(pitchRad).toBeLessThan(0);
    const rotated = quatRotateVec3(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitchRad), { x: 0, y: 0, z: -1 });
    expect(rotated.y).toBeLessThan(0);
  });
});
