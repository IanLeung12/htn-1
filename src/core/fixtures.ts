/**
 * Test/dev fixtures: sane defaults for building EditableObject / BackgroundPlate /
 * Surface / RuntimeConditions / SceneSnapshot values quickly. Used by unit tests
 * and by other modules (sim, capture) that want a quick starting point.
 */
import type {
  BackgroundPlate,
  EditableObject,
  RuntimeConditions,
  SceneSnapshot,
  Surface,
} from './types';
import { IDENTITY_QUAT } from './types';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function makePlate(partial?: Partial<BackgroundPlate>): BackgroundPlate {
  return {
    id: partial?.id ?? nextId('plate'),
    provenance: 'observed_clean_plate',
    version: 'observed_v1',
    region: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 0.1, z: 1 } },
    coverage: 1.0,
    envelope: { center: { x: 0, y: 1.5, z: 1 }, radius: 5, maxAngle: Math.PI },
    ...partial,
  };
}

export function makeSurface(partial?: Partial<Surface>): Surface {
  return {
    id: partial?.id ?? nextId('surface'),
    label: 'table',
    orientation: 'horizontal',
    pose: { position: { x: 0, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } },
    polygon: [
      { x: -1, z: -1 },
      { x: 1, z: -1 },
      { x: 1, z: 1 },
      { x: -1, z: 1 },
    ],
    aabb: { min: { x: -1, y: -0.05, z: -1 }, max: { x: 1, y: 0.05, z: 1 } },
    lastChanged: 0,
    ...partial,
  };
}

export function makeObject(partial?: Partial<EditableObject>): EditableObject {
  const id = partial?.id ?? nextId('object');
  const pose = partial?.originalPose ?? { position: { x: 0, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } };
  return {
    id,
    label: 'lamp',
    userName: 'Lamp',
    origin: 'physical',
    originalPose: pose,
    currentPose: pose,
    visual: { kind: 'primitive', color: 0xffffff },
    interactionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    collisionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    occlusionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    supportSurfaces: [],
    background: [makePlate()],
    provenance: {
      method: 'guided_clean_plate',
      capturedAt: 0,
      capturePath: [{ position: { x: 0, y: 1.5, z: 1 }, rotation: { ...IDENTITY_QUAT } }],
    },
    tier: 'A',
    tierConfidence: 1,
    envelope: { center: { x: 0, y: 1.5, z: 1 }, radius: 5, maxAngle: Math.PI },
    physical: { massKg: 1, friction: 0.5, restitution: 0.1, kinematic: false },
    approved: true,
    visible: true,
    ...partial,
  };
}

export function makeConditions(partial?: Partial<RuntimeConditions>): RuntimeConditions {
  return {
    now: 1000,
    headPose: { position: { x: 0, y: 1.5, z: 1 }, rotation: { ...IDENTITY_QUAT } },
    trackingOk: true,
    localizedAnchors: new Set<string>(),
    depthAgeMs: 0,
    tier: 2,
    ...partial,
  };
}

export function makeSnapshot(partial?: Partial<SceneSnapshot>): SceneSnapshot {
  return {
    version: 1,
    committedAt: 0,
    mode: 'live-overlay',
    objects: {},
    surfaces: {},
    regions: {},
    ...partial,
  };
}
