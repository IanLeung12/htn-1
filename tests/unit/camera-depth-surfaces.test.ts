import { describe, expect, it } from 'vitest';
import type { Pose, Vec3 } from '@/core/types';
import { StaticPoseSource } from '@/camera/pose/static';
import { fillFloorDepth } from '@/camera/depth/prior';
import { pixelToRay } from '@/camera/surfaces/floor-prior';
import type { DepthMap } from '@/camera/contract';
import { DepthSurfaceEstimator } from '@/camera/surfaces/depth-surfaces';

/** Ray/AABB slab intersection; returns the nearest positive t, or null if no hit. */
function rayAabbNearestT(origin: Vec3, dir: Vec3, box: { min: Vec3; max: Vec3 }): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes: (keyof Vec3)[] = ['x', 'y', 'z'];
  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (tmax < tmin || tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
}

/** Build a floor depth map with a box carved into it (nearer depth where the ray hits the box). */
function buildDepthMapWithBox(
  pose: Pose,
  width: number,
  height: number,
  fovY: number,
  aspect: number,
  box: { min: Vec3; max: Vec3 },
  timestamp: number,
): DepthMap {
  const metric = new Float32Array(width * height);
  fillFloorDepth(metric, width, height, pose, fovY, aspect, 0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ray = pixelToRay(x + 0.5, y + 0.5, width, height, pose, fovY, aspect);
      const t = rayAabbNearestT(ray.origin, ray.direction, box);
      if (t === null) continue;
      // t is world-space distance along the (unit) ray direction; convert to
      // the camera-forward-axis depth convention (same as floorDepthForPixel):
      // depth = t * cos(angle between ray and forward), i.e. -local.z.
      const hit: Vec3 = {
        x: ray.origin.x + ray.direction.x * t,
        y: ray.origin.y + ray.direction.y * t,
        z: ray.origin.z + ray.direction.z * t,
      };
      // Forward axis distance: project (hit - origin) onto the camera's local -Z the
      // same way unprojectPixel/projectPoint define depth. We approximate using the
      // ray's own parametrization since pixelToRay's direction is unit-length in
      // world space but not aligned with -Z; recompute via floor-style local transform.
      const rel = { x: hit.x - pose.position.x, y: hit.y - pose.position.y, z: hit.z - pose.position.z };
      // Rotate rel into camera-local space using the pose's inverse rotation.
      const q = pose.rotation;
      const qInv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
      const local = rotate(qInv, rel);
      const depth = -local.z;
      const idx = y * width + x;
      const existing = metric[idx] as number;
      if (depth > 1e-6 && (existing <= 0 || depth < existing)) {
        metric[idx] = depth;
      }
    }
  }

  return {
    width,
    height,
    metric,
    confidence: 1,
    source: 'plane-prior',
    pose,
    fovY,
    aspect,
    timestamp,
  };
}

function rotate(q: { x: number; y: number; z: number; w: number }, v: Vec3): Vec3 {
  const qv = { x: q.x, y: q.y, z: q.z };
  const uvx = qv.y * v.z - qv.z * v.y;
  const uvy = qv.z * v.x - qv.x * v.z;
  const uvz = qv.x * v.y - qv.y * v.x;
  const uuvx = qv.y * uvz - qv.z * uvy;
  const uuvy = qv.z * uvx - qv.x * uvz;
  const uuvz = qv.x * uvy - qv.y * uvx;
  return {
    x: v.x + 2 * (q.w * uvx + uuvx),
    y: v.y + 2 * (q.w * uvy + uuvy),
    z: v.z + 2 * (q.w * uvz + uuvz),
  };
}

const CAMERA_HEIGHT_M = 1.1;
const PITCH_RAD = -0.35;
const FOV_Y = Math.PI / 4;
const WIDTH = 96;
const HEIGHT = 72;
const ASPECT = WIDTH / HEIGHT;

const BOX_CENTER = { x: 0.2, y: 0.15, z: -2.0 };
const BOX_HALF = { x: 0.2, y: 0.15, z: 0.2 };
const BOX_AABB = {
  min: { x: BOX_CENTER.x - BOX_HALF.x, y: 0, z: BOX_CENTER.z - BOX_HALF.z },
  max: { x: BOX_CENTER.x + BOX_HALF.x, y: BOX_CENTER.y + BOX_HALF.y, z: BOX_CENTER.z + BOX_HALF.z },
};

describe('DepthSurfaceEstimator', () => {
  it('exposes the prior floor before any depth', () => {
    const est = new DepthSurfaceEstimator({ cameraHeightM: CAMERA_HEIGHT_M });
    expect(est.surfaces).toHaveLength(1);
    expect(est.surfaces[0]!.origin).toBe('prior');
    expect(est.surfaces[0]!.surface.label).toBe('floor');
    expect(est.volumes).toHaveLength(0);
    expect(est.cameraHeightM).toBe(CAMERA_HEIGHT_M);
  });

  it('finds the ransac floor, refines cameraHeightM, and detects the box volume', () => {
    const pose = new StaticPoseSource({ cameraHeightM: CAMERA_HEIGHT_M, pitchRad: PITCH_RAD }).pose;
    const depth = buildDepthMapWithBox(pose, WIDTH, HEIGHT, FOV_Y, ASPECT, BOX_AABB, 1000);

    const est = new DepthSurfaceEstimator({ cameraHeightM: CAMERA_HEIGHT_M, minIntervalMs: 0, stride: 1 });
    const surfacesBefore = est.surfaces;

    est.update(depth, pose, 1000);

    expect(est.surfaces[0]!.origin).toBe('ransac');
    expect(Math.abs(est.cameraHeightM - CAMERA_HEIGHT_M)).toBeLessThan(0.05);

    expect(est.volumes.length).toBeGreaterThan(0);
    const vol = est.volumes.find((v) => {
      const dx = Math.abs(v.pose.position.x - BOX_CENTER.x);
      const dz = Math.abs(v.pose.position.z - BOX_CENTER.z);
      return dx < 0.1 && dz < 0.1;
    });
    expect(vol).toBeDefined();
    expect(vol!.halfExtents.y * 2).toBeGreaterThan(0.2);
    expect(vol!.halfExtents.y * 2).toBeLessThan(0.4);

    // A second update with the SAME timestamp is a no-op: surfaces array identity unchanged.
    const surfacesAfterFirst = est.surfaces;
    const volumesAfterFirst = est.volumes;
    est.update(depth, pose, 1000);
    expect(est.surfaces).toBe(surfacesAfterFirst);
    expect(est.volumes).toBe(volumesAfterFirst);

    // Sanity: the surfaces array reference actually did change across the first update.
    expect(surfacesBefore).not.toBe(surfacesAfterFirst);
  });
});
