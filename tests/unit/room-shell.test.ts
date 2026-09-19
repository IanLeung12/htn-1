import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import type { CameraFrame } from '@/capture/contract';
import type { Region, SceneSnapshot } from '@/core/types';
import {
  RoomShellRenderer,
  TILE_SIZE_M,
  tileBoundsFor,
  tileCoordFor,
  tileKey,
  tileVisibleForRegions,
} from '@/render/room-shell';

/** A frame looking straight down (-Y) from height `depth`, so world X/Z both spread with pixel position - see the module comment below for the rotation math. */
function makeDownwardFrame(size: number, depth: number, timestamp = 0): CameraFrame {
  const rgba = new Uint8ClampedArray(size * size * 4).fill(200);
  const depthBuf = new Float32Array(size * size).fill(depth);
  // -90 degrees about world X: local forward (0,0,-1) -> world (0,-1,0).
  const half = Math.SQRT1_2;
  return {
    width: size,
    height: size,
    rgba,
    depth: depthBuf,
    pose: { position: { x: 0, y: depth, z: 0 }, rotation: { x: -half, y: 0, z: 0, w: half } },
    fovY: Math.PI / 2, // 90 degrees vertical -> tan(half) = 1
    aspect: 1,
    timestamp,
  };
}

function makeRegion(id: string, bounds: Region['bounds'], state: Region['state']): Region {
  return { id, bounds, state, reason: 'none', surfaces: [], objects: [], since: 0 };
}

