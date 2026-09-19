import { describe, expect, it } from 'vitest';
import { createSceneStore } from '@/core/store';
import { makeConditions } from '@/core/fixtures';
import { IDENTITY_QUAT, type Pose } from '@/core/types';
import { spawnAsset, spawnCatalogObject } from '@/app/spawn';
import { findCatalogEntry } from '@/app/catalog';

const HEAD: Pose = { position: { x: 0, y: 1.6, z: 0 }, rotation: { ...IDENTITY_QUAT } };

describe('spawnCatalogObject', () => {
  it('places the object 0.7m in front of the head, at head height minus 0.3m', () => {
    const store = createSceneStore();
    const entry = findCatalogEntry('chair')!;
    const conditions = makeConditions({ headPose: HEAD });

    const id = spawnCatalogObject(store, entry, HEAD, conditions);
    expect(id).not.toBeNull();
    const obj = store.current.objects[id!]!;

    // Identity rotation looks down -Z, so "forward" is -Z.
    expect(obj.currentPose.position.x).toBeCloseTo(0, 6);
    expect(obj.currentPose.position.z).toBeCloseTo(-0.7, 6);
    expect(obj.currentPose.position.y).toBeCloseTo(1.3, 6);
  });

  it('dispatches a spawn intent that lands a gltf-visual, approved, tier-A object in the store', () => {
    const store = createSceneStore();
    const entry = findCatalogEntry('vase')!;
    const conditions = makeConditions({ headPose: HEAD });

    const id = spawnCatalogObject(store, entry, HEAD, conditions);
    const obj = store.current.objects[id!]!;
    expect(obj.visual).toEqual({ kind: 'gltf', url: entry.url });
    expect(obj.approved).toBe(true);
    expect(obj.tier).toBe('A');
    expect(obj.origin).toBe('spawned');
  });
});

describe('spawnAsset', () => {
  it('resolves the entry by id/name/alias and spawns it', () => {
    const store = createSceneStore();
    const conditions = makeConditions({ headPose: HEAD });
    const id = spawnAsset(store, 'candle holder', HEAD, conditions);
    expect(id).not.toBeNull();
    expect(store.current.objects[id!]!.userName).toBe('Lamp');
  });

  it('returns null for an unrecognized entry id and does not touch the store', () => {
    const store = createSceneStore();
    const conditions = makeConditions({ headPose: HEAD });
    const before = store.current.version;
    const id = spawnAsset(store, 'spaceship', HEAD, conditions);
    expect(id).toBeNull();
    expect(store.current.version).toBe(before);
  });
});
