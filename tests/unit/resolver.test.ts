import { describe, expect, it } from 'vitest';
import { createResolver } from '@/core/resolver';
import { makeConditions, makeObject, makePlate, makeSnapshot } from '@/core/fixtures';
import type { IntentEnvelope, RejectReason, SceneSnapshot } from '@/core/types';

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.values(obj as Record<string, unknown>).forEach((v) => deepFreeze(v));
    Object.freeze(obj);
  }
  return obj;
}

function env(intent: IntentEnvelope['intent'], basedOnVersion = 1, source: IntentEnvelope['source'] = 'hand'): IntentEnvelope {
  return { intent, source, issuedAt: 0, basedOnVersion };
}

describe('resolver', () => {
  it('version monotonicity: a successful commit bumps version by exactly 1', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1' });
    const snapshot = deepFreeze(makeSnapshot({ version: 5, objects: { o1: object } }));
    const conditions = deepFreeze(makeConditions({ now: 999 }));

    const result = resolver.resolve(snapshot, env({ kind: 'move', objectId: 'o1', pose: object.currentPose }, 5), conditions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.version).toBe(6);
      expect(result.snapshot.committedAt).toBe(999);
    }
  });

  it('never mutates the input snapshot or conditions (deep-frozen inputs)', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1' });
    const snapshot = deepFreeze(makeSnapshot({ version: 1, objects: { o1: object } }));
    const conditions = deepFreeze(makeConditions());

    expect(() =>
      resolver.resolve(snapshot, env({ kind: 'move', objectId: 'o1', pose: object.currentPose }), conditions),
    ).not.toThrow();
    expect(() =>
      resolver.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), conditions),
    ).not.toThrow();
    expect(() =>
      resolver.resolve(snapshot, env({ kind: 'spawn', object: makeObject({ id: 'o2' }) }), conditions),
    ).not.toThrow();
  });

  it('rejects unknown object ids', () => {
    const resolver = createResolver();
    const snapshot = makeSnapshot();
    const result = resolver.resolve(snapshot, env({ kind: 'move', objectId: 'ghost', pose: makeObject().currentPose }), makeConditions());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_object');
  });

  it('rejects mutation of a not-yet-approved object', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1', approved: false });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const result = resolver.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), makeConditions());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_approved');
  });

  it('rejects a stale intent based on an old snapshot version, with maxVersionLag', () => {
    const resolver = createResolver({ maxVersionLag: 3 });
    const object = makeObject({ id: 'o1' });
    const snapshot = makeSnapshot({ version: 10, objects: { o1: object } });
    const result = resolver.resolve(snapshot, env({ kind: 'move', objectId: 'o1', pose: object.currentPose }, 6), makeConditions());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale_intent');
  });

  it('does not treat undo/redo/clearPreview/system-sourced intents as stale', () => {
    const resolver = createResolver({ maxVersionLag: 3 });
    const snapshot = makeSnapshot({ version: 999 });
    const clear = resolver.resolve(snapshot, env({ kind: 'clearPreview' }, 0), makeConditions());
    expect(clear.ok).toBe(true);

    const object = makeObject({ id: 'o1' });
    const snapshot2 = makeSnapshot({ version: 999, objects: { o1: object } });
    const systemMove = resolver.resolve(
      snapshot2,
      env({ kind: 'move', objectId: 'o1', pose: object.currentPose }, 0, 'system'),
      makeConditions(),
    );
    expect(systemMove.ok).toBe(true);
  });

  it('tier matrix: tier E object can only restore/undo, not move/rotate/scale/delete/replace', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1', tier: 'E' });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const conditions = makeConditions();

    const forbidden: [RejectReason, IntentEnvelope['intent']][] = [
      ['tier_forbids', { kind: 'move', objectId: 'o1', pose: object.currentPose }],
      ['tier_forbids', { kind: 'rotate', objectId: 'o1', rotation: object.currentPose.rotation }],
      ['tier_forbids', { kind: 'scale', objectId: 'o1', factor: 2 }],
      ['tier_forbids', { kind: 'delete', objectId: 'o1' }],
      ['tier_forbids', { kind: 'replace', objectId: 'o1', asset: { kind: 'primitive' } }],
    ];
    for (const [reason, intent] of forbidden) {
      const result = resolver.resolve(snapshot, env(intent), conditions);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    }

    const restore = resolver.resolve(snapshot, env({ kind: 'restore', objectId: 'o1' }), conditions);
    expect(restore.ok).toBe(true);
  });

  it('tier matrix: tier D object can move (ghost, no plate needed) and restore, but not delete/scale/replace', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1', tier: 'D', background: [] });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const conditions = makeConditions();

    const move = resolver.resolve(snapshot, env({ kind: 'move', objectId: 'o1', pose: object.currentPose }), conditions);
    expect(move.ok).toBe(true);

    const del = resolver.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), conditions);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.reason).toBe('tier_forbids');
  });

  it('delete without any qualifying background plate is rejected (no_background_evidence)', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1', tier: 'A', background: [] });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const result = resolver.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), makeConditions());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_background_evidence');
  });

  it('delete from outside the plate envelope is rejected (outside_envelope)', () => {
    const resolver = createResolver();
    const plate = makePlate({ envelope: { center: { x: 0, y: 1.5, z: 1 }, radius: 0.5, maxAngle: Math.PI } });
    const object = makeObject({ id: 'o1', tier: 'A', background: [plate] });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    // Head is far outside the plate's small radius.
    const conditions = makeConditions({ headPose: { position: { x: 100, y: 1.5, z: 1 }, rotation: object.currentPose.rotation } });
    const result = resolver.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), conditions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside_envelope');
  });

  it('delete succeeds with a good plate inside the envelope and marks the object invisible', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1' }); // default fixture: tier A, coverage 1.0 plate, big envelope
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const result = resolver.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), makeConditions());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.objects.o1?.visible).toBe(false);
  });

  it('rejects moves/deletes inside a FALLBACK region', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1', currentPose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
    const snapshot = makeSnapshot({
      objects: { o1: object },
      regions: {
        r1: {
          id: 'r1',
          bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
          state: 'FALLBACK',
          reason: 'tracking_lost',
          surfaces: [],
          objects: ['o1'],
          since: 0,
        },
      },
    });
    const result = resolver.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), makeConditions());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('region_fallback');
  });

  it('rejects mutations when tracking is lost, but allows restore/setMode', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1' });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const conditions = makeConditions({ trackingOk: false });

    const move = resolver.resolve(snapshot, env({ kind: 'move', objectId: 'o1', pose: object.currentPose }), conditions);
    expect(move.ok).toBe(false);
    if (!move.ok) expect(move.reason).toBe('tracking_lost');

    const restore = resolver.resolve(snapshot, env({ kind: 'restore', objectId: 'o1' }), conditions);
    expect(restore.ok).toBe(true);

    const setMode = resolver.resolve(snapshot, env({ kind: 'setMode', mode: 'captured-shell' }), conditions);
    expect(setMode.ok).toBe(true);
  });

  it('rejects edits to an object whose anchor is not localized', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1', anchorId: 'anchor-1' });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const conditions = makeConditions({ localizedAnchors: new Set() });
    const result = resolver.resolve(snapshot, env({ kind: 'move', objectId: 'o1', pose: object.currentPose }), conditions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('anchor_lost');
  });

  it('spawn creates an approved object', () => {
    const resolver = createResolver();
    const snapshot = makeSnapshot();
    const spawned = makeObject({ id: 'new1', approved: false, origin: 'spawned' });
    const result = resolver.resolve(snapshot, env({ kind: 'spawn', object: spawned }), makeConditions());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.objects.new1?.approved).toBe(true);
    }
  });

  it('scale multiplies proxy half extents', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1', interactionProxy: { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } } });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const result = resolver.resolve(snapshot, env({ kind: 'scale', objectId: 'o1', factor: 2 }), makeConditions());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const proxy = result.snapshot.objects.o1?.interactionProxy;
      expect(proxy).toEqual({ kind: 'box', halfExtents: { x: 2, y: 2, z: 2 } });
    }
  });

  it('replace sets visual and replacedBy', () => {
    const resolver = createResolver();
    const object = makeObject({ id: 'o1' });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const result = resolver.resolve(
      snapshot,
      env({ kind: 'replace', objectId: 'o1', asset: { kind: 'gltf', url: 'assets/lamp.glb' } }),
      makeConditions(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.objects.o1?.replacedBy).toBe('assets/lamp.glb');
    }
  });

  it('updateBackground never downgrades an existing plate provenance', () => {
    const resolver = createResolver();
    const goodPlate = makePlate({ id: 'p1', provenance: 'observed_clean_plate', version: 'observed_v1' });
    const object = makeObject({ id: 'o1', background: [goodPlate] });
    const snapshot = makeSnapshot({ objects: { o1: object } });

    const worsePlate = makePlate({ id: 'p1', provenance: 'synthetic_completion', version: 'completed_v3' });
    const result = resolver.resolve(snapshot, env({ kind: 'updateBackground', objectId: 'o1', plate: worsePlate }), makeConditions());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');

    const betterPlate = makePlate({ id: 'p1', provenance: 'observed_clean_plate', version: 'fused_v2', coverage: 0.9 });
    const ok = resolver.resolve(snapshot, env({ kind: 'updateBackground', objectId: 'o1', plate: betterPlate }), makeConditions());
    expect(ok.ok).toBe(true);
  });

  it('undo/redo intents are rejected at the resolver level (handled by the store)', () => {
    const resolver = createResolver();
    const snapshot = makeSnapshot();
    const undo = resolver.resolve(snapshot, env({ kind: 'undo' }), makeConditions());
    expect(undo.ok).toBe(false);
    const redo = resolver.resolve(snapshot, env({ kind: 'redo' }), makeConditions());
    expect(redo.ok).toBe(false);
  });

  it('registerRegion adds a region to the snapshot, keyed by id; replaces on re-register', () => {
    const resolver = createResolver();
    const snapshot = makeSnapshot();
    const region = {
      id: 'region:plane-0',
      bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } },
      state: 'LIVE' as const,
      reason: 'none' as const,
      surfaces: ['plane-0'],
      objects: [],
      since: 0,
    };
    const result = resolver.resolve(snapshot, env({ kind: 'registerRegion', region }, 0, 'system'), makeConditions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.regions['region:plane-0']).toEqual(region);

    const replacement = { ...region, state: 'CAPTURED' as const };
    const result2 = resolver.resolve(result.snapshot, env({ kind: 'registerRegion', region: replacement }, 0, 'system'), makeConditions());
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.snapshot.regions['region:plane-0']?.state).toBe('CAPTURED');
    expect(Object.keys(result2.snapshot.regions)).toHaveLength(1);
  });

  it('removeRegion deletes a region from the snapshot; no-op if it never existed', () => {
    const resolver = createResolver();
    const region = {
      id: 'region:plane-0',
      bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } },
      state: 'LIVE' as const,
      reason: 'none' as const,
      surfaces: ['plane-0'],
      objects: [],
      since: 0,
    };
    const snapshot = makeSnapshot({ regions: { [region.id]: region } });
    const result = resolver.resolve(snapshot, env({ kind: 'removeRegion', regionId: region.id }, 0, 'system'), makeConditions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.regions[region.id]).toBeUndefined();

    const result2 = resolver.resolve(result.snapshot, env({ kind: 'removeRegion', regionId: 'nope' }, 0, 'system'), makeConditions());
    expect(result2.ok).toBe(true);
  });
});

