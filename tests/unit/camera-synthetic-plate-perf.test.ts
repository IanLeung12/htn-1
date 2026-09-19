/**
 * A sparse donor ring (a few percent of ring texels observed, as on a cluttered desk seen
 * by the ZED) must fill the 128x128 plate in well under a second: the bucket ring search
 * previously ringed outward through empty buckets per texel and blocked Discover for ~20 s.
 */
import { describe, expect, it } from 'vitest';
import type { CameraFrame } from '@/capture/contract';
import type { EditableObject } from '@/core/types';
import { synthesizeSupportPlate } from '@/camera/synthetic-plate';
import { createPlateTextureRegistry } from '@/capture/registry';

function frameLookingDown(width: number, height: number, sparse: number): CameraFrame {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    // Only every `sparse`-th pixel carries a valid depth; the rest are holes.
    depth[i] = i % sparse === 0 ? 1.0 : 0;
    rgba[i * 4] = 120;
    rgba[i * 4 + 1] = 110;
    rgba[i * 4 + 2] = 100;
    rgba[i * 4 + 3] = 255;
  }
  // Camera 1 m above the origin looking straight down (-Y): rotation of -90 deg about X.
  const s = Math.SQRT1_2;
  return { width, height, rgba, depth, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: -s, y: 0, z: 0, w: s } }, fovY: 1.0, aspect: width / height, timestamp: 1 };
}

describe('synthesizeSupportPlate with a sparse donor ring', () => {
  it('fills the plate in under 500 ms', () => {
    const object = { id: 'obj:sparse', originalPose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } } as unknown as EditableObject;
    const region = { min: { x: -0.1, y: 0, z: -0.1 }, max: { x: 0.1, y: 0, z: 0.1 } };
    const frame = frameLookingDown(320, 180, 37);
    const t0 = performance.now();
    const { plate, donorFraction } = synthesizeSupportPlate(object, region, frame, { registry: createPlateTextureRegistry() });
    const ms = performance.now() - t0;
    expect(donorFraction).toBeGreaterThan(0);
    expect(donorFraction).toBeLessThan(0.2);
    expect(plate.provenance).toBe('synthetic_completion');
    expect(ms).toBeLessThan(500);
  });
});
