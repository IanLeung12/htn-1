import { describe, expect, it } from 'vitest';
import { CATALOG, buildCatalogObject, findCatalogEntry } from '@/app/catalog';
import { IDENTITY_QUAT, type Pose } from '@/core/types';

const POSE: Pose = { position: { x: 0, y: 1, z: -0.7 }, rotation: { ...IDENTITY_QUAT } };

describe('CATALOG', () => {
  it('has between 6 and 8 entries, each with a public/assets glb url', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(6);
    expect(CATALOG.length).toBeLessThanOrEqual(8);
    for (const entry of CATALOG) {
      expect(entry.url).toMatch(/^\/assets\/.+\.glb$/);
      expect(entry.aliases.length).toBeGreaterThan(0);
      expect(entry.massKg).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('findCatalogEntry', () => {
  it('matches by id, name, and alias case-insensitively', () => {
    expect(findCatalogEntry('chair')?.id).toBe('chair');
    expect(findCatalogEntry('Chair')?.id).toBe('chair');
    expect(findCatalogEntry('armchair')?.id).toBe('chair');
    expect(findCatalogEntry('Flower Vase')?.id).toBe('vase');
  });

  it('matches by unambiguous prefix', () => {
    expect(findCatalogEntry('sunglass')?.id).toBe('sunglasses');
  });

  it('returns undefined for unknown or empty text', () => {
    expect(findCatalogEntry('spaceship')).toBeUndefined();
    expect(findCatalogEntry('')).toBeUndefined();
    expect(findCatalogEntry('   ')).toBeUndefined();
  });
});

describe('buildCatalogObject', () => {
  it('builds a spawned, approved, tier-A gltf object at the given pose', () => {
    const entry = findCatalogEntry('chair')!;
    const obj = buildCatalogObject(entry, POSE, 'catalog-test-1');

    expect(obj.id).toBe('catalog-test-1');
    expect(obj.origin).toBe('spawned');
    expect(obj.approved).toBe(true);
    expect(obj.visible).toBe(true);
    expect(obj.tier).toBe('A');
    expect(obj.visual).toEqual({ kind: 'gltf', url: entry.url });
    expect(obj.currentPose).toEqual(POSE);
    expect(obj.originalPose).toEqual(POSE);
    expect(obj.interactionProxy).toEqual({ kind: 'box', halfExtents: entry.approxHalfExtents });
    expect(obj.collisionProxy).toEqual(obj.interactionProxy);
    expect(obj.occlusionProxy).toEqual(obj.interactionProxy);
    expect(obj.physical.massKg).toBe(entry.massKg);
    expect(obj.physical.kinematic).toBe(false);
  });

  it('generates a unique id when none is given', () => {
    const entry = findCatalogEntry('vase')!;
    const a = buildCatalogObject(entry, POSE);
    const b = buildCatalogObject(entry, POSE);
    expect(a.id).not.toBe(b.id);
  });

  it('mutating one built object`s proxy does not affect another (proxies are independent objects)', () => {
    const entry = findCatalogEntry('lamp')!;
    const a = buildCatalogObject(entry, POSE, 'a');
    const b = buildCatalogObject(entry, POSE, 'b');
    (a.interactionProxy as { halfExtents: { x: number } }).halfExtents.x = 99;
    expect((b.interactionProxy as { halfExtents: { x: number } }).halfExtents.x).not.toBe(99);
  });
});
