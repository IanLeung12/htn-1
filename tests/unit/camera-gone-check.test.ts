/**
 * Unit tests for the `Capture plate` "is it actually gone?" check
 * (src/camera/edit/gone-check.ts), using the same synthetic scene as
 * tests/e2e/camera-capture.spec.ts: `syntheticSceneDepth(true)` has the box
 * still on the desk, `syntheticSceneDepth(false)` has it removed (floor/wall
 * only).
 */
import { describe, expect, it } from 'vitest';
import type { EditableObject, Surface } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { checkObjectGone } from '@/camera/edit/gone-check';
import { computeSilhouetteMask, depthFrameFromMap } from '@/camera/edit/silhouette';
import { BOX, syntheticSceneDepth } from './helpers/synthetic-scene';

const BOX_CENTER = {
  x: (BOX.min.x + BOX.max.x) / 2,
  y: (BOX.min.y + BOX.max.y) / 2,
  z: (BOX.min.z + BOX.max.z) / 2,
};
const BOX_HALF_EXTENTS = {
  x: (BOX.max.x - BOX.min.x) / 2,
  y: (BOX.max.y - BOX.min.y) / 2,
  z: (BOX.max.z - BOX.min.z) / 2,
};

function boxObject(): EditableObject {
  return {
    id: 'obj:can',
    label: 'other',
    userName: 'can',
    origin: 'physical',
    originalPose: { position: BOX_CENTER, rotation: IDENTITY_QUAT },
    currentPose: { position: BOX_CENTER, rotation: IDENTITY_QUAT },
    visual: { kind: 'baked' },
    interactionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    collisionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    occlusionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    supportSurfaces: ['camera-floor'],
    background: [],
    provenance: { method: 'guided_clean_plate', capturedAt: 0, capturePath: [] },
    tier: 'D',
    tierConfidence: 0.6,
    envelope: { center: BOX_CENTER, radius: 1.5, maxAngle: 1.0 },
    physical: { massKg: 0.3, friction: 0.6, restitution: 0.1, kinematic: false },
    approved: true,
    visible: true,
  };
}

const FLOOR_SURFACE: Surface = {
  id: 'camera-floor',
  label: 'table',
  orientation: 'horizontal',
  pose: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT },
  polygon: [],
  aabb: { min: { x: -5, y: -0.01, z: -5 }, max: { x: 5, y: 0.01, z: 5 } },
  lastChanged: 0,
};

describe('checkObjectGone', () => {
  it('reports NOT gone while the object is still on the desk', () => {
    const map = syntheticSceneDepth(true);
    const df = depthFrameFromMap(map);
    const obj = boxObject();
    const mask = computeSilhouetteMask(df, obj);

    const result = checkObjectGone(df, obj, FLOOR_SURFACE, mask?.blobDepthM);
    expect(result.gone).toBe(false);
    expect(result.reason).toBe('still-present');
    expect(result.stillPresentFraction).toBeGreaterThan(0);
  });

  it('reports gone once the depth shows the plane where the object was', () => {
    const withBox = syntheticSceneDepth(true);
    const dfWithBox = depthFrameFromMap(withBox);
    const obj = boxObject();
    const previousBlobDepthM = computeSilhouetteMask(dfWithBox, obj)?.blobDepthM;

    const empty = syntheticSceneDepth(false);
    const dfEmpty = depthFrameFromMap(empty);
    const result = checkObjectGone(dfEmpty, obj, FLOOR_SURFACE, previousBlobDepthM);
    expect(result.gone).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.atPlaneFraction).toBeGreaterThan(0.6);
  });

  it('refuses to judge when the footprint is not observed at all', () => {
    const map = syntheticSceneDepth(false);
    const df = depthFrameFromMap(map);
    // An object far outside the frame: no footprint sample lands in view.
    const obj = boxObject();
    obj.originalPose = { position: { x: 500, y: 0, z: 500 }, rotation: IDENTITY_QUAT };
    const result = checkObjectGone(df, obj, FLOOR_SURFACE, undefined);
    expect(result.gone).toBe(false);
    expect(result.reason).toBe('no-depth-for-footprint');
  });
});
