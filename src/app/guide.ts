/**
 * Guided multi-viewpoint clean-plate capture. Plans a short arc of capture
 * viewpoints around an object's exposed footprint plus a few off-path
 * verification viewpoints, and exposes a `CaptureGuide` UI state
 * (`AppHandle.guide`) that the HUD renders as a floor ring + hint text so a
 * user standing in front of the real object knows where to move next.
 *
 * On a real device there is no camera source (`NO_CAMERA_SOURCE` in
 * main.ts): `CameraFrameSource.capture()` always resolves to `null` and the
 * pipeline falls back to tier E. The guide still walks through every step
 * (so the UI has something to show a user physically moving around the
 * object) - it just never gets a frame back.
 */
import * as THREE from 'three';
import type { CaptureGuide } from './contract';
import type { CameraFrameSource } from '@/capture/contract';
import { footprintFromProxy } from '@/capture';
import type { EditableObject, Pose, Quat, Surface, Vec3 } from '@/core/types';

const CAPTURE_COUNT = 6; // full circle at 60 degree steps so hull coverage does not depend on the head bearing
const VERIFY_COUNT = 3;
const ARC_STEP_RAD = Math.PI / 3; // 60 degrees
const HEIGHT_MIN_M = 1.2;
const HEIGHT_MAX_M = 1.6;
const DIST_MIN_M = 1.0;
const DIST_MAX_M = 1.4;

export interface CaptureViewpointPlan {
  /** The primary guided arc (also fed to the capture pipeline as `viewpoints`). */
  capture: Pose[];
  /** Off-path viewpoints for the verification sweep. */
  verify: Pose[];
}

function bearingTo(from: Vec3, center: Vec3): number {
  return Math.atan2(from.z - center.z, from.x - center.x);
}

function lookAtQuat(eye: Vec3, target: Vec3): Quat {
  const m = new THREE.Matrix4().lookAt(
    new THREE.Vector3(eye.x, eye.y, eye.z),
    new THREE.Vector3(target.x, target.y, target.z),
    new THREE.Vector3(0, 1, 0),
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function viewpointAt(center: Vec3, angleRad: number, distanceM: number, heightM: number): Pose {
  const position: Vec3 = {
    x: center.x + distanceM * Math.cos(angleRad),
    y: heightM,
    z: center.z + distanceM * Math.sin(angleRad),
  };
  return { position, rotation: lookAtQuat(position, center) };
}

/**
 * Plan an arc of `CAPTURE_COUNT` viewpoints (1.2-1.6m eye height, 1.0-1.4m
 * from the footprint centre, 60 degrees apart, starting at the current head
 * bearing) plus `VERIFY_COUNT` off-path viewpoints interleaved between them
 * at slightly different height/distance, each looking at the footprint
 * centre.
 */
export function planCaptureViewpoints(
  object: EditableObject,
  supportSurface: Surface | undefined,
  headPose: Pose,
): CaptureViewpointPlan {
  const proxy = object.interactionProxy;
  const halfExtents: Vec3 = proxy.kind === 'box' ? proxy.halfExtents : { x: 0.3, y: 0.3, z: 0.3 };
  const footprint = footprintFromProxy(object.currentPose.position, halfExtents, supportSurface);
  const center: Vec3 = {
    x: (footprint.min.x + footprint.max.x) / 2,
    y: (footprint.min.y + footprint.max.y) / 2,
    z: (footprint.min.z + footprint.max.z) / 2,
  };
  const bearing0 = bearingTo(headPose.position, center);

  const capture: Pose[] = [];
  for (let i = 0; i < CAPTURE_COUNT; i++) {
    const t = (i % 2 === 0 ? 0 : 1) * 0.6 + (i / (CAPTURE_COUNT - 1)) * 0.4; // alternate low/high, drift outward
    const angle = bearing0 + i * ARC_STEP_RAD;
    const height = HEIGHT_MIN_M + t * (HEIGHT_MAX_M - HEIGHT_MIN_M);
    const dist = DIST_MIN_M + t * (DIST_MAX_M - DIST_MIN_M);
    capture.push(viewpointAt(center, angle, dist, height));
  }

  const verify: Pose[] = [];
  for (let i = 0; i < VERIFY_COUNT; i++) {
    const t = (i + 0.5) / (CAPTURE_COUNT - 1);
    const angle = bearing0 + (i + 0.5) * ARC_STEP_RAD;
    // Off-path on purpose: a bit closer and a bit higher than the guided arc
    // at the same point, per "deliberate off-path head motion" verification.
    const height = HEIGHT_MIN_M + t * (HEIGHT_MAX_M - HEIGHT_MIN_M) + 0.1;
    const dist = Math.max(0.6, DIST_MIN_M + t * (DIST_MAX_M - DIST_MIN_M) - 0.15);
    verify.push(viewpointAt(center, angle, dist, height));
  }

  return { capture, verify };
}

export const INACTIVE_GUIDE: CaptureGuide = {
  active: false,
  objectId: null,
  step: 0,
  total: 0,
  targetPose: null,
  hint: '',
};

function hintFor(object: EditableObject, step: number, total: number): string {
  const label = object.label === 'other' ? 'object' : object.label;
  return `Stand here and look at the ${label} (${step}/${total})`;
}

/**
 * Wraps a CameraFrameSource so every `capture(viewpoint)` call during the
 * guided arc first advances `onStep`, whether or not a frame is actually
 * returned (device builds have no camera source at all - see module header).
 */
export function wrapSourceForGuide(
  source: CameraFrameSource,
  onStep: (viewpoint: Pose | undefined) => void,
): CameraFrameSource {
  return {
    available: source.available,
    async capture(viewpoint?: Pose) {
      onStep(viewpoint);
      return source.capture(viewpoint);
    },
  };
}

export function makeActiveGuide(object: EditableObject, step: number, total: number, targetPose: Pose): CaptureGuide {
  return {
    active: true,
    objectId: object.id,
    step,
    total,
    targetPose,
    hint: hintFor(object, step, total),
  };
}
