import { describe, expect, it } from 'vitest';
import { createResolver } from '@/core/resolver';
import { createSceneStore } from '@/core/store';
import { raycastProxies } from '@/core/query';
import { makeConditions, makeObject, makeSnapshot } from '@/core/fixtures';

describe('raycastProxies reports origin-inside hits', () => {
  it('flags a hit whose ray origin is enclosed by the proxy', () => {
    const big = makeObject({ id: 'couch', interactionProxy: { kind: 'box', halfExtents: { x: 1, y: 0.5, z: 0.5 } } });
    const snapshot = makeSnapshot({ objects: { couch: big } });
    const inside = raycastProxies(snapshot, big.currentPose.position, { x: 0, y: 0, z: -1 }, 3);
    expect(inside[0]?.originInside).toBe(true);
    const outside = raycastProxies(
      snapshot,
      { x: big.currentPose.position.x, y: big.currentPose.position.y, z: big.currentPose.position.z + 3 },
      { x: 0, y: 0, z: -1 },
      5,
    );
    expect(outside[0]?.originInside).toBe(false);
  });
});

describe('hydrate validates object contents', () => {
  it('rejects a blob whose object has an unknown tier', () => {
    const store = createSceneStore();
    const good = makeObject({ id: 'ok' });
    const blob = JSON.stringify({
      snapshot: { ...makeSnapshot({ objects: { ok: { ...good, tier: 'Z' } } }) },
      undo: [],
      redo: [],
    });
    expect(store.hydrate(blob)).toBe(false);
  });
});

describe('region fallback gates every edit kind', () => {
  it('rejects rotate inside a FALLBACK region', () => {
    const obj = makeObject({ id: 'o' });
    const p = obj.currentPose.position;
    const snapshot = makeSnapshot({
      objects: { o: obj },
      regions: {
        r: {
          id: 'r',
          bounds: { min: { x: p.x - 1, y: p.y - 1, z: p.z - 1 }, max: { x: p.x + 1, y: p.y + 1, z: p.z + 1 } },
          state: 'FALLBACK',
          reason: 'dynamic_obstruction',
          surfaces: [],
          objects: ['o'],
          since: 0,
        },
      },
    });
    const result = createResolver().resolve(
      snapshot,
      { intent: { kind: 'rotate', objectId: 'o', rotation: { x: 0, y: 0.7071, z: 0, w: 0.7071 } }, source: 'hand', issuedAt: 0, basedOnVersion: snapshot.version },
      makeConditions(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('region_fallback');
  });
});
