/**
 * Tiny software rasterizer for capture pipeline tests: given a camera pose
 * and a list of axis-aligned colored boxes, ray-casts each pixel (slab test)
 * to produce an RGBA + depth CameraFrame. No DOM, no three.js.
 */
import type { Aabb, Pose, Vec3 } from '@/core/types';
import { normalize, quatConjugate, quatRotateVec3, sub } from '@/core/math';
import type { CameraFrame } from '@/capture/contract';

export interface ColoredBox {
  aabb: Aabb;
  color: [number, number, number];
}

const BACKGROUND: [number, number, number] = [30, 30, 30];

function intersectBox(origin: Vec3, dir: Vec3, box: Aabb): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;

  const axes: (keyof Vec3)[] = ['x', 'y', 'z'];
  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
}

export function renderSyntheticFrame(
  pose: Pose,
  fovY: number,
  aspect: number,
  width: number,
  height: number,
  boxes: ColoredBox[],
  timestamp = 0,
): CameraFrame {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height);
  const tanHalf = Math.tan(fovY / 2);
  const invRot = quatConjugate(pose.rotation);

  for (let py = 0; py < height; py++) {
    const ndcY = 1 - ((py + 0.5) / height) * 2;
    for (let px = 0; px < width; px++) {
      const ndcX = ((px + 0.5) / width) * 2 - 1;
      const localDir = normalize({ x: ndcX * tanHalf * aspect, y: ndcY * tanHalf, z: -1 });
      const worldDir = quatRotateVec3(pose.rotation, localDir);

      let bestT = Infinity;
      let bestColor: [number, number, number] | null = null;

      for (const box of boxes) {
        const t = intersectBox(pose.position, worldDir, box.aabb);
        if (t !== null && t < bestT) {
          bestT = t;
          bestColor = box.color;
        }
      }

      const idx = (py * width + px) * 4;
      if (bestColor) {
        const hitWorld: Vec3 = {
          x: pose.position.x + worldDir.x * bestT,
          y: pose.position.y + worldDir.y * bestT,
          z: pose.position.z + worldDir.z * bestT,
        };
        const local = quatRotateVec3(invRot, sub(hitWorld, pose.position));
        const zDepth = -local.z;

        rgba[idx] = bestColor[0];
        rgba[idx + 1] = bestColor[1];
        rgba[idx + 2] = bestColor[2];
        rgba[idx + 3] = 255;
        depth[py * width + px] = zDepth;
      } else {
        rgba[idx] = BACKGROUND[0];
        rgba[idx + 1] = BACKGROUND[1];
        rgba[idx + 2] = BACKGROUND[2];
        rgba[idx + 3] = 255;
        depth[py * width + px] = Infinity;
      }
    }
  }

  return { width, height, rgba, depth, pose, fovY, aspect, timestamp };
}

/** A CameraFrameSource that yields one synthetic frame per pose in order. */
export function makeSequentialSource(
  poses: Pose[],
  fovY: number,
  aspect: number,
  width: number,
  height: number,
  boxes: ColoredBox[],
): { available: true; capture: () => Promise<CameraFrame | null> } {
  let i = 0;
  return {
    available: true,
    async capture() {
      if (i >= poses.length) return null;
      const pose = poses[i];
      i += 1;
      if (!pose) return null;
      return renderSyntheticFrame(pose, fovY, aspect, width, height, boxes, i);
    },
  };
}

export function makeUnavailableSource(): { available: false; capture: () => Promise<CameraFrame | null> } {
  return { available: false, async capture() { return null; } };
}
