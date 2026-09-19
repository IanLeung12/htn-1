/**
 * Pointer ray through a pinhole camera at `pose` (pure TS; what
 * src/camera/app.ts's `rayFromNdc` computes with the three.js camera, for
 * unit tests and non-DOM callers). NDC x/y in -1..1 with y up; `fovY` is the
 * vertical field of view (rad) and `aspect` the viewport width/height the
 * NDC refers to.
 */
import type { Pose, Vec3 } from '@/core/types';
import { quatRotateVec3 } from '@/core/math';

export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

export function pointerRayFromPose(pose: Pose, fovY: number, aspect: number, ndcX: number, ndcY: number, out: Ray = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }): Ray {
  const tanHalf = Math.tan(fovY / 2);
  const local = { x: ndcX * tanHalf * aspect, y: ndcY * tanHalf, z: -1 };
  const d = quatRotateVec3(pose.rotation, local);
  const n = Math.hypot(d.x, d.y, d.z) || 1;
  out.origin.x = pose.position.x;
  out.origin.y = pose.position.y;
  out.origin.z = pose.position.z;
  out.direction.x = d.x / n;
  out.direction.y = d.y / n;
  out.direction.z = d.z / n;
  return out;
}

/** Angle (rad) between two directions. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a.x, a.y, a.z) || 1;
  const lb = Math.hypot(b.x, b.y, b.z) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb))));
}
