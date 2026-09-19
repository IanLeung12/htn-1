import { describe, expect, it } from 'vitest';
import { quatRotateVec3 } from '@/core/math';
import { StaticPoseSource } from '@/camera/pose/static';
import { quatFromDeviceOrientation, removeYaw, yawOf } from '@/camera/pose/orientation-math';

describe('StaticPoseSource', () => {
  it('looks along -Z at pitch 0', () => {
    const src = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: 0 });
    const forward = quatRotateVec3(src.pose.rotation, { x: 0, y: 0, z: -1 });
    expect(forward.x).toBeCloseTo(0, 6);
    expect(forward.y).toBeCloseTo(0, 6);
    expect(forward.z).toBeCloseTo(-1, 6);
    expect(src.pose.position).toEqual({ x: 0, y: 1.1, z: 0 });
  });

  it('looks downward at negative pitch', () => {
    const src = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: -0.35 });
    const forward = quatRotateVec3(src.pose.rotation, { x: 0, y: 0, z: -1 });
    expect(forward.y).toBeLessThan(0);
    expect(forward.z).toBeLessThan(0);
  });

  it('setHeight/setPitch/setYaw recompute the pose', () => {
    const src = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: 0 });
    src.setHeight(1.4);
    expect(src.pose.position.y).toBeCloseTo(1.4, 6);

    src.setPitch(-0.5);
    const forward = quatRotateVec3(src.pose.rotation, { x: 0, y: 0, z: -1 });
    expect(forward.y).toBeLessThan(0);
  });

  it('yaw rotates the heading', () => {
    const src = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: 0 });
    src.setYaw(Math.PI / 2);
    const forward = quatRotateVec3(src.pose.rotation, { x: 0, y: 0, z: -1 });
    // Rotating the -Z heading by +90deg about Y should point roughly at -X.
    expect(forward.x).toBeCloseTo(-1, 5);
    expect(forward.z).toBeCloseTo(0, 5);
  });

  it('quality reports full static confidence and no per-frame allocation on update', () => {
    const src = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: 0 });
    expect(src.quality).toEqual({ mode: 'static', confidence: 1, trackingOk: true, driftM: 0, sampleAgeMs: 0 });
    const poseBefore = src.pose;
    src.update(1234);
    expect(src.pose).toBe(poseBefore);
  });
});

describe('quatFromDeviceOrientation', () => {
  it('phone flat on a table (beta=0,gamma=0) looks straight down', () => {
    const q = quatFromDeviceOrientation(0, 0, 0, 0);
    const forward = quatRotateVec3(q, { x: 0, y: 0, z: -1 });
    expect(forward.x).toBeCloseTo(0, 6);
    expect(forward.y).toBeCloseTo(-1, 6);
    expect(forward.z).toBeCloseTo(0, 6);
  });

  it('phone held upright in portrait (beta=90) looks out horizontally', () => {
    const q = quatFromDeviceOrientation(0, 90, 0, 0);
    const forward = quatRotateVec3(q, { x: 0, y: 0, z: -1 });
    expect(forward.y).toBeCloseTo(0, 5);
    expect(forward.z).toBeCloseTo(-1, 5);
  });

  it('alpha rotates the heading about +Y', () => {
    const q0 = quatFromDeviceOrientation(0, 90, 0, 0);
    const q90 = quatFromDeviceOrientation(90, 90, 0, 0);
    const f0 = quatRotateVec3(q0, { x: 0, y: 0, z: -1 });
    const f90 = quatRotateVec3(q90, { x: 0, y: 0, z: -1 });
    expect(f0.z).toBeCloseTo(-1, 5);
    // A 90 degree change in alpha should turn the heading by ~90 degrees.
    const cosAngle = f0.x * f90.x + f0.y * f90.y + f0.z * f90.z;
    expect(cosAngle).toBeCloseTo(0, 3);
  });
});

describe('yawOf / removeYaw', () => {
  it('yawOf is 0 for a pure -Z heading', () => {
    const q = quatFromDeviceOrientation(0, 90, 0, 0);
    expect(yawOf(q)).toBeCloseTo(0, 5);
  });

  it('removeYaw maps a yawed quaternion back to a -Z heading', () => {
    const q = quatFromDeviceOrientation(50, 90, 0, 0); // alpha=50 introduces some heading
    const yaw = yawOf(q);
    const corrected = removeYaw(q, yaw);
    const forward = quatRotateVec3(corrected, { x: 0, y: 0, z: -1 });
    expect(forward.x).toBeCloseTo(0, 5);
    expect(forward.z).toBeCloseTo(-1, 5);
    expect(yawOf(corrected)).toBeCloseTo(0, 5);
  });
});
