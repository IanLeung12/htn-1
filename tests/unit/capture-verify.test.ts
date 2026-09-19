import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import type { EditableObject, Surface } from '@/core/types';
import { acquireCleanPlate } from '@/capture/plates';
import { verify } from '@/capture/verify';
import { createPlateTextureRegistry } from '@/capture/registry';
import { quatFromAxisAngle } from '@/core/math';
import { makeSequentialSource } from './helpers/syntheticCamera';
import type { ColoredBox } from './helpers/syntheticCamera';

const TABLE_COLOR: [number, number, number] = [139, 69, 19];

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

const topDownRotation = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);
const height = 1.7;

describe('verify', () => {
  it('keeps the tier when off-path viewpoints confirm the same coverage', async () => {
    const registry = createPlateTextureRegistry();
    const fullFovY = 2 * Math.atan(0.1 / height);
    const capturePose = { position: { x: 0, y: 0.8 + height, z: 0 }, rotation: topDownRotation };
    const acquireSource = makeSequentialSource([capturePose], fullFovY, 1, 64, 64, [tableTopBox]);
    const req = { object: baseObject(), supportSurface: tableSurface, viewpoints: [capturePose] };
    const result = await acquireCleanPlate(req, acquireSource, { registry, textureSize: 32, now: () => 0 });
    expect(result.object.tier).toBe('A');

    const offPath = { position: { x: 0.01, y: 0.8 + height, z: 0 }, rotation: topDownRotation };
    const verifySource = makeSequentialSource([offPath], fullFovY, 1, 64, 64, [tableTopBox]);
    const verified = await verify(result, [offPath], verifySource, { registry });

    expect(verified.tier).toBe('A');
    expect(verified.tierConfidence).toBeGreaterThanOrEqual(0.85);
  });

  it('lowers the tier when an off-path viewpoint reveals texels the plate never observed', async () => {
    const registry = createPlateTextureRegistry();
    // Acquire with a narrow, shifted view: only half the region is ever observed.
    const narrowFovY = 2 * Math.atan(0.1 / height);
    const capturePose = { position: { x: 0.1, y: 0.8 + height, z: 0 }, rotation: topDownRotation };
    const acquireSource = makeSequentialSource([capturePose], narrowFovY, 1, 64, 64, [tableTopBox]);
    const req = { object: baseObject(), supportSurface: tableSurface, viewpoints: [capturePose] };
    const result = await acquireCleanPlate(req, acquireSource, { registry, textureSize: 32, now: () => 0 });
    expect(['B', 'C']).toContain(result.object.tier);

    // Off-path viewpoint sees the FULL footprint (wide fov, centered) -> half
    // of what it sees was never part of the baked plate.
    const wideFovY = 2 * Math.atan(0.12 / height);
    const offPath = { position: { x: 0, y: 0.8 + height, z: 0 }, rotation: topDownRotation };
    const verifySource = makeSequentialSource([offPath], wideFovY, 1, 64, 64, [tableTopBox]);
    const verified = await verify(result, [offPath], verifySource, { registry });

    const tierOrder = ['A', 'B', 'C', 'D', 'E'];
    expect(tierOrder.indexOf(verified.tier)).toBeGreaterThan(tierOrder.indexOf(result.object.tier));
    expect(verified.tierConfidence).toBeLessThan(0.6);
  });

  it('returns the object unchanged when there is no camera source or no off-path viewpoints', async () => {
    const registry = createPlateTextureRegistry();
    const capturePose = { position: { x: 0, y: 0.8 + height, z: 0 }, rotation: topDownRotation };
    const fovY = 2 * Math.atan(0.1 / height);
    const acquireSource = makeSequentialSource([capturePose], fovY, 1, 64, 64, [tableTopBox]);
    const req = { object: baseObject(), supportSurface: tableSurface, viewpoints: [capturePose] };
    const result = await acquireCleanPlate(req, acquireSource, { registry, textureSize: 16, now: () => 0 });

    const verified = await verify(result, [], acquireSource, { registry });
    expect(verified.tier).toBe(result.object.tier);
  });
});
