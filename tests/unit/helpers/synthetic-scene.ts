/**
 * The synthetic RGB-D scene shared by the camera unit test
 * (camera-synthetic-scene.test.ts) and the camera e2e spec
 * (tests/e2e/camera-capture.spec.ts): a camera at 1.1 m pitched down 0.35 rad
 * sees a floor (y = 0), a wall at z = WALL_Z, and optionally a 0.3 m box at
 * (0.2, 0..0.3, -2.0). Depth is metres along the camera forward axis.
 */
import { StaticPoseSource } from '@/camera/pose/static';
import { fillFloorDepth } from '@/camera/depth/prior';
import { pixelToRay } from '@/camera/surfaces/floor-prior';
import { quatRotateVec3 } from '@/core/math';
import type { DepthMap } from '@/camera/contract';

export const SCENE_W = 320;
export const SCENE_H = 240;
export const SCENE_FOV = (50 * Math.PI) / 180;
export const WALL_Z = -3.5;
export const BOX = { min: { x: 0.05, y: 0, z: -2.15 }, max: { x: 0.35, y: 0.3, z: -1.85 } };

function rayBoxDepth(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < BOX.min[axis] || o > BOX.max[axis]) return null;
      continue;
    }
    const t1 = (BOX.min[axis] - o) / d;
    const t2 = (BOX.max[axis] - o) / d;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  const t = tMin >= 0 ? tMin : tMax;
  return t * (dir.x * fwd.x + dir.y * fwd.y + dir.z * fwd.z);
}

export function syntheticSceneDepth(withBox: boolean, timestamp = 1000): DepthMap & { boxPixels: number } {
  const W = SCENE_W;
  const H = SCENE_H;
  const pose = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: -0.35 }).pose;
  const metric = new Float32Array(W * H);
  fillFloorDepth(metric, W, H, pose, SCENE_FOV, W / H);
  const fwd = quatRotateVec3(pose.rotation, { x: 0, y: 0, z: -1 });
  // Pixels that miss the floor see the wall.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (metric[i] !== 0) continue;
      const ray = pixelToRay(x + 0.5, y + 0.5, W, H, pose, SCENE_FOV, W / H);
      const t = ray.direction.z < -1e-6 ? (WALL_Z - ray.origin.z) / ray.direction.z : -1;
      metric[i] = t > 0 ? t * (ray.direction.x * fwd.x + ray.direction.y * fwd.y + ray.direction.z * fwd.z) : 6;
    }
  }
  let boxPixels = 0;
  if (withBox) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ray = pixelToRay(x + 0.5, y + 0.5, W, H, pose, SCENE_FOV, W / H);
        const d = rayBoxDepth(ray.origin, ray.direction, fwd);
        if (d !== null && d < (metric[y * W + x] as number)) {
          metric[y * W + x] = d;
          boxPixels += 1;
        }
      }
    }
  }
  return { width: W, height: H, metric, confidence: 0.9, source: 'monocular', pose, fovY: SCENE_FOV, aspect: W / H, timestamp, boxPixels };
}
