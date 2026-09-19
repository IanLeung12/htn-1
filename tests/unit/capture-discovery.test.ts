import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import type { SceneSnapshot, Surface } from '@/core/types';
import { discover } from '@/capture/discovery';
import type { DetectedVolume } from '@/capture/contract';

function surface(partial: Partial<Surface> & Pick<Surface, 'id' | 'label' | 'orientation' | 'aabb'>): Surface {
  return {
    pose: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT },
    polygon: [],
    lastChanged: 0,
    ...partial,
  };
}

function snapshotWith(surfaces: Surface[]): SceneSnapshot {
  return {
    version: 1,
    committedAt: 0,
    mode: 'live-overlay',
    objects: {},
    regions: {},
    surfaces: Object.fromEntries(surfaces.map((s) => [s.id, s])),
  };
}

describe('discover', () => {
  const tableSurface = surface({
    id: 'surf:table',
    label: 'table',
    orientation: 'horizontal',
    aabb: { min: { x: -0.6, y: 0.79, z: -0.6 }, max: { x: 0.6, y: 0.8, z: 0.6 } },
  });
  const floorSurface = surface({
    id: 'surf:floor',
    label: 'floor',
    orientation: 'horizontal',
    aabb: { min: { x: -5, y: -0.01, z: -5 }, max: { x: 5, y: 0, z: 5 } },
  });

  it('picks the table as the support surface, not the floor, for an object resting on it', () => {
    const volumes: DetectedVolume[] = [
      {
        id: 'lamp1',
        label: 'lamp',
        pose: { position: { x: 0, y: 0.9, z: 0 }, rotation: IDENTITY_QUAT },
        halfExtents: { x: 0.1, y: 0.1, z: 0.1 },
      },
    ];
    const [candidate] = discover(volumes, snapshotWith([tableSurface, floorSurface]));
    expect(candidate).toBeDefined();
    expect(candidate!.object.supportSurfaces).toEqual(['surf:table']);
    expect(candidate!.object.tier).toBe('E');
    expect(candidate!.object.approved).toBe(false);
    expect(candidate!.object.userName).toBe('lamp 1');
  });

  it('never proposes walls, floor, ceiling, doors, windows, wall art, or global mesh as candidates', () => {
    const rejectedLabels = ['wall', 'floor', 'ceiling', 'door', 'window', 'wall art', 'global mesh'];
    const volumes: DetectedVolume[] = rejectedLabels.map((label, i) => ({
      id: `vol${i}`,
      label,
      pose: { position: { x: i * 2, y: 1, z: 0 }, rotation: IDENTITY_QUAT },
      halfExtents: { x: 0.3, y: 1, z: 0.1 },
    }));
    const candidates = discover(volumes, snapshotWith([tableSurface, floorSurface]));
    expect(candidates).toHaveLength(0);
  });

  it('falls back to the floor as support when no other surface is close enough', () => {
    const volumes: DetectedVolume[] = [
      {
        id: 'plant1',
        label: 'plant',
        pose: { position: { x: 3, y: 0.3, z: 3 }, rotation: IDENTITY_QUAT },
        halfExtents: { x: 0.2, y: 0.3, z: 0.2 },
      },
    ];
    const [candidate] = discover(volumes, snapshotWith([tableSurface, floorSurface]));
    expect(candidate!.object.supportSurfaces).toEqual(['surf:floor']);
  });

  it('flags an object with no support surface as placement-restricted', () => {
    const volumes: DetectedVolume[] = [
      {
        id: 'floating1',
        label: 'shelf',
        pose: { position: { x: 0, y: 5, z: 0 }, rotation: IDENTITY_QUAT },
        halfExtents: { x: 0.3, y: 0.1, z: 0.2 },
      },
    ];
    const [candidate] = discover(volumes, snapshotWith([tableSurface, floorSurface]));
    expect(candidate!.object.supportSurfaces).toEqual([]);
    expect(candidate!.rationale).toMatch(/placement-restricted/);
    expect(candidate!.object.tier).toBe('E');
  });

  it('flags an oversized object as placement-restricted', () => {
    const volumes: DetectedVolume[] = [
      {
        id: 'big1',
        label: 'storage',
        pose: { position: { x: 0, y: 1, z: 0 }, rotation: IDENTITY_QUAT },
        halfExtents: { x: 1.2, y: 1, z: 0.5 }, // 2.4m wide
      },
    ];
    const [candidate] = discover(volumes, snapshotWith([tableSurface, floorSurface]));
    expect(candidate!.rationale).toMatch(/exceeds 2\.0m/);
  });

  it('flags an object flush against two walls as placement-restricted', () => {
    const wallX = surface({
      id: 'surf:wallx',
      label: 'wall',
      orientation: 'vertical',
      aabb: { min: { x: -1.01, y: 0, z: -5 }, max: { x: -1.0, y: 2, z: 5 } },
    });
    const wallZ = surface({
      id: 'surf:wallz',
      label: 'wall',
      orientation: 'vertical',
      aabb: { min: { x: -5, y: 0, z: -1.01 }, max: { x: 5, y: 2, z: -1.0 } },
    });
    const volumes: DetectedVolume[] = [
      {
        id: 'corner1',
        label: 'storage',
        pose: { position: { x: -0.8, y: 0.5, z: -0.8 }, rotation: IDENTITY_QUAT },
        halfExtents: { x: 0.2, y: 0.5, z: 0.2 },
      },
    ];
    const [candidate] = discover(volumes, snapshotWith([tableSurface, floorSurface, wallX, wallZ]));
    expect(candidate!.rationale).toMatch(/flush against/);
  });

  it('assigns incrementing userNames per label', () => {
    const volumes: DetectedVolume[] = [
      {
        id: 'lamp1',
        label: 'lamp',
        pose: { position: { x: 0, y: 0.9, z: 0 }, rotation: IDENTITY_QUAT },
        halfExtents: { x: 0.1, y: 0.1, z: 0.1 },
      },
      {
        id: 'lamp2',
        label: 'lamp',
        pose: { position: { x: 1, y: 0.9, z: 0 }, rotation: IDENTITY_QUAT },
        halfExtents: { x: 0.1, y: 0.1, z: 0.1 },
      },
    ];
    const candidates = discover(volumes, snapshotWith([tableSurface, floorSurface]));
    expect(candidates.map((c) => c.object.userName)).toEqual(['lamp 1', 'lamp 2']);
  });
});
