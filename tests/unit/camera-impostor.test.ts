/**
 * Owner bug: a moved discovered real object (tier D, single live RGB-D frame)
 * rendered as a "thin white sliver" because a single-view depth mesh has no
 * side surfaces. `cutoutFromFrame`/`ImpostorViews` (src/camera/impostor.ts)
 * paint the object's own pixels on a camera-facing billboard instead.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Aabb, EditableObject, SceneSnapshot } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { quatFromAxisAngle } from '@/core/math';
import type { CameraFrame } from '@/capture/contract';
import { appearanceFrameKey, createFrameStore } from '@/capture/frame-store';
import { fillFloorDepth } from '@/camera/depth/prior';
import { pixelToRay } from '@/camera/surfaces/floor-prior';
import { cutoutFromFrame, ImpostorViews, isImpostorActive } from '@/camera/impostor';

const WIDTH = 160;
const HEIGHT = 120;
const ASPECT = WIDTH / HEIGHT;
const FOV_Y = (50 * Math.PI) / 180;

const CAMERA_POSE = {
  position: { x: 0, y: 1.1, z: 0 },
  rotation: quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -0.35),
};

/**
 * World box the "object" occupies; painted red in the frame with nearer depth.
 * Floating above the floor (y 0.35..0.65) rather than sitting flush on it: a
 * box whose base is exactly coplanar with the floor makes the floor
 * immediately beside/below it fall within a few cm of the box's own depth
 * range at the row where they meet - an unavoidable coincidence for any
 * ground-touching object under a per-pixel depth-slab filter, not something
 * this test is trying to characterise (it wants to check that the cutout
 * separates the object from the *rest* of the scene).
 */
const OBJECT_BOX: Aabb = {
  min: { x: 0.05, y: 0.35, z: -2.15 },
  max: { x: 0.35, y: 0.65, z: -1.85 },
};

/** Ray/box slab intersection; returns the nearest positive t, or null if it misses. */
function rayBoxT(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, box: Aabb): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes: (keyof Aabb['min'])[] = ['x', 'y', 'z'];
  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
}

/** Builds a WIDTH x HEIGHT frame: analytic floor depth/colour, with OBJECT_BOX painted
 * red and nearer than the floor wherever it's the closest surface along the ray. */
function buildFrame(): CameraFrame {
  const depth = new Float32Array(WIDTH * HEIGHT);
  fillFloorDepth(depth, WIDTH, HEIGHT, CAMERA_POSE, FOV_Y, ASPECT, 0);

  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const forward = { x: 0, y: 0, z: -1 };
  // Rotate forward by camera rotation to get world forward for the dot-product depth formula.
  const q = CAMERA_POSE.rotation;
  // v' = q * v * q^-1
  function rotate(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const qv = { x: q.x, y: q.y, z: q.z };
    const uvx = qv.y * v.z - qv.z * v.y;
    const uvy = qv.z * v.x - qv.x * v.z;
    const uvz = qv.x * v.y - qv.y * v.x;
    const uuvx = qv.y * uvz - qv.z * uvy;
    const uuvy = qv.z * uvx - qv.x * uvz;
    const uuvz = qv.x * uvy - qv.y * uvx;
    return {
      x: v.x + 2 * (q.w * uvx + uuvx),
      y: v.y + 2 * (q.w * uvy + uuvy),
      z: v.z + 2 * (q.w * uvz + uuvz),
    };
  }
  const worldForward = rotate(forward);

  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const i = py * WIDTH + px;
      const idx = i * 4;
      const floorDepth = depth[i] ?? 0;

      const ray = pixelToRay(px + 0.5, py + 0.5, WIDTH, HEIGHT, CAMERA_POSE, FOV_Y, ASPECT);
      const boxT = rayBoxT(ray.origin, ray.direction, OBJECT_BOX);
      const boxDepth =
        boxT !== null
          ? boxT * (ray.direction.x * worldForward.x + ray.direction.y * worldForward.y + ray.direction.z * worldForward.z)
          : null;

      const hitsBox = boxDepth !== null && boxDepth > 0 && (!(floorDepth > 0) || boxDepth < floorDepth);

      if (hitsBox && boxDepth !== null) {
        rgba[idx] = 200;
        rgba[idx + 1] = 20;
        rgba[idx + 2] = 20;
        rgba[idx + 3] = 255;
        depth[i] = boxDepth;
        continue;
      }

      if (floorDepth > 0) {
        // Distinct non-red floor colour.
        rgba[idx] = 40;
        rgba[idx + 1] = 120;
        rgba[idx + 2] = 180;
        rgba[idx + 3] = 255;
      } else {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 255;
        depth[i] = 0;
      }
    }
  }

  return { width: WIDTH, height: HEIGHT, rgba, depth, pose: CAMERA_POSE, fovY: FOV_Y, aspect: ASPECT, timestamp: 0 };
}

