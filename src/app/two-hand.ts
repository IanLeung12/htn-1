/**
 * Pure math for two-hand manipulation. No DOM, no three.js - just plain data
 * over the `Vec3`/`Quat` types in `@/core/types`, so it's trivial to unit
 * test and safe to call every frame from `src/app/interaction.ts`.
 *
 * Two-hand mode composes three independent deltas from a pair of hand
 * frames (a midpoint + a hand-to-hand vector, sampled at grab-start and
 * again every frame):
 *
 *  - translation: how far the midpoint moved.
 *  - yaw: the change in the hand-to-hand vector's horizontal (XZ) bearing,
 *    about world Y only - objects never pitch/roll from a two-hand grab.
 *  - scale: the ratio of the current hand-to-hand distance to the initial
 *    one.
 *
 * A degenerate frame (hands coincident, so the hand-to-hand vector has ~0
 * length) can't define a bearing or a stable scale ratio, so it reports the
 * identity delta rather than dividing by ~0 or returning a NaN/garbage yaw.
 */
import type { Quat, Vec3 } from '@/core/types';
import { quatMultiply } from '@/core/math';

/** A single hand-pair sample: the midpoint between the hands and the vector from hand A to hand B. */
export interface TwoHandFrame {
  midpoint: Vec3;
  /** Vector from one hand to the other (e.g. right - left). Must use a consistent order between `initial` and `current`. */
  vector: Vec3;
}

export interface TwoHandDelta {
  /** World-space translation of the midpoint since `initial`. */
  position: Vec3;
  /** Yaw about world Y (radians) since `initial`. */
  yawRad: number;
  /** Ratio of current hand distance to initial hand distance (1 = unchanged). */
  scale: number;
}

/** Below this hand-to-hand distance (m) the vector can't define a bearing or a stable scale ratio. */
const DEGENERATE_DIST_M = 1e-4;

export const TWO_HAND_MIN_SCALE = 0.25;
export const TWO_HAND_MAX_SCALE = 4;

/** Fraction change below which a committed scale is treated as "unchanged" (spec: 2%). */
export const SCALE_COMMIT_EPSILON = 0.02;
/** Degrees below which a committed rotation is treated as "unchanged" (spec: 1 degree). */
export const ROTATE_COMMIT_EPSILON_DEG = 1;

function vecLength(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function bearingXZ(v: Vec3): number {
  return Math.atan2(v.x, v.z);
}

function normalizeAngle(rad: number): number {
  let a = rad;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

const IDENTITY_DELTA: TwoHandDelta = { position: { x: 0, y: 0, z: 0 }, yawRad: 0, scale: 1 };

/**
 * Compose translation/yaw/scale from an initial and current two-hand frame.
 * Pure and allocation-light: one small result object, no shared/mutable state.
 */
export function computeTwoHandDelta(initial: TwoHandFrame, current: TwoHandFrame): TwoHandDelta {
  const initialDist = vecLength(initial.vector);
  const currentDist = vecLength(current.vector);
  if (initialDist < DEGENERATE_DIST_M || currentDist < DEGENERATE_DIST_M) {
    return IDENTITY_DELTA;
  }

  const position: Vec3 = {
    x: current.midpoint.x - initial.midpoint.x,
    y: current.midpoint.y - initial.midpoint.y,
    z: current.midpoint.z - initial.midpoint.z,
  };

  const yawRad = normalizeAngle(bearingXZ(current.vector) - bearingXZ(initial.vector));
  const scale = currentDist / initialDist;

  return { position, yawRad, scale };
}

/** Clamp a cumulative two-hand scale factor to the supported range. */
export function clampTwoHandScale(scale: number): number {
  if (Number.isNaN(scale) || !Number.isFinite(scale)) return 1;
  return Math.min(TWO_HAND_MAX_SCALE, Math.max(TWO_HAND_MIN_SCALE, scale));
}

/** Angle (degrees) between two quaternions, for the >1deg commit-rotation check. */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const relative = quatMultiply(b, { x: -a.x, y: -a.y, z: -a.z, w: a.w });
  const w = Math.min(1, Math.max(-1, Math.abs(relative.w)));
  return (2 * Math.acos(w) * 180) / Math.PI;
}
