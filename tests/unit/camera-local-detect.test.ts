/**
 * Click-to-detect (surfaces/local-detect.ts): a synthetic depth map of a level camera
 * 0.75 m above a desk plane (y = 0) with a 10 x 15 x 10 cm box standing on it at z = -3.
 */
import { describe, expect, it } from 'vitest';
import type { Surface } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { unprojectPixel } from '@/capture/geom';
import type { DepthMap } from '@/camera/contract';
import { detectVolumeAtPixel, supportTopAt } from '@/camera/surfaces/local-detect';

const W = 320;
const H = 180;
const FOVY = 1.0;
const CAM_Y = 0.75;
// 3 m ahead so the box is inside the level camera's 57-degree vertical field of view.
const BOX = { min: { x: -0.05, y: 0, z: -3.05 }, max: { x: 0.05, y: 0.15, z: -2.95 } };

function rayBox(dir: { x: number; y: number; z: number }, origin: { x: number; y: number; z: number }): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = dir[axis];
    const o = origin[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < BOX.min[axis] || o > BOX.max[axis]) return null;
      continue;
    }
    let t0 = (BOX.min[axis] - o) / d;
    let t1 = (BOX.max[axis] - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMin > tMax) return null;
  }
  return tMin >= 0 ? tMin : null;
}

function buildMap(): DepthMap {
  const pose = { position: { x: 0, y: CAM_Y, z: 0 }, rotation: { ...IDENTITY_QUAT } };
  const metric = new Float32Array(W * H);
  const camSpace = { position: { x: 0, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Direction of the pixel ray at forward depth 1 (camera space, -z forward).
      const dir = unprojectPixel(x + 0.5, y + 0.5, 1, camSpace, FOVY, W / H, W, H);
      const origin = { x: 0, y: CAM_Y, z: 0 };
      let t: number | null = null;
      if (dir.y < 0) t = -CAM_Y / dir.y; // desk plane y = 0 (world), forward depth = t
      const tb = rayBox(dir, origin);
      if (tb !== null && (t === null || tb < t)) t = tb;
      metric[y * W + x] = t !== null && t < 8 ? t : 0;
    }
  }
  return { width: W, height: H, metric, confidence: 1, source: 'zed-sdk', pose, fovY: FOVY, aspect: W / H, timestamp: 1 };
}

const desk: Surface = {
  id: 'desk',
  label: 'floor',
  orientation: 'horizontal',
  pose: { position: { x: 0, y: 0, z: -2 }, rotation: { ...IDENTITY_QUAT } },
  polygon: [],
  aabb: { min: { x: -3, y: -0.01, z: -6 }, max: { x: 3, y: 0, z: 0 } },
  lastChangedTime: 0,
} as unknown as Surface;

function pixelOf(map: DepthMap, world: { x: number; y: number; z: number }): { px: number; py: number } {
  // Level camera at (0, CAM_Y, 0): project a world point back to the pixel grid.
  const zc = -world.z;
  const tanHalf = Math.tan(FOVY / 2);
  const ndcX = world.x / zc / (tanHalf * map.aspect);
  const ndcY = (world.y - CAM_Y) / zc / tanHalf;
  return { px: Math.floor(((ndcX + 1) / 2) * map.width), py: Math.floor(((1 - ndcY) / 2) * map.height) };
}

describe('detectVolumeAtPixel', () => {
  const map = buildMap();

  it('grows the box standing on the desk from a click on its front face', () => {
    const { px, py } = pixelOf(map, { x: 0, y: 0.08, z: -2.95 });
    expect(map.metric[py * W + px]).toBeCloseTo(2.95, 1);
    const vol = detectVolumeAtPixel(map, px, py, null, [desk], { id: 'tap' });
    expect(vol).not.toBeNull();
    expect(vol!.halfExtents.x).toBeGreaterThan(0.035);
    expect(vol!.halfExtents.x).toBeLessThan(0.07);
    expect(vol!.halfExtents.y).toBeGreaterThan(0.06);
    expect(vol!.halfExtents.y).toBeLessThan(0.09);
    // Stands on the desk: bottom at y = 0.
    expect(vol!.pose.position.y - vol!.halfExtents.y).toBeCloseTo(0, 2);
  });

  it('finds the box from a click on the desk right next to it, and nothing far away', () => {
    const near = pixelOf(map, { x: 0.06, y: 0, z: -2.95 });
    const vol = detectVolumeAtPixel(map, near.px, near.py, null, [desk], { id: 'tap' });
    expect(vol).not.toBeNull();
    const far = pixelOf(map, { x: 0.8, y: 0, z: -4 });
    expect(detectVolumeAtPixel(map, far.px, far.py, null, [desk], { id: 'tap' })).toBeNull();
  });

  it('supportTopAt picks the highest surface under the point', () => {
    const table = { ...desk, id: 't', label: 'table', aabb: { min: { x: -1, y: 0.49, z: -2 }, max: { x: 1, y: 0.5, z: -0.5 } } } as unknown as Surface;
    expect(supportTopAt([desk, table], { x: 0, y: 0.6, z: -1 }).y).toBeCloseTo(0.5, 6);
    expect(supportTopAt([desk, table], { x: 0, y: 0.1, z: -1 }).y).toBeCloseTo(0, 6);
  });
});
