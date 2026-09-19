import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import type { EditableObject, Surface } from '@/core/types';
import { acquireCleanPlate } from '@/capture/plates';
import { createPlateTextureRegistry } from '@/capture/registry';
import { quatFromAxisAngle } from '@/core/math';
import { makeSequentialSource, makeUnavailableSource } from './helpers/syntheticCamera';
import type { ColoredBox } from './helpers/syntheticCamera';

const TABLE_COLOR: [number, number, number] = [139, 69, 19];
const LAMP_COLOR: [number, number, number] = [200, 30, 30];

const tableSurface: Surface = {
  id: 'surf:table',
  label: 'table',
  orientation: 'horizontal',
  pose: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT },
  polygon: [],
  aabb: { min: { x: -0.6, y: 0.79, z: -0.6 }, max: { x: 0.6, y: 0.8, z: 0.6 } },
  lastChanged: 0,
};

const tableTopBox: ColoredBox = {
  aabb: { min: { x: -0.6, y: 0.75, z: -0.6 }, max: { x: 0.6, y: 0.8, z: 0.6 } },
  color: TABLE_COLOR,
};

const lampBox: ColoredBox = {
  aabb: { min: { x: -0.1, y: 0.8, z: -0.1 }, max: { x: 0.1, y: 1.0, z: 0.1 } },
  color: LAMP_COLOR,
};

function baseObject(): EditableObject {
  return {
    id: 'obj:lamp1',
    label: 'lamp',
    userName: 'lamp 1',
    origin: 'physical',
    originalPose: { position: { x: 0, y: 0.9, z: 0 }, rotation: IDENTITY_QUAT },
    currentPose: { position: { x: 0, y: 0.9, z: 0 }, rotation: IDENTITY_QUAT },
    visual: { kind: 'primitive' },
    interactionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    collisionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    occlusionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    supportSurfaces: ['surf:table'],
    background: [],
    provenance: { method: 'scene_volume', capturedAt: 0, capturePath: [] },
    tier: 'E',
    tierConfidence: 0.5,
    envelope: { center: { x: 0, y: 0.9, z: 0 }, radius: 2.5, maxAngle: 1.2 },
    physical: { massKg: 3, friction: 0.6, restitution: 0.1, kinematic: false },
    approved: true,
    visible: true,
  };
}

// Top-down camera: forward = -Y, achieved by a -90deg rotation about X.
const topDownRotation = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);

describe('acquireCleanPlate', () => {
  it('returns tier E / unavailable plate when no camera source is available', async () => {
    const registry = createPlateTextureRegistry();
    const req = { object: baseObject(), supportSurface: tableSurface, viewpoints: [] };
    const result = await acquireCleanPlate(req, makeUnavailableSource(), { registry, textureSize: 16, now: () => 0 });

    expect(result.plate.provenance).toBe('unavailable');
    expect(result.plate.version).toBe('invalidated');
    expect(result.plate.coverage).toBe(0);
    expect(result.object.tier).toBe('E');
  });

  it('reports ~0 coverage and tier E when the object is still present (depth mismatch)', async () => {
    const registry = createPlateTextureRegistry();
    const pose = { position: { x: 0, y: 2.5, z: 0 }, rotation: topDownRotation };
    const source = makeSequentialSource([pose], 1.2, 1, 64, 64, [tableTopBox, lampBox]);
    const req = { object: baseObject(), supportSurface: tableSurface, viewpoints: [pose] };

    const result = await acquireCleanPlate(req, source, { registry, textureSize: 16, now: () => 0 });

    expect(result.plate.coverage).toBeLessThan(0.1);
    expect(result.object.tier).toBe('E');
    expect(result.plate.provenance).toBe('unavailable');
  });

  it('reports ~1 coverage and tier A when the object is removed and fully observed top-down', async () => {
    const registry = createPlateTextureRegistry();
    const pose = { position: { x: 0, y: 2.5, z: 0 }, rotation: topDownRotation };
    const source = makeSequentialSource([pose], 1.2, 1, 64, 64, [tableTopBox]);
    const req = { object: baseObject(), supportSurface: tableSurface, viewpoints: [pose] };

    const result = await acquireCleanPlate(req, source, { registry, textureSize: 16, now: () => 0 });

    expect(result.plate.coverage).toBeGreaterThan(0.9);
    expect(result.object.tier).toBe('A');
    expect(result.plate.provenance).toBe('observed_clean_plate');
    expect(result.plate.textureRef).toBeDefined();

    const baked = registry.get(result.plate.textureRef!);
    expect(baked).toBeDefined();
    // Sample a texel near the center; it should match the table color (alpha 255).
    const cx = Math.floor(baked!.width / 2);
    const cy = Math.floor(baked!.height / 2);
    const idx = (cy * baked!.width + cx) * 4;
    expect(baked!.rgba[idx]).toBeCloseTo(TABLE_COLOR[0], -1);
    expect(baked!.rgba[idx + 1]).toBeCloseTo(TABLE_COLOR[1], -1);
    expect(baked!.rgba[idx + 2]).toBeCloseTo(TABLE_COLOR[2], -1);
    expect(baked!.rgba[idx + 3]).toBe(255);
  });

  it('reports partial coverage (constrained/multi-view) when only half the region is in view', async () => {
    const registry = createPlateTextureRegistry();
    // Narrow FOV tailored to the 0.2m-wide footprint, then shift the camera by
    // half that width so only x in [0, 0.1] of the [-0.1, 0.1] region is seen.
    const height = 1.7;
    const fovY = 2 * Math.atan(0.1 / height);
    const pose = { position: { x: 0.1, y: 0.8 + height, z: 0 }, rotation: topDownRotation };
    const source = makeSequentialSource([pose], fovY, 1, 64, 64, [tableTopBox]);
    const req = { object: baseObject(), supportSurface: tableSurface, viewpoints: [pose] };

    const result = await acquireCleanPlate(req, source, { registry, textureSize: 16, now: () => 0 });

    expect(result.plate.coverage).toBeGreaterThan(0.25);
    expect(result.plate.coverage).toBeLessThan(0.75);
    expect(['B', 'C']).toContain(result.object.tier);
  });
});
