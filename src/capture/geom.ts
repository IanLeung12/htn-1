/**
 * Capture-local geometry helpers: pinhole projection into a captured frame.
 * Reuses the shared vec/quat/pose helpers from @/core/math; nothing here
 * duplicates those primitives.
 */
import type { Pose, Vec3 } from '@/core/types';
import { quatConjugate, quatRotateVec3, sub } from '@/core/math';

export interface Projection {
  /** Pixel x, 0 = left edge. */
  x: number;
  /** Pixel y, 0 = top row (matches CameraFrame.rgba row order). */
  y: number;
  /** Distance along the camera's forward axis (m), > 0 means in front. */
  depth: number;
}

/**
 * Project a world-space point into a camera frame using a pinhole model.
 * The camera looks down local -Z with +Y up (WebXR convention). Returns
 * null when the point is behind the camera (depth <= 0). Points outside
 * the frame's pixel bounds are still returned so callers can distinguish
 * "behind camera" from "in view but off-frame".
 */
export function projectPoint(
  worldPoint: Vec3,
  pose: Pose,
  fovY: number,
  aspect: number,
  width: number,
  height: number,
): Projection | null {
  const invRot = quatConjugate(pose.rotation);
  const local = quatRotateVec3(invRot, sub(worldPoint, pose.position));

  const depth = -local.z;
  if (depth <= 1e-6) return null;

  const tanHalfFovY = Math.tan(fovY / 2);
  const ndcX = local.x / (depth * tanHalfFovY * aspect);
  const ndcY = local.y / (depth * tanHalfFovY);

  const x = (ndcX * 0.5 + 0.5) * width;
  const y = (1 - (ndcY * 0.5 + 0.5)) * height;

  return { x, y, depth };
}

/** True if a projected point lands within the frame's pixel bounds. */
export function inFrame(p: Projection, width: number, height: number): boolean {
  return p.x >= 0 && p.x < width && p.y >= 0 && p.y < height;
}

/** Sample RGBA at the nearest pixel (clamped), row-major top-first. */
export function sampleNearest(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const px = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const idx = (py * width + px) * 4;
  return [rgba[idx] ?? 0, rgba[idx + 1] ?? 0, rgba[idx + 2] ?? 0, rgba[idx + 3] ?? 0];
}

/** Sample depth (meters) at the nearest pixel, or undefined if out of bounds. */
export function sampleDepthNearest(
  depth: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number | undefined {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || px >= width || py < 0 || py >= height) return undefined;
  return depth[py * width + px];
}
