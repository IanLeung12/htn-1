import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import type { Pose, Vec3 } from '@/core/types';
import { quatFromAxisAngle, quatNormalize } from '@/core/math';
import { frameViewProjection, projectPoint } from '@/capture/geom';

/**
 * Apply a column-major 4x4 matrix (as returned by `frameViewProjection`) to a
 * world point and map clip space to the same pixel convention `projectPoint`
 * uses, so this test can assert the two independently-derived paths (the CPU
 * `projectPoint` pinhole model vs. the GPU-shared view-projection matrix)
 * agree on where a point lands.
 */
function pixelFromViewProjection(m: Float32Array, point: Vec3, width: number, height: number): { x: number; y: number } | null {
  const cx = m[0]! * point.x + m[4]! * point.y + m[8]! * point.z + m[12]!;
  const cy = m[1]! * point.x + m[5]! * point.y + m[9]! * point.z + m[13]!;
  const cw = m[3]! * point.x + m[7]! * point.y + m[11]! * point.z + m[15]!;
  if (cw <= 0) return null;
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  return { x: (ndcX * 0.5 + 0.5) * width, y: (1 - (ndcY * 0.5 + 0.5)) * height };
}

describe('frameViewProjection', () => {
  const width = 320;
  const height = 240;
  const fovY = Math.PI / 3;
  const aspect = width / height;

  const cases: { name: string; pose: Pose; point: Vec3 }[] = [
    {
      name: 'identity pose, point straight ahead',
      pose: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT },
      point: { x: 0.3, y: -0.2, z: -3 },
    },
    {
      name: 'translated + yawed camera, off-axis point',
      pose: {
        position: { x: 1.5, y: 1.6, z: -0.8 },
        rotation: quatNormalize(quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.7)),
      },
      point: { x: -0.4, y: 1.9, z: -2.1 },
    },
    {
      name: 'pitched-down camera (top-down-ish), point below',
      pose: {
        position: { x: 0, y: 2.2, z: 0.5 },
        rotation: quatNormalize(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -1.1)),
      },
      point: { x: 0.1, y: 0, z: 0.2 },
    },
  ];

  for (const { name, pose, point } of cases) {
    it(`matches projectPoint's pixel for: ${name}`, () => {
      const expected = projectPoint(point, pose, fovY, aspect, width, height);
      const m = frameViewProjection({ pose, fovY, aspect });
      const actual = pixelFromViewProjection(m, point, width, height);

      expect(expected).not.toBeNull();
      expect(actual).not.toBeNull();
      expect(actual!.x).toBeCloseTo(expected!.x, 3);
      expect(actual!.y).toBeCloseTo(expected!.y, 3);
    });
  }

  it('returns w <= 0 (behind camera) for a point projectPoint also rejects', () => {
    const pose: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT };
    const point: Vec3 = { x: 0, y: 0, z: 5 }; // behind camera (camera looks down -Z)
    expect(projectPoint(point, pose, fovY, aspect, width, height)).toBeNull();
    const m = frameViewProjection({ pose, fovY, aspect });
    expect(pixelFromViewProjection(m, point, width, height)).toBeNull();
  });
});
