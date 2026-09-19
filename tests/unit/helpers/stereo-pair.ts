/**
 * Synthetic stereo pair generator for the census stereo-matching tests
 * (tests/unit/camera-stereo.test.ts) and the stereo Y4M fixture
 * (tests/e2e/y4m.ts, paintSyntheticStereo). A left/right pinhole pair (pixel
 * -> ray, fx/cx/cy - NOT the fovY model the rest of the camera code uses)
 * ray-casts a textured floor/box/wall scene so census matching has real
 * features to lock onto, and returns the left eye's ground-truth depth
 * (metres along the camera forward axis, matching src/capture/geom.ts).
 */
import type { GrabbedFrame } from '@/camera/contract';
import type { Pose, Quat, Vec3 } from '@/core/types';
import { quatRotateVec3 } from '@/core/math';

const BOX_Y = { min: 0, max: 0.3 };
const BOX_Z = { min: -2.15, max: -1.85 };
const BOX_X_HALF_WIDTH = 0.15;
const BOX_X_CENTER = 0.2;
const WALL_Z = -3.5;

/** Left camera pitch (rad); negative looks down. */
const PITCH_RAD = -0.35;

function leftPose(): Pose {
  const half = PITCH_RAD / 2;
  const rotation: Quat = { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) };
  return { position: { x: 0, y: 1.1, z: 0 }, rotation };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// Tiny deterministic integer hash (no external dependency), used for the
// procedural surface textures so census windows see real corners/edges.
function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}

/** Deterministic, band-limited-ish grayscale texture, distinct per material id. */
function textureValue(materialId: number, x: number, z: number): number {
  const cell = 0.08;
  const ix = Math.floor(x / cell) + materialId * 4001;
  const iz = Math.floor(z / cell) + materialId * 7919;
  const n1 = hash2(ix, iz);
  const n2 = hash2(ix * 3 + 1, iz * 5 + 2);
  const stripe = 0.5 + 0.5 * Math.sin((x + z) * 30 + materialId * 2.7);
  const value = 55 + 150 * n1 + 40 * (n2 - 0.5) + 30 * stripe;
  return Math.max(8, Math.min(247, value));
}

interface Hit {
  t: number;
  materialId: number;
  point: Vec3;
}

function intersectBox(origin: Vec3, dir: Vec3, boxOffsetX: number): number | null {
  const min = { x: BOX_X_CENTER - BOX_X_HALF_WIDTH + boxOffsetX, y: BOX_Y.min, z: BOX_Z.min };
  const max = { x: BOX_X_CENTER + BOX_X_HALF_WIDTH + boxOffsetX, y: BOX_Y.max, z: BOX_Z.max };
  let tMin = -Infinity;
  let tMax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    const t1 = (min[axis] - o) / d;
    const t2 = (max[axis] - o) / d;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  return tMin >= 1e-6 ? tMin : tMax >= 1e-6 ? tMax : null;
}

function raycastScene(origin: Vec3, dir: Vec3, boxOffsetX: number): Hit {
  let best: Hit | null = null;

  if (dir.y < -1e-9 && origin.y > 0) {
    const t = -origin.y / dir.y;
    if (t > 1e-6) best = { t, materialId: 0, point: { x: origin.x + dir.x * t, y: 0, z: origin.z + dir.z * t } };
  }

  const boxT = intersectBox(origin, dir, boxOffsetX);
  if (boxT !== null && (best === null || boxT < best.t)) {
    best = { t: boxT, materialId: 1, point: { x: origin.x + dir.x * boxT, y: origin.y + dir.y * boxT, z: origin.z + dir.z * boxT } };
  }

  if (dir.z < -1e-9) {
    const t = (WALL_Z - origin.z) / dir.z;
    if (t > 1e-6 && (best === null || t < best.t)) {
      best = { t, materialId: 2, point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: WALL_Z } };
    }
  }

  // Should be unreachable (the wall always backstops), but keep it total.
  return best ?? { t: 1000, materialId: 2, point: { x: origin.x + dir.x * 1000, y: origin.y + dir.y * 1000, z: origin.z + dir.z * 1000 } };
}

function renderEye(pose: Pose, w: number, h: number, fxPx: number, brightness: number, boxOffsetX: number): { rgba: Uint8ClampedArray; depth: Float32Array } {
  const cx = w / 2;
  const cy = h / 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const depth = new Float32Array(w * h);
  const forward = quatRotateVec3(pose.rotation, { x: 0, y: 0, z: -1 });

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const localDir = normalize({ x: (x + 0.5 - cx) / fxPx, y: -(y + 0.5 - cy) / fxPx, z: -1 });
      const worldDir = quatRotateVec3(pose.rotation, localDir);
      const hit = raycastScene(pose.position, worldDir, boxOffsetX);
      const d = hit.t * (worldDir.x * forward.x + worldDir.y * forward.y + worldDir.z * forward.z);
      const value = textureValue(hit.materialId, hit.point.x, hit.point.z) * brightness;
      const i = y * w + x;
      const o = i * 4;
      const g = Math.max(0, Math.min(255, Math.round(value)));
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = 255;
      depth[i] = d;
    }
  }
  return { rgba, depth };
}

export interface RenderStereoPairOptions {
  eyeWidth: number;
  eyeHeight: number;
  fxPx: number;
  baselineM: number;
  scene?: 'plane-box';
  /** Extra world-space X offset applied to the box (metres); used to animate the box across frames. */
  boxOffsetX?: number;
  timestamp?: number;
}

export interface RenderStereoPairResult {
  left: GrabbedFrame;
  /** Ground-truth depth of the left eye, metres along the camera forward axis. */
  truthDepth: Float32Array;
}

/**
 * Ray-cast a left/right pinhole stereo pair of a floor/box/wall scene. The
 * left camera sits at (0, 1.1, 0) pitched -0.35 rad; the right camera is
 * translated +baselineM along the left camera's local +x. Left is rendered
 * 0.8x as bright as right (exercises row equalisation).
 */
export function renderStereoPair(opts: RenderStereoPairOptions): RenderStereoPairResult {
  const { eyeWidth, eyeHeight, fxPx, baselineM } = opts;
  const boxOffsetX = opts.boxOffsetX ?? 0;
  const pose = leftPose();
  const rightPose: Pose = {
    position: {
      x: pose.position.x + quatRotateVec3(pose.rotation, { x: baselineM, y: 0, z: 0 }).x,
      y: pose.position.y + quatRotateVec3(pose.rotation, { x: baselineM, y: 0, z: 0 }).y,
      z: pose.position.z + quatRotateVec3(pose.rotation, { x: baselineM, y: 0, z: 0 }).z,
    },
    rotation: pose.rotation,
  };

  const leftEye = renderEye(pose, eyeWidth, eyeHeight, fxPx, 0.8, boxOffsetX);
  const rightEye = renderEye(rightPose, eyeWidth, eyeHeight, fxPx, 1.0, boxOffsetX);

  const left: GrabbedFrame = {
    width: eyeWidth,
    height: eyeHeight,
    rgba: leftEye.rgba,
    right: rightEye.rgba,
    timestamp: opts.timestamp ?? 1000,
  };

  return { left, truthDepth: leftEye.depth };
}
