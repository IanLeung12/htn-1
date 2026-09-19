import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import { quatFromAxisAngle, quatMultiply, quatNormalize, quatRotateVec3 } from '@/core/math';
import { projectPoint } from '@/capture/geom';
import {
  FLOOR_SURFACE_ID,
  FloorPriorSurfaceEstimator,
  floorDepthForPixel,
  makeFloorSurface,
  pixelToRay,
  rayPlaneY,
} from '@/camera/surfaces/floor-prior';

describe('makeFloorSurface', () => {
  it('builds a square horizontal surface centered under the camera', () => {
    const s = makeFloorSurface(6, 42);
    expect(s.id).toBe(FLOOR_SURFACE_ID);
    expect(s.label).toBe('floor');
    expect(s.orientation).toBe('horizontal');
    expect(s.pose).toEqual({ position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT });
    expect(s.polygon).toHaveLength(4);
    for (const p of s.polygon) {
      expect(Math.abs(p.x)).toBeCloseTo(6, 6);
      expect(Math.abs(p.z)).toBeCloseTo(6, 6);
    }
    expect(s.aabb.min).toEqual({ x: -6, y: -0.01, z: -6 });
    expect(s.aabb.max).toEqual({ x: 6, y: 0.01, z: 6 });
    expect(s.lastChanged).toBe(42);
  });
});

function staticPose(heightM: number, pitchRad: number) {
  const yaw = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0);
  const pitch = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitchRad);
  return { position: { x: 0, y: heightM, z: 0 }, rotation: quatNormalize(quatMultiply(yaw, pitch)) };
}

describe('pixelToRay', () => {
  it('at the image center equals the camera forward', () => {
    const pose = staticPose(1.1, -0.35);
    const fovY = Math.PI / 4;
    const aspect = 16 / 9;
    const width = 640;
    const height = 480;
    const ray = pixelToRay(width / 2, height / 2, width, height, pose, fovY, aspect);
    expect(ray.origin).toEqual(pose.position);

    // Camera forward, computed independently via quatRotateVec3.
    const forward = quatRotateVec3(pose.rotation, { x: 0, y: 0, z: -1 });
    expect(ray.direction.x).toBeCloseTo(forward.x, 6);
    expect(ray.direction.y).toBeCloseTo(forward.y, 6);
    expect(ray.direction.z).toBeCloseTo(forward.z, 6);
  });
});

describe('rayPlaneY', () => {
  it('hits the floor at the expected point for a camera pitched down', () => {
    const heightM = 1.1;
    const pitchRad = -20 * (Math.PI / 180);
    const pose = staticPose(heightM, pitchRad);
    const fovY = Math.PI / 4;
    const aspect = 1;
    const ray = pixelToRay(320, 240, 640, 480, pose, fovY, aspect);
    const hit = rayPlaneY(ray.origin, ray.direction, 0);
    expect(hit).not.toBeNull();
    // Geometry: forward = (0, sin(pitch), -cos(pitch)); floor hit distance
    // along that ray is height / -sin(pitch) (pitch is negative -> looking down).
    const t = heightM / -Math.sin(pitchRad);
    const expectedZ = -t * Math.cos(pitchRad);
    expect(hit!.y).toBeCloseTo(0, 6);
    expect(hit!.x).toBeCloseTo(0, 5);
    expect(hit!.z).toBeCloseTo(expectedZ, 4);
  });

  it('returns null for a ray parallel to the plane', () => {
    expect(rayPlaneY({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 0)).toBeNull();
  });

  it('returns null when the intersection is behind the origin', () => {
    expect(rayPlaneY({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 0)).toBeNull();
  });
});

describe('floorDepthForPixel', () => {
  const pose = staticPose(1.1, -20 * (Math.PI / 180));
  const fovY = Math.PI / 4;
  const aspect = 16 / 9;
  const width = 640;
  const height = 480;

  it('round-trips with projectPoint', () => {
    // Pick a floor point known to be in front of and below the camera.
    const floorPoint = { x: 0.5, y: 0, z: -3 };
    const proj = projectPoint(floorPoint, pose, fovY, aspect, width, height);
    expect(proj).not.toBeNull();

    const depth = floorDepthForPixel(proj!.x, proj!.y, width, height, pose, fovY, aspect, 0);
    expect(depth).not.toBeNull();
    expect(depth!).toBeCloseTo(proj!.depth, 6);
  });

  it('returns null for pixels above the horizon', () => {
    // Top row of the frame, looking well above the horizon.
    const depth = floorDepthForPixel(width / 2, 0, width, height, pose, fovY, aspect, 0);
    expect(depth).toBeNull();
  });
});

describe('FloorPriorSurfaceEstimator', () => {
  it('publishes a single floor prior surface and never allocates on update', () => {
    const est = new FloorPriorSurfaceEstimator({ cameraHeightM: 1.1 });
    expect(est.surfaces).toHaveLength(1);
    expect(est.surfaces[0]!.origin).toBe('prior');
    expect(est.surfaces[0]!.confidence).toBe(1);
    expect(est.surfaces[0]!.surface.id).toBe(FLOOR_SURFACE_ID);
    expect(est.volumes).toEqual([]);
    expect(est.cameraHeightM).toBe(1.1);

    const surfacesBefore = est.surfaces;
    est.update(undefined, staticPose(1.1, 0), 100);
    expect(est.surfaces).toBe(surfacesBefore);

    est.setHeight(1.5);
    expect(est.cameraHeightM).toBe(1.5);
  });
});
