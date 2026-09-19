/**
 * Pure snapshot-wide pose transforms, used to convert a SceneSnapshot between
 * "world" (current reference space) and "anchor-relative" space for
 * persistence (see src/xr/anchors.ts and src/core/persistence.ts). No DOM, no
 * three.js, no XR types - just SceneSnapshot in, SceneSnapshot out.
 *
 * A single `fn: (pose: Pose) => Pose` (typically `(p) => toAnchorSpace(p,
 * anchorPose)` or `(p) => fromAnchorSpace(p, anchorPose)` from ./math) is
 * applied to every full pose in the snapshot. Fields that are plain points
 * (Aabb corners, ViewpointEnvelope.center) have no orientation of their own,
 * so they are transformed by wrapping them as an identity-rotation pose,
 * running them through the same `fn`, and keeping only the resulting
 * position - this reuses exactly one transform function for every field
 * instead of a parallel point-only variant.
 */
import type { Aabb, EditableObject, Pose, Region, SceneSnapshot, Surface, Vec3 } from './types';
import { IDENTITY_QUAT } from './types';

export type PoseTransform = (pose: Pose) => Pose;

function transformPoint(point: Vec3, fn: PoseTransform): Vec3 {
  return fn({ position: point, rotation: IDENTITY_QUAT }).position;
}

/**
 * Transforms an axis-aligned box by recomputing the AABB of all 8 transformed
 * corners (not just min/max), so a rotating anchor (e.g. a 90 degree yawed
 * anchor after relocalization) still produces a valid axis-aligned box in the
 * destination space.
 */
function transformAabb(aabb: Aabb, fn: PoseTransform): Aabb {
  const { min, max } = aabb;
  const corners: Vec3[] = [
    { x: min.x, y: min.y, z: min.z },
    { x: min.x, y: min.y, z: max.z },
    { x: min.x, y: max.y, z: min.z },
    { x: min.x, y: max.y, z: max.z },
    { x: max.x, y: min.y, z: min.z },
    { x: max.x, y: min.y, z: max.z },
    { x: max.x, y: max.y, z: min.z },
    { x: max.x, y: max.y, z: max.z },
  ];
  const out = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const c of corners) {
    const t = transformPoint(c, fn);
    if (t.x < out.min.x) out.min.x = t.x;
    if (t.y < out.min.y) out.min.y = t.y;
    if (t.z < out.min.z) out.min.z = t.z;
    if (t.x > out.max.x) out.max.x = t.x;
    if (t.y > out.max.y) out.max.y = t.y;
    if (t.z > out.max.z) out.max.z = t.z;
  }
  return out;
}

function transformObject(object: EditableObject, fn: PoseTransform): EditableObject {
  return {
    ...object,
    originalPose: fn(object.originalPose),
    currentPose: fn(object.currentPose),
    envelope: { ...object.envelope, center: transformPoint(object.envelope.center, fn) },
    background: object.background.map((plate) => ({
      ...plate,
      region: transformAabb(plate.region, fn),
      envelope: { ...plate.envelope, center: transformPoint(plate.envelope.center, fn) },
    })),
  };
}

function transformSurface(surface: Surface, fn: PoseTransform): Surface {
  return {
    ...surface,
    pose: fn(surface.pose),
    aabb: transformAabb(surface.aabb, fn),
  };
}

function transformRegion(region: Region, fn: PoseTransform): Region {
  return { ...region, bounds: transformAabb(region.bounds, fn) };
}

function mapRecord<T>(record: Record<string, T>, fn: (value: T) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, value] of Object.entries(record)) out[id] = fn(value);
  return out;
}

/**
 * Applies `fn` to every pose (and pose-shaped point) in a SceneSnapshot:
 * object originalPose/currentPose/envelope.center and each background
 * plate's region/envelope.center, surface pose/aabb, and region bounds. Never
 * mutates `snapshot`; returns a new snapshot with the same version/mode/etc.
 */
export function transformSnapshotPoses(snapshot: SceneSnapshot, fn: PoseTransform): SceneSnapshot {
  return {
    ...snapshot,
    objects: mapRecord(snapshot.objects, (o) => transformObject(o, fn)),
    surfaces: mapRecord(snapshot.surfaces, (s) => transformSurface(s, fn)),
    regions: mapRecord(snapshot.regions, (r) => transformRegion(r, fn)),
    preview: snapshot.preview ? { ...snapshot.preview, pose: fn(snapshot.preview.pose) } : snapshot.preview,
  };
}

export default transformSnapshotPoses;