describe('setProxies', () => {
  it('replaces all three proxies on the object (used by catalog-fit once a gltf model loads)', () => {
    const resolver = createResolver();
    const obj = makeObject({ id: 'catalog-1' });
    const snapshot = makeSnapshot({ objects: { [obj.id]: obj } });
    const interaction = { kind: 'box' as const, halfExtents: { x: 0.3, y: 0.4, z: 0.3 } };
    const collision = { kind: 'box' as const, halfExtents: { x: 0.3, y: 0.4, z: 0.3 } };
    const occlusion = { kind: 'box' as const, halfExtents: { x: 0.3, y: 0.4, z: 0.3 } };

    const result = resolver.resolve(
      snapshot,
      env({ kind: 'setProxies', objectId: obj.id, interaction, collision, occlusion }, 0, 'system'),
      makeConditions(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.snapshot.objects[obj.id]!;
    expect(updated.interactionProxy).toEqual(interaction);
    expect(updated.collisionProxy).toEqual(collision);
    expect(updated.occlusionProxy).toEqual(occlusion);
  });

  it('rejects setProxies for an unknown object', () => {
    const resolver = createResolver();
    const snapshot = makeSnapshot();
    const shape = { kind: 'box' as const, halfExtents: { x: 0.1, y: 0.1, z: 0.1 } };
    const result = resolver.resolve(
      snapshot,
      env({ kind: 'setProxies', objectId: 'nope', interaction: shape, collision: shape, occlusion: shape }, 0, 'system'),
      makeConditions(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_object');
  });
});

describe('delete of non-physical objects', () => {
  it('allows deleting a spawned object with no background plates', () => {
    const resolver = createResolver();
    const obj = makeObject({ id: 'spawned-1', origin: 'spawned', background: [], tier: 'A', approved: true });
    const snapshot = makeSnapshot({ objects: { [obj.id]: obj } });
    const result = resolver.resolve(
      snapshot,
      { intent: { kind: 'delete', objectId: obj.id }, source: 'voice', issuedAt: 0, basedOnVersion: snapshot.version },
      makeConditions(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.objects[obj.id]!.visible).toBe(false);
  });
});
