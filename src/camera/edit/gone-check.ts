/**
 * "Is the real object actually gone?" check for `Capture plate` (general-
 * camera backend). A single fixed camera cannot verify removal the way a
 * moving XR headset can (walk around and look); instead we resample the
 * object's footprint in the latest depth frame and compare it against (a)
 * the support plane it should now show and (b) the depth the object itself
 * used to occupy. If most of the footprint still reads at the object's old
 * depth (or clearly closer than the plane), the object is still there and
 * `Capture plate` must refuse with a hint rather than bake a plate of the
 * object itself.
 *
 * Pure TS; unit-testable without a renderer.
 */
import type { EditableObject, Surface, Vec3 } from '@/core/types';
import { footprintFromProxy } from '@/capture/plates';
import { inFrame, projectPoint } from '@/capture/geom';
import type { DepthFrameLike } from './silhouette';

const DEFAULT_PLANE_TOLERANCE_M = 0.03;
const DEFAULT_STILL_PRESENT_TOLERANCE_M = 0.08;
const GRID = 6;
/** Fraction of footprint samples that must read at the plane for "gone". */
const GONE_AT_PLANE_FRACTION = 0.6;
/** Fraction of footprint samples reading at the old object depth that blocks "gone". */
const STILL_PRESENT_FRACTION = 0.2;
/** Minimum fraction of grid points that must get a valid depth sample to judge anything. */
const MIN_SAMPLED_FRACTION = 0.5;

export interface GoneCheckOptions {
  planeToleranceM?: number;
  stillPresentToleranceM?: number;
  gridSize?: number;
}

export type GoneCheckReason = 'still-present' | 'no-depth-for-footprint';

export interface GoneCheckResult {
  gone: boolean;
  reason?: GoneCheckReason;
  sampledFraction: number;
  atPlaneFraction: number;
  stillPresentFraction: number;
}

function halfExtentsForProxy(shape: EditableObject['occlusionProxy']): Vec3 {
  switch (shape.kind) {
    case 'box':
      return shape.halfExtents;
    case 'sphere':
      return { x: shape.radius, y: shape.radius, z: shape.radius };
    case 'capsule':
      return { x: shape.radius, y: shape.halfHeight + shape.radius, z: shape.radius };
  }
}

/**
 * Checks whether `obj`'s footprint (its support-plane AABB) now reads as
 * empty in `df`: for a grid of points across the footprint (at the support
 * plane's height), we project into the depth frame and compare the sampled
 * depth against (a) the depth the plane itself predicts there (empty desk)
 * and (b) `previousBlobDepthM` (the object's own depth, from
 * `computeSilhouetteMask`/`SilhouetteTracker`, if known) - a majority at the
 * plane and few still at the object's depth means "gone".
 */
export function checkObjectGone(
  df: DepthFrameLike,
  obj: EditableObject,
  supportSurface: Surface | undefined,
  previousBlobDepthM: number | undefined,
  opts?: GoneCheckOptions,
): GoneCheckResult {
  const planeToleranceM = opts?.planeToleranceM ?? DEFAULT_PLANE_TOLERANCE_M;
  const stillPresentToleranceM = opts?.stillPresentToleranceM ?? DEFAULT_STILL_PRESENT_TOLERANCE_M;
  const gridSize = opts?.gridSize ?? GRID;

  const halfExtents = halfExtentsForProxy(obj.occlusionProxy);
  const region = footprintFromProxy(obj.originalPose.position, halfExtents, supportSurface);
  const y = (region.min.y + region.max.y) / 2;

  let sampled = 0;
  let atPlane = 0;
  let stillPresent = 0;
  let total = 0;

  for (let row = 0; row < gridSize; row++) {
    const z = region.min.z + ((row + 0.5) / gridSize) * (region.max.z - region.min.z);
    for (let col = 0; col < gridSize; col++) {
      const x = region.min.x + ((col + 0.5) / gridSize) * (region.max.x - region.min.x);
      total += 1;
      const proj = projectPoint({ x, y, z }, df.pose, df.fovY, df.aspect, df.width, df.height);
      if (!proj || !inFrame(proj, df.width, df.height)) continue;
      const d = df.depth[Math.floor(proj.y) * df.width + Math.floor(proj.x)];
      if (d === undefined || !(d > 0)) continue;
      sampled += 1;
      if (Math.abs(d - proj.depth) <= planeToleranceM) atPlane += 1;
      if (
        previousBlobDepthM !== undefined &&
        d < proj.depth - planeToleranceM &&
        Math.abs(d - previousBlobDepthM) <= stillPresentToleranceM
      ) {
        stillPresent += 1;
      }
    }
  }

  const sampledFraction = total > 0 ? sampled / total : 0;
  const atPlaneFraction = sampled > 0 ? atPlane / sampled : 0;
  const stillPresentFraction = sampled > 0 ? stillPresent / sampled : 0;

  if (sampledFraction < MIN_SAMPLED_FRACTION) {
    return { gone: false, reason: 'no-depth-for-footprint', sampledFraction, atPlaneFraction, stillPresentFraction };
  }

  const gone = atPlaneFraction >= GONE_AT_PLANE_FRACTION && stillPresentFraction <= STILL_PRESENT_FRACTION;
  return { gone, reason: gone ? undefined : 'still-present', sampledFraction, atPlaneFraction, stillPresentFraction };
}
