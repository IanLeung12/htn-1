import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import { projectPoint, inFrame } from '@/capture/geom';

describe('projectPoint', () => {
  const pose = { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT };
  const fovY = Math.PI / 2;
  const aspect = 1;
  const width = 64;
  const height = 64;

  it('projects a point directly in front of the camera to the frame center', () => {
    const proj = projectPoint({ x: 0, y: 0, z: -5 }, pose, fovY, aspect, width, height);
    expect(proj).not.toBeNull();
    expect(proj!.depth).toBeCloseTo(5, 6);
    expect(proj!.x).toBeCloseTo(width / 2, 1);
    expect(proj!.y).toBeCloseTo(height / 2, 1);
    expect(inFrame(proj!, width, height)).toBe(true);
  });

  it('returns null for a point behind the camera', () => {
    const proj = projectPoint({ x: 0, y: 0, z: 5 }, pose, fovY, aspect, width, height);
    expect(proj).toBeNull();
  });

  it('offsets off-axis points to the correct side of the frame', () => {
    // +x in world with identity rotation should land right-of-center.
    const proj = projectPoint({ x: 1, y: 0, z: -5 }, pose, fovY, aspect, width, height);
    expect(proj).not.toBeNull();
    expect(proj!.x).toBeGreaterThan(width / 2);

    // +y (up) should land above center (smaller pixel y, since row 0 is top).
    const projUp = projectPoint({ x: 0, y: 1, z: -5 }, pose, fovY, aspect, width, height);
    expect(projUp).not.toBeNull();
    expect(projUp!.y).toBeLessThan(height / 2);
  });

  it('reports out-of-frustum points as not in-frame', () => {
    const proj = projectPoint({ x: 100, y: 0, z: -5 }, pose, fovY, aspect, width, height);
    expect(proj).not.toBeNull();
    expect(inFrame(proj!, width, height)).toBe(false);
  });
});
