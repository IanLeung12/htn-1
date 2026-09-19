/**
 * Builds an impostor cutout (same shape as `src/camera/impostor.ts`'s
 * `CutoutResult`) from a tracked `SilhouetteMask` instead of a fresh
 * per-pixel depth threshold - the mask already IS the object's shape
 * (median-tracked over several frames, see `SilhouetteTracker`), so the
 * moved-object impostor should composite it directly rather than
 * re-deriving a (noisier, single-frame) cutout from the box + depth. See
 * docs/general-camera/STATE.md, "Multi-frame appearance".
 */
import type { CameraFrame } from '@/capture/contract';
import type { EditableObject, Vec3 } from '@/core/types';
import { quatRotateVec3 } from '@/core/math';
import type { SilhouetteMask } from './silhouette';

export interface MaskCutoutResult {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  widthM: number;
  heightM: number;
  center: Vec3;
  coverage: number;
}

const MIN_COVERAGE = 0.03;

/**
 * `mask` is expressed in a `gridW x gridH` pixel grid (the depth map it was
 * computed from); `frame` is the RGB frame to sample colour from. Valid
 * whenever `frame` shares the same field of view as the depth grid (true for
 * a static camera: both come from the same physical camera at the same
 * pose), because pixel FRACTIONS then line up even if resolutions differ.
 */
export function cutoutFromMask(frame: CameraFrame, obj: EditableObject, mask: SilhouetteMask, gridW: number, gridH: number): MaskCutoutResult | null {
  if (gridW <= 0 || gridH <= 0) return null;
  const { width, height, alpha } = mask;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let kept = 0;

  for (let y = 0; y < height; y++) {
    const vFrac = (mask.y0 + y) / gridH;
    const py = Math.max(0, Math.min(frame.height - 1, Math.floor(vFrac * frame.height)));
    for (let x = 0; x < width; x++) {
      const uFrac = (mask.x0 + x) / gridW;
      const px = Math.max(0, Math.min(frame.width - 1, Math.floor(uFrac * frame.width)));
      const a = alpha[y * width + x] ?? 0;
      const srcIdx = (py * frame.width + px) * 4;
      const dstIdx = (y * width + x) * 4;
      rgba[dstIdx] = frame.rgba[srcIdx] ?? 0;
      rgba[dstIdx + 1] = frame.rgba[srcIdx + 1] ?? 0;
      rgba[dstIdx + 2] = frame.rgba[srcIdx + 2] ?? 0;
      rgba[dstIdx + 3] = a;
      if (a > 32) kept += 1;
    }
  }

  if (kept / (width * height) < MIN_COVERAGE) return null;

  // World footprint at the mask's own blob depth, using the frame's pinhole
  // model (same formulas as impostor.ts's cutoutFromFrame).
  const tanHalfFovY = Math.tan(frame.fovY / 2);
  const midDepth = mask.blobDepthM;
  const worldPerPixelY = (2 * midDepth * tanHalfFovY) / gridH;
  const worldPerPixelX = (2 * midDepth * tanHalfFovY * frame.aspect) / gridW;
  const widthM = width * worldPerPixelX;
  const heightM = height * worldPerPixelY;

  const cx = mask.x0 + width / 2;
  const cy = mask.y0 + height / 2;
  const ndcX = (2 * cx) / gridW - 1;
  const ndcY = 1 - (2 * cy) / gridH;
  const localX = ndcX * midDepth * tanHalfFovY * frame.aspect;
  const localY = ndcY * midDepth * tanHalfFovY;
  const localZ = -midDepth;
  const worldOffset = quatRotateVec3(frame.pose.rotation, { x: localX, y: localY, z: localZ });
  const center = { x: frame.pose.position.x + worldOffset.x, y: frame.pose.position.y + worldOffset.y, z: frame.pose.position.z + worldOffset.z };

  return { width, height, rgba, widthM, heightM, center, coverage: kept / (width * height) };
}
