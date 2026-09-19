import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import { getDepthMeshGeometry } from '@/render/depth-mesh';

function makeFlatFrame(width: number, height: number, depth: number): CameraFrame {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  const depthBuf = new Float32Array(width * height).fill(depth);
  return {
    width,
    height,
    rgba,
    depth: depthBuf,
    pose: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT },
    fovY: Math.PI / 2, // 90 degrees vertical
    aspect: 1,
    timestamp: 0,
  };
}

describe('getDepthMeshGeometry', () => {
  it('builds an unfiltered mesh spanning the whole frame when no box is given', () => {
    const frame = makeFlatFrame(20, 20, 2);
    const geometry = getDepthMeshGeometry(frame);
    expect(geometry).not.toBeNull();
    expect(geometry!.getIndex()!.count).toBeGreaterThan(0);
  });

  it('keepInsideBox drops triangles whose centroid falls outside the box', () => {
    const frame = makeFlatFrame(20, 20, 2);
    // Looking straight down -Z from the origin with a 90 degree vertical fov
    // at depth=2, tan(45deg)=1 so the frame spans roughly x,y in [-2, 2].
    // A box covering only the left half (x <= 0) should shed close to half
    // the triangles of the unfiltered mesh, and every surviving triangle's
    // centroid must truly sit inside the box.
    const full = getDepthMeshGeometry(frame);
    const half = getDepthMeshGeometry(frame, { min: { x: -10, y: -10, z: -10 }, max: { x: 0, y: 10, z: 10 } });

    expect(full).not.toBeNull();
    expect(half).not.toBeNull();
    expect(half!.getIndex()!.count).toBeGreaterThan(0);
    expect(half!.getIndex()!.count).toBeLessThan(full!.getIndex()!.count);

    const position = half!.getAttribute('position');
    const index = half!.getIndex()!;
    for (let t = 0; t < index.count / 3; t++) {
      const a = index.getX(t * 3);
      const b = index.getX(t * 3 + 1);
      const c = index.getX(t * 3 + 2);
      const cx = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
      expect(cx).toBeLessThanOrEqual(0.01);
    }
  });

  it('a box excluding the whole frame yields no geometry', () => {
    const frame = makeFlatFrame(20, 20, 2);
    const outside = getDepthMeshGeometry(frame, { min: { x: 100, y: 100, z: 100 }, max: { x: 101, y: 101, z: 101 } });
    expect(outside).toBeNull();
  });

  it('caches per (frame, box signature) independently - an unfiltered and a filtered call on the same frame do not clobber each other', () => {
    const frame = makeFlatFrame(20, 20, 2);
    const a1 = getDepthMeshGeometry(frame);
    const b1 = getDepthMeshGeometry(frame, { min: { x: -10, y: -10, z: -10 }, max: { x: 0, y: 10, z: 10 } });
    const a2 = getDepthMeshGeometry(frame);
    const b2 = getDepthMeshGeometry(frame, { min: { x: -10, y: -10, z: -10 }, max: { x: 0, y: 10, z: 10 } });
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).not.toBe(b1);
  });
});