function isRed(rgba: Uint8ClampedArray, i: number): boolean {
  const idx = i * 4;
  return (rgba[idx] as number) > 150 && (rgba[idx + 1] as number) < 80;
}

const BOX_CENTER = {
  x: (OBJECT_BOX.min.x + OBJECT_BOX.max.x) / 2,
  y: (OBJECT_BOX.min.y + OBJECT_BOX.max.y) / 2,
  z: (OBJECT_BOX.min.z + OBJECT_BOX.max.z) / 2,
};
const BOX_HALF_EXTENTS = {
  x: (OBJECT_BOX.max.x - OBJECT_BOX.min.x) / 2,
  y: (OBJECT_BOX.max.y - OBJECT_BOX.min.y) / 2,
  z: (OBJECT_BOX.max.z - OBJECT_BOX.min.z) / 2,
};

function baseObject(): EditableObject {
  return {
    id: 'obj:real1',
    label: 'other',
    userName: 'real object',
    origin: 'physical',
    originalPose: { position: BOX_CENTER, rotation: IDENTITY_QUAT },
    currentPose: { position: { x: BOX_CENTER.x + 0.45, y: BOX_CENTER.y, z: BOX_CENTER.z }, rotation: IDENTITY_QUAT },
    visual: { kind: 'baked' },
    interactionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    collisionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    occlusionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    supportSurfaces: ['camera-floor'],
    background: [],
    provenance: { method: 'guided_clean_plate', capturedAt: 0, capturePath: [] },
    tier: 'D',
    tierConfidence: 0.6,
    envelope: { center: BOX_CENTER, radius: 1.5, maxAngle: 1.0 },
    physical: { massKg: 0.3, friction: 0.6, restitution: 0.1, kinematic: false },
    approved: true,
    visible: true,
  };
}

function snapshotWith(obj: EditableObject): SceneSnapshot {
  return {
    version: 1,
    committedAt: 0,
    mode: 'live-overlay',
    objects: { [obj.id]: obj },
    surfaces: {},
    regions: {},
  };
}

