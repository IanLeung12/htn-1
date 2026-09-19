/**
 * Pure vec3/quat/aabb/pose helpers over the plain-data types in ./types.
 * No three.js, no DOM. Every function returns a new object; inputs are
 * never mutated.
 */
import type { Aabb, Pose, Quat, Vec3, ViewpointEnvelope } from './types';

// ---------------------------------------------------------------------------
// Vec3
// ---------------------------------------------------------------------------

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return scale(a, 1 / len);
}

// ---------------------------------------------------------------------------
// Quat
// ---------------------------------------------------------------------------

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

export function quatRotateVec3(q: Quat, v: Vec3): Vec3 {
  // v' = q * v * q^-1, computed without building intermediate quaternions.
  const qv: Vec3 = { x: q.x, y: q.y, z: q.z };
  const uv = cross(qv, v);
  const uuv = cross(qv, uv);
  return add(v, scale(add(scale(uv, q.w), uuv), 2));
}

export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const n = normalize(axis);
  const half = angleRad / 2;
  const s = Math.sin(half);
  return quatNormalize({ x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(half) });
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cosHalfTheta = a.x * bx + a.y * by + a.z * bz + a.w * bw;

  if (cosHalfTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }

  if (cosHalfTheta >= 1) {
    return { x: a.x, y: a.y, z: a.z, w: a.w };
  }

  const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);

  if (sinHalfTheta < 1e-6) {
    return quatNormalize({
      x: a.x * 0.5 + bx * 0.5,
      y: a.y * 0.5 + by * 0.5,
      z: a.z * 0.5 + bz * 0.5,
      w: a.w * 0.5 + bw * 0.5,
    });
  }

  const halfTheta = Math.acos(cosHalfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

  return quatNormalize({
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  });
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

/** Compose two poses: apply `b` in `a`'s local frame, i.e. a * b. */
export function poseCompose(a: Pose, b: Pose): Pose {
  return {
    position: add(a.position, quatRotateVec3(a.rotation, b.position)),
    rotation: quatNormalize(quatMultiply(a.rotation, b.rotation)),
  };
}

export function poseInverse(p: Pose): Pose {
  const invRot = quatConjugate(p.rotation);
  return {
    position: scale(quatRotateVec3(invRot, p.position), -1),
    rotation: invRot,
  };
}

// ---------------------------------------------------------------------------
// Anchor-relative space conversions
// ---------------------------------------------------------------------------

/**
 * Converts a pose expressed in the current reference space ("world") into a
 * pose expressed relative to `anchorPose` (itself given in the same
 * reference space). This is what gets persisted: anchor-relative poses are
 * stable across sessions even though the reference space origin moves
 * between sessions and after relocalization (see src/xr/anchors.ts).
 */
export function toAnchorSpace(pose: Pose, anchorPose: Pose): Pose {
  return poseCompose(poseInverse(anchorPose), pose);
}

/** Inverse of `toAnchorSpace`: anchor-relative pose -> current reference space. */
export function fromAnchorSpace(pose: Pose, anchorPose: Pose): Pose {
  return poseCompose(anchorPose, pose);
}

// ---------------------------------------------------------------------------
// Aabb
// ---------------------------------------------------------------------------

export function aabbFromCenterHalfExtents(center: Vec3, halfExtents: Vec3): Aabb {
  return {
    min: sub(center, halfExtents),
    max: add(center, halfExtents),
  };
}

export function aabbContains(box: Aabb, point: Vec3): boolean {
  return (
    point.x >= box.min.x && point.x <= box.max.x &&
    point.y >= box.min.y && point.y <= box.max.y &&
    point.z >= box.min.z && point.z <= box.max.z
  );
}

export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return (
    a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z
  );
}

export function aabbExpand(box: Aabb, amount: number): Aabb {
  const d: Vec3 = { x: amount, y: amount, z: amount };
  return {
    min: sub(box.min, d),
    max: add(box.max, d),
  };
}

// ---------------------------------------------------------------------------
// Viewpoint envelope
// ---------------------------------------------------------------------------

/**
 * True if the given head pose is within the viewpoint envelope: inside the
 * radius from the envelope center, and within maxAngle of the capture
 * heading (approximated as facing from headPose.position toward the
 * envelope center, compared against the head's forward direction, -Z local).
 */
export function pointInEnvelope(headPose: Pose, envelope: ViewpointEnvelope): boolean {
  const d = distance(headPose.position, envelope.center);
  if (d > envelope.radius) return false;
  if (d < 1e-9) return true; // at the center, angle is undefined -> trivially inside

  const forward = quatRotateVec3(headPose.rotation, { x: 0, y: 0, z: -1 });
  const toCenter = normalize(sub(envelope.center, headPose.position));
  const cosAngle = Math.max(-1, Math.min(1, dot(normalize(forward), toCenter)));
  const angle = Math.acos(cosAngle);
  return angle <= envelope.maxAngle;
}
