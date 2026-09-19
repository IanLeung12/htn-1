/**
 * Unit tests for the per-object depth-blob silhouette mask and tracker
 * (src/camera/edit/silhouette.ts). Uses the same synthetic floor+box+wall
 * scene as tests/e2e/camera-capture.spec.ts (see
 * tests/unit/helpers/synthetic-scene.ts) so the mask is checked against a
 * depth map that looks like a real discovered object on a desk.
 */
import { describe, expect, it } from 'vitest';
import type { EditableObject } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { computeSilhouetteMask, depthFrameFromMap, SilhouetteTracker } from '@/camera/edit/silhouette';
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

function boxObject(overrides: Partial<EditableObject> = {}): EditableObject {
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
    ...overrides,
  };
}

describe('computeSilhouetteMask', () => {
  it('masks in roughly the box footprint and out everywhere else', () => {
    const map = syntheticSceneDepth(true);
    const df = depthFrameFromMap(map);
    const obj = boxObject();

    const mask = computeSilhouetteMask(df, obj);
    expect(mask).not.toBeNull();
    if (!mask) return;

    expect(mask.width).toBeGreaterThan(0);
    expect(mask.height).toBeGreaterThan(0);
    // Blob depth should agree with the box's own depth (camera at y=1.1, box near z=-2).
    expect(mask.blobDepthM).toBeGreaterThan(1.5);
    expect(mask.blobDepthM).toBeLessThan(2.5);

    // Centre of the mask should be strongly "in" (feathered core, so not necessarily 255,
    // but well above a background/edge pixel).
    const cx = Math.floor(mask.width / 2);
    const cy = Math.floor(mask.height / 2);
    expect(mask.alpha[cy * mask.width + cx]).toBeGreaterThan(150);

    // The top-left corner of the padded bbox is background (the box does not fill its own
    // bbox, since a box is not axis-aligned-square in screen space) and should read a lower
    // alpha than the strongly-in centre even after feathering/dilation.
    expect(mask.alpha[0]).toBeLessThan(mask.alpha[cy * mask.width + cx] as number);
  });

  it('feathers the edge into a gradient rather than a hard 0/255 step', () => {
    const map = syntheticSceneDepth(true);
    const df = depthFrameFromMap(map);
    const obj = boxObject();
    const mask = computeSilhouetteMask(df, obj);
    expect(mask).not.toBeNull();
    if (!mask) return;

    // Scan a horizontal line through the mask's vertical centre; there should be at least
    // one pixel whose alpha is strictly between "fully in" and "fully out" (a feathered edge),
    // not just a binary 0/255 mask.
    const cy = Math.floor(mask.height / 2);
    let sawIntermediate = false;
    for (let x = 0; x < mask.width; x++) {
      const a = mask.alpha[cy * mask.width + x] as number;
      if (a > 20 && a < 235) sawIntermediate = true;
    }
    expect(sawIntermediate).toBe(true);
  });

  it('masks in much less of the frame once the box is removed', () => {
    const withBox = computeSilhouetteMask(depthFrameFromMap(syntheticSceneDepth(true)), boxObject());
    const empty = computeSilhouetteMask(depthFrameFromMap(syntheticSceneDepth(false)), boxObject());
    expect(withBox).not.toBeNull();
    if (!withBox) return;

    const meanAlpha = (m: { alpha: Uint8ClampedArray }) => {
      let sum = 0;
      for (const a of m.alpha) sum += a;
      return sum / m.alpha.length;
    };
    const withBoxMean = meanAlpha(withBox);
    // Without the object, the footprint reads the floor/wall instead: whatever still passes
    // the depth-agreement threshold (a coincidental sliver, not the whole box) masks in far
    // less of the frame than the real object did.
    const emptyMean = empty ? meanAlpha(empty) : 0;
    expect(emptyMean).toBeLessThan(withBoxMean * 0.5);
  });
});

describe('SilhouetteTracker', () => {
  it('tracks a stable mask across repeated identical frames', () => {
    const tracker = new SilhouetteTracker();
    const map = syntheticSceneDepth(true);
    const df = depthFrameFromMap(map);
    const obj = boxObject();

    let last;
    for (let i = 0; i < 8; i++) {
      last = tracker.update('obj:can', df, obj);
      expect(last).toBeDefined();
    }
    const width = last!.width;
    const height = last!.height;
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    expect(last!.alpha[cy * width + cx]).toBeGreaterThan(150);
  });

  it('freezes the last tracked mask instead of clearing it once the object reads as gone', () => {
    const tracker = new SilhouetteTracker();
    const withBoxDf = depthFrameFromMap(syntheticSceneDepth(true));
    const obj = boxObject();

    const tracked = tracker.update('obj:can', withBoxDf, obj);
    expect(tracked).toBeDefined();

    // Feed a depth frame with nothing valid in the object's footprint at all (all-zero
    // depth): computeSilhouetteMask returns null for it (no blob to threshold against), but
    // the tracker must FREEZE the last known mask rather than forgetting it - the impostor
    // and the static-camera eraser both need this object's shape after it's gone/moved (see
    // the module doc comment).
    const blankDf = { ...withBoxDf, depth: new Float32Array(withBoxDf.width * withBoxDf.height) };
    const frozen = tracker.update('obj:can', blankDf, obj);
    expect(frozen).toEqual(tracked);
    expect(tracker.peek('obj:can')).toEqual(tracked);
  });

  it('peek returns the last tracked mask without consuming a new frame', () => {
    const tracker = new SilhouetteTracker();
    const map = syntheticSceneDepth(true);
    const df = depthFrameFromMap(map);
    const obj = boxObject();

    expect(tracker.peek('obj:can')).toBeUndefined();
    const updated = tracker.update('obj:can', df, obj);
    const peeked = tracker.peek('obj:can');
    expect(peeked).toEqual(updated);
  });

  it('clear() drops tracked history for an object', () => {
    const tracker = new SilhouetteTracker();
    const map = syntheticSceneDepth(true);
    const df = depthFrameFromMap(map);
    const obj = boxObject();
    tracker.update('obj:can', df, obj);
    expect(tracker.peek('obj:can')).toBeDefined();
    tracker.clear('obj:can');
    expect(tracker.peek('obj:can')).toBeUndefined();
  });
});
