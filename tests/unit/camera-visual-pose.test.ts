import { describe, expect, it } from 'vitest';
import { StaticPoseSource } from '@/camera/pose/static';
import { VisualPoseSource } from '@/camera/pose/visual';
import { quatRotateVec3 } from '@/core/math';
import type { CameraIntrinsics, GrabbedFrame } from '@/camera/contract';
import { cropWorld, grayToRgba, makeSyntheticWorld } from './helpers/syntheticTexture';

const WIDTH = 160;
const HEIGHT = 120;
const PAD = 24;
const FOV_Y = (50 * Math.PI) / 180;
const FOCAL_PX = HEIGHT / 2 / Math.tan(FOV_Y / 2);

const intrinsics: CameraIntrinsics = { fovY: FOV_Y, aspect: WIDTH / HEIGHT, width: WIDTH, height: HEIGHT };

const world = makeSyntheticWorld(WIDTH + 2 * PAD, HEIGHT + 2 * PAD, 99);

function frameAt(shiftX: number, shiftY: number, timestamp: number): GrabbedFrame {
  const gray = cropWorld(world, PAD - shiftX, PAD - shiftY, WIDTH, HEIGHT);
  return { width: WIDTH, height: HEIGHT, rgba: grayToRgba(gray), timestamp };
}

describe('VisualPoseSource (motion detection only, integrateRotation: false)', () => {
  it('identical frames keep trackingOk true and rotation equal to the base pose', () => {
    const base = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: 0 });
    const visual = new VisualPoseSource(base, { integrateRotation: false });

    visual.pushFrame(frameAt(0, 0, 0), intrinsics, 0);
    visual.pushFrame(frameAt(0, 0, 16), intrinsics, 16);
    visual.pushFrame(frameAt(0, 0, 32), intrinsics, 32);
    visual.update(32);

    expect(visual.quality.trackingOk).toBe(true);
    expect(visual.pose.rotation).toEqual(base.pose.rotation);
    expect(visual.motionPx).toBeLessThan(0.2);
  });

  it('a large (12 px) shift drops trackingOk, which recovers after settleMs of near-static frames', () => {
    const base = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: 0 });
    const visual = new VisualPoseSource(base, { integrateRotation: false, settleMs: 500 });

    let t = 0;
    visual.pushFrame(frameAt(0, 0, t), intrinsics, t);
    t += 100;
    visual.pushFrame(frameAt(12, 0, t), intrinsics, t); // big jump: 12 px shift
    visual.update(t);

    expect(visual.motionPx).toBeGreaterThan(6);
    expect(visual.quality.trackingOk).toBe(false);

    // Near-static frames from here on (same content, 0 px motion), but
    // trackingOk only recovers once settleMs has elapsed since the jump.
    const lastShift = 12;
    for (let i = 0; i < 3; i++) {
      t += 100; // t = 200, 300, 400: still < settleMs (500) since the jump at t=100
      visual.pushFrame(frameAt(lastShift, 0, t), intrinsics, t);
      visual.update(t);
    }
    expect(visual.motionPx).toBeLessThan(0.2);
    expect(visual.quality.trackingOk).toBe(false);

    t += 300; // t = 700: well past settleMs (500) since the jump at t=100
    visual.pushFrame(frameAt(lastShift, 0, t), intrinsics, t);
    visual.update(t);
    expect(visual.motionPx).toBeLessThan(0.2);
    expect(visual.quality.trackingOk).toBe(true);
  });
});

describe('VisualPoseSource (integrateRotation: true)', () => {
  it('accumulates yaw from consecutive coherent shifts, rotating the forward vector accordingly', () => {
    const base = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: 0 });
    const visual = new VisualPoseSource(base, { integrateRotation: true });

    let t = 0;
    let shift = 0;
    visual.pushFrame(frameAt(shift, 0, t), intrinsics, t);
    visual.update(t);

    const STEP = 3;
    for (let i = 0; i < 3; i++) {
      t += 100;
      shift += STEP;
      visual.pushFrame(frameAt(shift, 0, t), intrinsics, t);
      visual.update(t);
    }

    // Each push measures ~+3 px of flow -> yawRad ~= +3/focalPx per step;
    // three steps accumulate to ~= 3 * 3 / focalPx (see rotationFromFlow's
    // documented sign convention in src/camera/pose/flow.ts).
    const expectedYaw = (3 * STEP) / FOCAL_PX;

    const baseForward = quatRotateVec3(base.pose.rotation, { x: 0, y: 0, z: -1 });
    const forward = quatRotateVec3(visual.pose.rotation, { x: 0, y: 0, z: -1 });

    expect(baseForward.x).toBeCloseTo(0, 6);
    // Positive accumulated yaw (quatFromAxisAngle(+Y, yaw)) rotates the
    // forward vector from -Z towards -X.
    expect(expectedYaw).toBeGreaterThan(0);
    expect(forward.x).toBeLessThan(0);
    expect(Math.abs(forward.x)).toBeCloseTo(Math.sin(expectedYaw), 2);

    // rotation differs from the base while integrating.
    expect(visual.pose.rotation).not.toEqual(base.pose.rotation);
  });

  it('resetIntegration restores the base rotation', () => {
    const base = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: 0 });
    const visual = new VisualPoseSource(base, { integrateRotation: true });

    let t = 0;
    let shift = 0;
    visual.pushFrame(frameAt(shift, 0, t), intrinsics, t);
    visual.update(t);
    for (let i = 0; i < 3; i++) {
      t += 100;
      shift += 3;
      visual.pushFrame(frameAt(shift, 0, t), intrinsics, t);
      visual.update(t);
    }
    expect(visual.pose.rotation).not.toEqual(base.pose.rotation);

    visual.resetIntegration();
    visual.update(t);
    expect(visual.pose.rotation).toEqual(base.pose.rotation);
  });
});
