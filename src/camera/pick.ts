/**
 * One unprojection for everything that turns a depth pixel into a world
 * point: the RANSAC point cloud (surfaces/depth-surfaces.ts) unprojects in
 * CAMERA space and applies the frame transform it derived from the dominant
 * plane (`lastFrame`); picking must do exactly the same, or a pick lands
 * above the very plane the estimator just fitted (owner report: bed top at
 * y = 0.17, pick at y = 0.83).
 */
import type { Pose, Quat, Surface, Vec3 } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { quatRotateVec3 } from '@/core/math';
import { unprojectPixel } from '@/capture/geom';
import type { DepthMap } from './contract';

export interface WorldFrame {
  rotation: Quat;
  position: Vec3;
}

const CAMERA_SPACE: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } };

/**
 * World point of depth pixel (px, py) of `map`, using `frame` (the
 * estimator's camera->world transform for that map) or, when none exists
 * yet, the pose the map was taken from. Null where the map has no depth.
 */
export function pickFromMap(map: DepthMap, px: number, py: number, frame: WorldFrame | null): Vec3 | null {
  const x = Math.min(map.width - 1, Math.max(0, Math.floor(px)));
  const y = Math.min(map.height - 1, Math.max(0, Math.floor(py)));
  const d = map.metric[y * map.width + x] as number;
  if (!(d > 0)) return null;
  const local = unprojectPixel(x + 0.5, y + 0.5, d, CAMERA_SPACE, map.fovY, map.aspect, map.width, map.height);
  const f = frame ?? { rotation: map.pose.rotation, position: map.pose.position };
  const r = quatRotateVec3(f.rotation, local);
  return { x: r.x + f.position.x, y: r.y + f.position.y, z: r.z + f.position.z };
}

/** Median-of-patch pick (monocular depth is noisy per pixel). */
export function pickFromMapRobust(map: DepthMap, px: number, py: number, frame: WorldFrame | null, radius = 2): Vec3 | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const p = pickFromMap(map, px + dx, py + dy, frame);
      if (!p) continue;
      xs.push(p.x);
      ys.push(p.y);
      zs.push(p.z);
    }
  }
  if (xs.length === 0) return null;
  const med = (a: number[]): number => {
    a.sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)] as number;
  };
  return { x: med(xs), y: med(ys), z: med(zs) };
}

/** Nearest pixel with depth within `maxRadius` (square rings outward, closest by Euclidean distance within a ring), or null. */
export function nearestValidDepth(map: DepthMap, px: number, py: number, maxRadius = 24): { x: number; y: number; depth: number; distancePx: number } | null {
  const cx = Math.min(map.width - 1, Math.max(0, Math.floor(px)));
  const cy = Math.min(map.height - 1, Math.max(0, Math.floor(py)));
  for (let r = 0; r <= maxRadius; r++) {
    let best: { x: number; y: number; depth: number; distancePx: number } | null = null;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= map.height) continue;
      const step = Math.abs(dy) === r || r === 0 ? 1 : 2 * r;
      for (let dx = -r; dx <= r; dx += step) {
        const x = cx + dx;
        if (x < 0 || x >= map.width) continue;
        const d = map.metric[y * map.width + x] as number;
        if (!(d > 0)) continue;
        const dist = Math.hypot(dx, dy);
        if (!best || dist < best.distancePx) best = { x, y, depth: d, distancePx: dist };
      }
    }
    if (best) return best;
  }
  return null;
}

export interface PickResult {
  point: Vec3;
  /** 1 = depth under the pixel; 0.5 = ray/surface intersection near the nearest valid depth. */
  confidence: number;
  mode: 'depth' | 'surface';
}

/** Ray through pixel (px, py) in the world frame `frame` (or the map's pose); the direction has unit forward depth. */
export function pixelRay(map: DepthMap, px: number, py: number, frame: WorldFrame | null): { origin: Vec3; direction: Vec3 } {
  const local = unprojectPixel(px + 0.5, py + 0.5, 1, CAMERA_SPACE, map.fovY, map.aspect, map.width, map.height);
  const f = frame ?? { rotation: map.pose.rotation, position: map.pose.position };
  return { origin: { ...f.position }, direction: quatRotateVec3(f.rotation, local) };
}

/**
 * Pick on a textureless hole: the nearest valid depth within `maxRadius` px says roughly
 * how far the surface is; if a fitted horizontal surface intersects the pixel ray within
 * `tolM` of that depth (and inside its footprint, padded by `padM`), the intersection is
 * the pick, with confidence 0.5. Null when the hole is larger than the search or no
 * surface fits.
 */
export function pickOnSurfaceThroughHole(map: DepthMap, px: number, py: number, frame: WorldFrame | null, surfaces: readonly Surface[], maxRadius = 24, tolM = 0.05, padM = 0.3): PickResult | null {
  const near = nearestValidDepth(map, px, py, maxRadius);
  if (!near) return null;
  const ray = pixelRay(map, px, py, frame);
  let best: { point: Vec3; err: number } | null = null;
  for (const s of surfaces) {
    if (s.orientation !== 'horizontal') continue;
    const planeY = s.aabb.max.y;
    if (Math.abs(ray.direction.y) < 1e-6) continue;
    const t = (planeY - ray.origin.y) / ray.direction.y;
    if (!(t > 0)) continue;
    const err = Math.abs(t - near.depth);
    if (err > tolM) continue;
    const hit = { x: ray.origin.x + ray.direction.x * t, y: planeY, z: ray.origin.z + ray.direction.z * t };
    if (hit.x < s.aabb.min.x - padM || hit.x > s.aabb.max.x + padM || hit.z < s.aabb.min.z - padM || hit.z > s.aabb.max.z + padM) continue;
    if (!best || err < best.err) best = { point: hit, err };
  }
  return best ? { point: best.point, confidence: 0.5, mode: 'surface' } : null;
}
