import { describe, expect, it } from 'vitest';
import { angleBetween, pointerRayFromPose } from '@/camera/ray';
import { quatFromAxisAngle, quatRotateVec3 } from '@/core/math';
import { poseFromColumnMajor } from '@/camera/zedsdk/protocol';

describe('pointer ray from a tracked pose', () => {
  const pitch = (-6 * Math.PI) / 180;
  const pose = { position: { x: 0, y: 0.11, z: 0 }, rotation: quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitch) };
  const fovY = 2 * Math.atan(360 / 527.4);
  const aspect = 16 / 9;

  it('centre pixel: origin is the pose position and the direction is the camera forward', () => {
    const ray = pointerRayFromPose(pose, fovY, aspect, 0, 0);
    expect(ray.origin).toEqual(pose.position);
    const forward = quatRotateVec3(pose.rotation, { x: 0, y: 0, z: -1 });
    expect((angleBetween(ray.direction, forward) * 180) / Math.PI).toBeLessThan(1);
    expect(ray.direction.y).toBeCloseTo(Math.sin(pitch), 6);
  });

  it('corner pixels spread by the field of view', () => {
    const level = { position: { x: 1, y: 0.5, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const top = pointerRayFromPose(level, fovY, aspect, 0, 1);
    const bottom = pointerRayFromPose(level, fovY, aspect, 0, -1);
    expect((angleBetween(top.direction, bottom.direction) * 180) / Math.PI).toBeCloseTo((fovY * 180) / Math.PI, 6);
    const right = pointerRayFromPose(level, fovY, aspect, 1, 0);
    expect(right.direction.x).toBeGreaterThan(0);
    expect(right.origin).toEqual(level.position);
  });

  it('follows a bridge pose matrix without an axis swap', () => {
    // Column-major camera-to-world: pitched down 6 deg at (0, 0.11, 0), as the bridge sends it.
    const c = Math.cos(pitch);
    const s = Math.sin(pitch);
    const m = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0.11, 0, 1];
    const tracked = poseFromColumnMajor(m);
    const ray = pointerRayFromPose(tracked, fovY, aspect, 0, 0);
    expect(ray.origin.y).toBeCloseTo(0.11, 9);
    expect(ray.direction.y).toBeCloseTo(Math.sin(pitch), 6);
    expect(ray.direction.z).toBeCloseTo(-Math.cos(pitch), 6);
  });
});
