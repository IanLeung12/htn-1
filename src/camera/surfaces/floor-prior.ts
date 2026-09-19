/**
 * Floor-plane prior: before any depth model or RANSAC fit is available, we
 * still know the camera sits at a configured height above a flat floor at
 * y = 0 (see docs/general-camera/architecture.md, "Coordinate frame"). This
 * gives `SurfaceEstimator` something to publish immediately, and gives the
 * plane-prior depth estimator (src/camera/depth/plane-prior.ts) per-pixel
 * metric depth of the floor for free.
 */
import type { Millis, Pose, Surface, Vec3 } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import type { DepthMap, EstimatedSurface, SurfaceEstimator } from '@/camera/contract';
import type { DetectedVolume } from '@/capture/contract';
import { add, normalize, quatConjugate, quatRotateVec3, scale, sub } from '@/core/math';

export const FLOOR_SURFACE_ID = 'camera-floor';

/** A square floor `Surface` prior, `halfSizeM` on each side, centred under the camera. */
export function makeFloorSurface(halfSizeM: number, now: Millis, y = 0): Surface {
  const polygon = [
    { x: -halfSizeM, z: -halfSizeM },
    { x: halfSizeM, z: -halfSizeM },
    { x: halfSizeM, z: halfSizeM },
    { x: -halfSizeM, z: halfSizeM },
  ];
  return {
    id: FLOOR_SURFACE_ID,
    label: 'floor',
    orientation: 'horizontal',
    pose: { position: { x: 0, y, z: 0 }, rotation: IDENTITY_QUAT },
    polygon,
    aabb: {
      min: { x: -halfSizeM, y: y - 0.01, z: -halfSizeM },
      max: { x: halfSizeM, y: y + 0.01, z: halfSizeM },
    },
    lastChanged: now,
  };
}

export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

/**
 * World-space ray through pixel (`px`, `py`) of a `width` x `height` frame,
 * same pinhole convention as `src/capture/geom.ts`'s `projectPoint` /
 * `unprojectPixel` (camera looks down local -Z, +Y up, pixel y = 0 is the
 * top row). `px`/`py` are continuous pixel coordinates - pass `i + 0.5` for
 * the centre of pixel column/row `i`.
 */
export function pixelToRay(
  px: number,
  py: number,
  width: number,
  height: number,
  pose: Pose,
  fovY: number,
  aspect: number,
): Ray {
  const tanHalfFovY = Math.tan(fovY / 2);
  const ndcX = (2 * px) / width - 1;
  const ndcY = 1 - (2 * py) / height;
  const local: Vec3 = { x: ndcX * tanHalfFovY * aspect, y: ndcY * tanHalfFovY, z: -1 };
  return { origin: pose.position, direction: normalize(quatRotateVec3(pose.rotation, local)) };
}

/**
 * Intersection of a ray with the horizontal plane `y = planeY`, or null if
 * the ray is parallel to it or the intersection is behind the origin.
 */
export function rayPlaneY(origin: Vec3, direction: Vec3, planeY: number): Vec3 | null {
  if (Math.abs(direction.y) < 1e-9) return null;
  const t = (planeY - origin.y) / direction.y;
  if (t <= 0) return null;
  return add(origin, scale(direction, t));
}

/**
 * Metric depth (metres along the camera's forward axis, same convention as
 * `projectPoint`'s `depth`) of the floor point seen at pixel (`px`, `py`),
 * or null if that pixel's ray doesn't hit the floor in front of the camera
 * (e.g. it points above the horizon).
 */
export function floorDepthForPixel(
  px: number,
  py: number,
  width: number,
  height: number,
  pose: Pose,
  fovY: number,
  aspect: number,
  floorY = 0,
): number | null {
  const ray = pixelToRay(px, py, width, height, pose, fovY, aspect);
  const hit = rayPlaneY(ray.origin, ray.direction, floorY);
  if (!hit) return null;
  const invRot = quatConjugate(pose.rotation);
  const local = quatRotateVec3(invRot, sub(hit, pose.position));
  const depth = -local.z;
  return depth > 1e-6 ? depth : null;
}

export interface FloorPriorSurfaceEstimatorOptions {
  cameraHeightM: number;
  /** Half-extent of the published floor square, metres. Default 6. */
  halfSizeM?: number;
}

/**
 * `SurfaceEstimator` that always publishes the floor prior and nothing
 * else - no depth model, no RANSAC. `update` is a deliberate no-op: the
 * prior never changes shape, so there is nothing to recompute per frame and
 * nothing to allocate.
 */
export class FloorPriorSurfaceEstimator implements SurfaceEstimator {
  private heightM: number;
  readonly surfaces: readonly EstimatedSurface[];
  readonly volumes: readonly DetectedVolume[] = [];

  constructor(opts: FloorPriorSurfaceEstimatorOptions) {
    this.heightM = opts.cameraHeightM;
    const halfSizeM = opts.halfSizeM ?? 6;
    this.surfaces = [{ surface: makeFloorSurface(halfSizeM, 0), confidence: 1, origin: 'prior' }];
  }

  get cameraHeightM(): number {
    return this.heightM;
  }

  setHeight(h: number): void {
    this.heightM = h;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_depth: DepthMap | undefined, _pose: Pose, _now: Millis): void {
    // The floor prior never changes shape; nothing to do.
  }
}
