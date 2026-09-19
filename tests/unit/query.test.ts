import { describe, expect, it } from 'vitest';
import { nearestObjects, objectsInRegion, raycastProxies, surfaceBelow } from '@/core/query';
import { makeObject, makeSnapshot, makeSurface } from '@/core/fixtures';
import { IDENTITY_QUAT } from '@/core/types';

describe('nearestObjects', () => {
  it('sorts by distance and excludes objects beyond maxDistance or invisible', () => {
    const near = makeObject({ id: 'near', currentPose: { position: { x: 1, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } } });
    const far = makeObject({ id: 'far', currentPose: { position: { x: 10, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } } });
    const hidden = makeObject({ id: 'hidden', visible: false, currentPose: { position: { x: 0.5, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } } });
    const snapshot = makeSnapshot({ objects: { near, far, hidden } });

    const results = nearestObjects(snapshot, { x: 0, y: 0, z: 0 }, 5);
    expect(results.map((o) => o.id)).toEqual(['near']);
  });
});

describe('raycastProxies', () => {
  it('hits a box proxy centered at the object pose', () => {
    const object = makeObject({
      id: 'box1',
      currentPose: { position: { x: 0, y: 0, z: -5 }, rotation: { ...IDENTITY_QUAT } },
      interactionProxy: { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
    });
    const snapshot = makeSnapshot({ objects: { box1: object } });
    const hits = raycastProxies(snapshot, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
    expect(hits.length).toBe(1);
    expect(hits[0]!.objectId).toBe('box1');
    expect(hits[0]!.distance).toBeCloseTo(4.5, 5);
  });

  it('padM grows every proxy so a ray just missing a small box still hits it', () => {
    const can = makeObject({
      id: 'can',
      currentPose: { position: { x: 0, y: 0, z: -0.5 }, rotation: { ...IDENTITY_QUAT } },
      interactionProxy: { kind: 'box', halfExtents: { x: 0.03, y: 0.06, z: 0.03 } },
    });
    const snapshot = makeSnapshot({ objects: { can } });
    // 4.5 cm off-centre: misses the 3 cm half-width box, hits it with a 4 cm pad.
    const dir = { x: 0.045, y: 0, z: -0.5 };
    expect(raycastProxies(snapshot, { x: 0, y: 0, z: 0 }, dir, 3).length).toBe(0);
    const hits = raycastProxies(snapshot, { x: 0, y: 0, z: 0 }, dir, 3, 0.04);
    expect(hits.length).toBe(1);
    expect(hits[0]!.objectId).toBe('can');
  });

  it('hits a sphere proxy', () => {
    const object = makeObject({
      id: 'sphere1',
      currentPose: { position: { x: 0, y: 0, z: -5 }, rotation: { ...IDENTITY_QUAT } },
      interactionProxy: { kind: 'sphere', radius: 1 },
    });
    const snapshot = makeSnapshot({ objects: { sphere1: object } });
    const hits = raycastProxies(snapshot, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
    expect(hits.length).toBe(1);
    expect(hits[0]!.distance).toBeCloseTo(4, 5);
  });

  it('misses when the ray does not intersect and respects maxDistance', () => {
    const object = makeObject({
      id: 'box1',
      currentPose: { position: { x: 5, y: 0, z: -5 }, rotation: { ...IDENTITY_QUAT } },
      interactionProxy: { kind: 'box', halfExtents: { x: 0.2, y: 0.2, z: 0.2 } },
    });
    const snapshot = makeSnapshot({ objects: { box1: object } });
    const missed = raycastProxies(snapshot, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
    expect(missed.length).toBe(0);

    const tooFar = makeObject({
      id: 'box2',
      currentPose: { position: { x: 0, y: 0, z: -100 }, rotation: { ...IDENTITY_QUAT } },
      interactionProxy: { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
    });
    const snapshot2 = makeSnapshot({ objects: { box2: tooFar } });
    const outOfRange = raycastProxies(snapshot2, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 5);
    expect(outOfRange.length).toBe(0);
  });

  it('sorts multiple hits by distance', () => {
    const objA = makeObject({ id: 'a', currentPose: { position: { x: 0, y: 0, z: -10 }, rotation: { ...IDENTITY_QUAT } }, interactionProxy: { kind: 'sphere', radius: 1 } });
    const objB = makeObject({ id: 'b', currentPose: { position: { x: 0, y: 0, z: -3 }, rotation: { ...IDENTITY_QUAT } }, interactionProxy: { kind: 'sphere', radius: 1 } });
    const snapshot = makeSnapshot({ objects: { a: objA, b: objB } });
    const hits = raycastProxies(snapshot, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
    expect(hits.map((h) => h.objectId)).toEqual(['b', 'a']);
  });
});

describe('objectsInRegion', () => {
  it('returns visible objects whose position is inside the region bounds', () => {
    const inside = makeObject({ id: 'in', currentPose: { position: { x: 0, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } } });
    const outside = makeObject({ id: 'out', currentPose: { position: { x: 10, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } } });
    const snapshot = makeSnapshot({ objects: { in: inside, out: outside } });
    const region = {
      id: 'r1',
      bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
      state: 'CAPTURED' as const,
      reason: 'none' as const,
      surfaces: [],
      objects: [],
      since: 0,
    };
    const found = objectsInRegion(snapshot, region);
    expect(found.map((o) => o.id)).toEqual(['in']);
  });
});

describe('surfaceBelow', () => {
  it('finds the nearest horizontal surface strictly at or below the point', () => {
    const low = makeSurface({
      id: 'low',
      orientation: 'horizontal',
      aabb: { min: { x: -1, y: -0.05, z: -1 }, max: { x: 1, y: 0, z: 1 } },
    });
    const high = makeSurface({
      id: 'high',
      orientation: 'horizontal',
      aabb: { min: { x: -1, y: 0.95, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    });
    const snapshot = makeSnapshot({ surfaces: { low, high } });
    const surface = surfaceBelow(snapshot, { x: 0, y: 1.5, z: 0 });
    expect(surface?.id).toBe('high'); // the closer one below the point
  });

  it('returns undefined when nothing is below or in range', () => {
    const surface = makeSurface({ orientation: 'vertical' });
    const snapshot = makeSnapshot({ surfaces: { s: surface } });
    expect(surfaceBelow(snapshot, { x: 0, y: 5, z: 0 })).toBeUndefined();
  });
});