describe('cutoutFromFrame', () => {
  it('keeps the object pixels and drops the floor', () => {
    const frame = buildFrame();
    const obj = baseObject();
    const cutout = cutoutFromFrame(frame, obj);
    expect(cutout).not.toBeNull();
    if (!cutout) throw new Error('unreachable');

    let redKept = 0;
    let nonRedKept = 0;
    for (let i = 0; i < cutout.width * cutout.height; i++) {
      const idx = i * 4;
      if ((cutout.rgba[idx + 3] as number) === 0) continue;
      if (isRed(cutout.rgba, i)) redKept++;
      else nonRedKept++;
    }
    const totalKept = redKept + nonRedKept;
    expect(totalKept).toBeGreaterThan(0);
    expect(redKept / totalKept).toBeGreaterThan(0.9);
    expect(nonRedKept / totalKept).toBeLessThan(0.1);

    expect(cutout.widthM).toBeGreaterThan(0.35 - 0.12);
    expect(cutout.widthM).toBeLessThan(0.35 + 0.12);
    expect(cutout.heightM).toBeGreaterThan(0.35 - 0.12);
    expect(cutout.heightM).toBeLessThan(0.35 + 0.12);

    const d = Math.hypot(cutout.center.x - BOX_CENTER.x, cutout.center.y - BOX_CENTER.y, cutout.center.z - BOX_CENTER.z);
    expect(d).toBeLessThan(0.1);
  });

  it('returns null when almost nothing survives the depth filter', () => {
    const frame = buildFrame();
    const obj = baseObject();
    // Absurdly tight slack around a depth range that excludes the box entirely.
    const farObj: EditableObject = {
      ...obj,
      originalPose: { position: { x: 0, y: 5, z: -2 }, rotation: IDENTITY_QUAT },
    };
    const cutout = cutoutFromFrame(frame, farObj, { depthSlackM: 0 });
    expect(cutout).toBeNull();
  });
});

describe('ImpostorViews', () => {
  it('shows a billboard near currentPose and an outline at originalPose for a moved object', () => {
    const frame = buildFrame();
    const frameStore = createFrameStore();
    const obj = baseObject();
    frameStore.put(appearanceFrameKey(obj.id), [frame]);

    const views = new ImpostorViews(frameStore);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.1, 0);

    views.update(snapshotWith(obj), camera, 0);

    expect(isImpostorActive(views, obj.id)).toBe(true);

    let mesh: THREE.Mesh | undefined;
    let outline: THREE.LineSegments | undefined;
    views.group.traverse((child) => {
      if (child instanceof THREE.Mesh) mesh = child;
      if (child instanceof THREE.LineSegments) outline = child;
    });
    expect(mesh).toBeDefined();
    expect(outline).toBeDefined();
    if (!mesh || !outline) throw new Error('unreachable');

    expect(mesh.visible).toBe(true);
    expect(outline.visible).toBe(true);

    const cutout = cutoutFromFrame(frame, obj);
    if (!cutout) throw new Error('unreachable');
    const expectedOffset = {
      x: cutout.center.x - obj.originalPose.position.x,
      y: cutout.center.y - obj.originalPose.position.y,
      z: cutout.center.z - obj.originalPose.position.z,
    };
    const expectedPos = {
      x: obj.currentPose.position.x + expectedOffset.x,
      y: obj.currentPose.position.y + expectedOffset.y,
      z: obj.currentPose.position.z + expectedOffset.z,
    };
    expect(mesh.position.x).toBeCloseTo(expectedPos.x, 3);
    expect(mesh.position.y).toBeCloseTo(expectedPos.y, 3);
    expect(mesh.position.z).toBeCloseTo(expectedPos.z, 3);

    expect(outline.position.x).toBeCloseTo(obj.originalPose.position.x, 6);
    expect(outline.position.y).toBeCloseTo(obj.originalPose.position.y, 6);
    expect(outline.position.z).toBeCloseTo(obj.originalPose.position.z, 6);

    views.dispose();
  });

  it('shows nothing for an unmoved object', () => {
    const frame = buildFrame();
    const frameStore = createFrameStore();
    const obj = baseObject();
    obj.currentPose = { position: { ...obj.originalPose.position }, rotation: { ...obj.originalPose.rotation } };
    frameStore.put(appearanceFrameKey(obj.id), [frame]);

    const views = new ImpostorViews(frameStore);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.1, 0);

    views.update(snapshotWith(obj), camera, 0);

    expect(isImpostorActive(views, obj.id)).toBe(false);
    let anyVisible = false;
    views.group.traverse((child) => {
      if ((child as THREE.Object3D).visible === false) return;
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) anyVisible = true;
    });
    expect(anyVisible).toBe(false);

    views.dispose();
  });
});
