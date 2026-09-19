/**
 * One unprojection for everything that turns a depth pixel into a world
 * point: the RANSAC point cloud (surfaces/depth-surfaces.ts) unprojects in
 * CAMERA space and applies the frame transform it derived from the dominant
 * plane (`lastFrame`); picking must do exactly the same, or a pick lands
 * above the very plane the estimator just fitted (owner report: bed top at
 * y = 0.17, pick at y = 0.83).
 */
import type { Pose, Quat, Vec3 } from '@/core/types';
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
