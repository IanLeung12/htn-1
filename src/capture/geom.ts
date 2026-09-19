/**
 * Capture-local geometry helpers: pinhole projection into a captured frame.
 * Reuses the shared vec/quat/pose helpers from @/core/math; nothing here
 * duplicates those primitives.
 */
import type { CameraFrame } from './contract';
import type { Pose, Quat, Vec3 } from '@/core/types';
import { add, quatConjugate, quatRotateVec3, sub } from '@/core/math';

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

/**
 * Inverse of `projectPoint`: given a pixel and a depth (metres along the
 * camera's forward axis, same convention as `Projection.depth` and
 * `CameraFrame.depth`), recover the world-space point. Exact round trip with
 * `projectPoint` (same pinhole model, same forward -Z/up +Y convention, same
 * pixel y=0-is-top-row mapping) up to floating point error - unprojecting a
 * pixel+depth and re-projecting the result yields the same pixel and depth.
 * Used to build the depth-mesh geometry in `src/render/depth-mesh.ts`.
 */
export function unprojectPixel(
  x: number,
  y: number,
  depth: number,
  pose: Pose,
  fovY: number,
  aspect: number,
  width: number,
  height: number,
): Vec3 {
  const tanHalfFovY = Math.tan(fovY / 2);
  const ndcX = (2 * x) / width - 1;
  const ndcY = 1 - (2 * y) / height;
  const local: Vec3 = {
    x: ndcX * depth * tanHalfFovY * aspect,
    y: ndcY * depth * tanHalfFovY,
    z: -depth,
  };
  return add(pose.position, quatRotateVec3(pose.rotation, local));
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

// ---------------------------------------------------------------------------
// Shared view-projection matrix (CPU + GPU use the same definition)
// ---------------------------------------------------------------------------

/**
 * Arbitrary but fixed near/far used only to build a projection matrix's z-row
 * (they never affect the x/y mapping computed here or in `projectPoint`, only
 * depth-buffer precision, which nothing in this codebase reads back from a
 * `frameViewProjection` matrix). Frames are captured at room scale, so this
 * comfortably covers everything without clipping.
 */
const FRAME_PROJECTION_NEAR = 0.05;
const FRAME_PROJECTION_FAR = 1000;

/** Row-major 3x3 rotation matrix (as a flat 9-array) that rotates a vector by `q`. */
function quatToMat3(q: Quat): number[] {
  const { x, y, z, w } = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

/** Column-major 4x4 * 4x4 multiply: returns a * b. */
function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * The view-projection matrix (column-major, WebGL layout) for a captured
 * frame, sharing the exact camera convention `projectPoint` uses (looks down
 * local -Z, +Y up, vertical FOV `fovY`, aspect `aspect`): a world point
 * `w` in front of the camera projects, via `clip = M * vec4(w,1)`,
 * `ndc = clip.xy / clip.w`, to the same normalized device coordinates
 * `projectPoint` derives, so `uv = (ndc.x*0.5+0.5, 0.5-ndc.y*0.5) * (width,height)`
 * lands on the same pixel `projectPoint` returns (see `frameViewProjection`
 * unit tests and the shader in src/render/projective.ts, which uses the same
 * formula GPU-side).
 */
export function frameViewProjection(frame: Pick<CameraFrame, 'pose' | 'fovY' | 'aspect'>): Float32Array {
  const invRot = quatConjugate(frame.pose.rotation);
  const rInv = quatToMat3(invRot); // row-major 3x3: rInv * v == quatRotateVec3(invRot, v)
  const t = quatRotateVec3(invRot, { x: -frame.pose.position.x, y: -frame.pose.position.y, z: -frame.pose.position.z });

  // View matrix, column-major: [ rInv | t ; 0 0 0 1 ].
  const view = new Float32Array([
    rInv[0]!, rInv[3]!, rInv[6]!, 0,
    rInv[1]!, rInv[4]!, rInv[7]!, 0,
    rInv[2]!, rInv[5]!, rInv[8]!, 0,
    t.x, t.y, t.z, 1,
  ]);

  const f = 1 / Math.tan(frame.fovY / 2);
  const near = FRAME_PROJECTION_NEAR;
  const far = FRAME_PROJECTION_FAR;
  const proj = new Float32Array([
    f / frame.aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);

  return mat4Multiply(proj, view);
}
