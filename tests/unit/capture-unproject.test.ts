import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import { quatFromAxisAngle } from '@/core/math';
import { projectPoint, unprojectPixel } from '@/capture/geom';

describe('unprojectPixel', () => {
  const fovY = Math.PI / 2;
  const aspect = 4 / 3;
  const width = 320;
  const height = 240;

  it('round-trips pixel -> world -> pixel for an identity-pose camera', () => {
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT };
    const samples: Array<{ x: number; y: number; depth: number }> = [
      { x: width / 2, y: height / 2, depth: 1 },
      { x: 10, y: 5, depth: 2.5 },
      { x: width - 1, y: height - 1, depth: 4 },
      { x: 0, y: 0, depth: 0.5 },
      { x: width * 0.25, y: height * 0.75, depth: 3.2 },
    ];

    for (const s of samples) {
      const world = unprojectPixel(s.x, s.y, s.depth, pose, fovY, aspect, width, height);
      const proj = projectPoint(world, pose, fovY, aspect, width, height);
      expect(proj).not.toBeNull();
      expect(proj!.x).toBeCloseTo(s.x, 3);
      expect(proj!.y).toBeCloseTo(s.y, 3);
      expect(proj!.depth).toBeCloseTo(s.depth, 5);
    }
  });

  it('round-trips for an arbitrary translated + rotated camera pose', () => {
    const pose = {
      position: { x: 1.2, y: 1.6, z: -0.4 },
      rotation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 6),
    };
    const samples: Array<{ x: number; y: number; depth: number }> = [
      { x: 40, y: 30, depth: 1.8 },
      { x: 200, y: 120, depth: 0.9 },
      { x: 5, y: 200, depth: 6 },
    ];

    for (const s of samples) {
      const world = unprojectPixel(s.x, s.y, s.depth, pose, fovY, aspect, width, height);
      const proj = projectPoint(world, pose, fovY, aspect, width, height);
      expect(proj).not.toBeNull();
      expect(proj!.x).toBeCloseTo(s.x, 3);
      expect(proj!.y).toBeCloseTo(s.y, 3);
      expect(proj!.depth).toBeCloseTo(s.depth, 5);
    }
  });
});