describe('room-shell tile bucketing', () => {
  it('tileCoordFor/tileKey/tileBoundsFor agree with each other', () => {
    const { ix, iz } = tileCoordFor(2.2, -0.4);
    expect(ix).toBe(Math.floor(2.2 / TILE_SIZE_M));
    expect(iz).toBe(Math.floor(-0.4 / TILE_SIZE_M));
    expect(tileKey(ix, iz)).toBe(`${ix},${iz}`);
    const bounds = tileBoundsFor(ix, iz);
    expect(2.2).toBeGreaterThanOrEqual(bounds.minX);
    expect(2.2).toBeLessThan(bounds.maxX);
    expect(-0.4).toBeGreaterThanOrEqual(bounds.minZ);
    expect(-0.4).toBeLessThan(bounds.maxZ);
  });

  it('a tile is hidden only when an overlapping region is not CAPTURED/HYBRID; a tile untouched by any region defaults visible', () => {
    // Tile (0,0) spans x,z in [0, 1.5).
    const liveRegion = makeRegion('r1', { min: { x: 0, y: 0, z: 0 }, max: { x: 1.5, y: 1, z: 1.5 } }, 'LIVE');
    expect(tileVisibleForRegions(0, 0, [liveRegion])).toBe(false);

    const capturedRegion = makeRegion('r2', { min: { x: 0, y: 0, z: 0 }, max: { x: 1.5, y: 1, z: 1.5 } }, 'CAPTURED');
    expect(tileVisibleForRegions(0, 0, [capturedRegion])).toBe(true);

    const hybridRegion = makeRegion('r3', { min: { x: 0, y: 0, z: 0 }, max: { x: 1.5, y: 1, z: 1.5 } }, 'HYBRID');
    expect(tileVisibleForRegions(0, 0, [hybridRegion])).toBe(true);

    // No region at all overlapping tile (5,5): default visible.
    expect(tileVisibleForRegions(5, 5, [liveRegion])).toBe(true);

    // A tile overlapped by BOTH a captured region and a live region must not
    // be shown - every overlapping region must be CAPTURED/HYBRID.
    const wideLive = makeRegion('r4', { min: { x: -1, y: 0, z: -1 }, max: { x: 10, y: 1, z: 10 } }, 'LIVE');
    expect(tileVisibleForRegions(0, 0, [capturedRegion, wideLive])).toBe(false);
  });

  it('rebuild splits one wide frame into multiple XZ tiles, each named by its own tile coordinate', () => {
    const frame = makeDownwardFrame(40, 3);
    const renderer = new RoomShellRenderer();
    renderer.rebuild([frame], [], '');

    const stats = renderer.stats();
    expect(stats.tiles).toBeGreaterThan(1);
    expect(stats.vertices).toBeGreaterThan(0);
    expect(stats.texturesMB).toBeGreaterThan(0);
    expect(renderer.group.children.length).toBeGreaterThan(1);

    // Every produced mesh is named by its own tile coordinate, and every
    // triangle's CENTROID genuinely belongs there (the position attribute of
    // its own subset geometry must average out within the claimed tile,
    // allowing a small margin for triangle vertices that straddle the edge).
    for (const mesh of renderer.group.children) {
      const match = mesh.name.match(/room-shell-tile:(-?\d+),(-?\d+):/);
      expect(match).not.toBeNull();
      const ix = Number(match![1]);
      const iz = Number(match![2]);
      const bounds = tileBoundsFor(ix, iz);
      const geometry = (mesh as THREE.Mesh).geometry;
      const position = geometry.getAttribute('position');
      let sumX = 0;
      let sumZ = 0;
      for (let i = 0; i < position.count; i++) {
        sumX += position.getX(i);
        sumZ += position.getZ(i);
      }
      const meanX = sumX / position.count;
      const meanZ = sumZ / position.count;
      const margin = TILE_SIZE_M; // triangle vertices may spill up to ~1 tile beyond centroid-side bounds
      expect(meanX).toBeGreaterThanOrEqual(bounds.minX - margin);
      expect(meanX).toBeLessThanOrEqual(bounds.maxX + margin);
      expect(meanZ).toBeGreaterThanOrEqual(bounds.minZ - margin);
      expect(meanZ).toBeLessThanOrEqual(bounds.maxZ + margin);
    }
  });

  it('rebuild drops triangles inside a carve box', () => {
    const frame = makeDownwardFrame(40, 3);
    const withoutCarve = new RoomShellRenderer();
    withoutCarve.rebuild([frame], [], '');
    const baseline = withoutCarve.stats();

    const withCarve = new RoomShellRenderer();
    withCarve.rebuild([frame], [{ min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } }], 'carved');
    const carved = withCarve.stats();

    // The carve box covers everything, so nothing should survive.
    expect(baseline.vertices).toBeGreaterThan(0);
    expect(carved.vertices).toBe(0);
    expect(carved.tiles).toBe(0);
  });

  it('updateVisibility hides only tiles whose region is not CAPTURED/HYBRID', () => {
    const frame = makeDownwardFrame(40, 3);
    const renderer = new RoomShellRenderer();
    renderer.rebuild([frame], [], '');
    expect(renderer.group.children.length).toBeGreaterThan(0);

    // Force every tile with x >= 0 && z >= 0 (tile (0,0) and beyond) LIVE;
    // leave the rest with no region (default visible).
    const region = makeRegion('r', { min: { x: 0, y: -10, z: 0 }, max: { x: 100, y: 10, z: 100 } }, 'LIVE');
    const snapshot = { regions: { r: region } } as unknown as SceneSnapshot;
    renderer.updateVisibility(snapshot);

    let sawHidden = false;
    let sawVisible = false;
    for (const mesh of renderer.group.children) {
      const match = mesh.name.match(/room-shell-tile:(-?\d+),(-?\d+):/);
      expect(match).not.toBeNull();
      const ix = Number(match![1]);
      const iz = Number(match![2]);
      const bounds = tileBoundsFor(ix, iz);
      const overlapsRegion = bounds.minX < 100 && bounds.maxX > 0 && bounds.minZ < 100 && bounds.maxZ > 0;
      if (overlapsRegion) {
        expect((mesh as { visible: boolean }).visible).toBe(false);
        sawHidden = true;
      } else {
        expect((mesh as { visible: boolean }).visible).toBe(true);
        sawVisible = true;
      }
    }
    expect(sawHidden).toBe(true);
    expect(sawVisible).toBe(true);
  });
});
