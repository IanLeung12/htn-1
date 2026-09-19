import { describe, expect, it } from 'vitest';
import { SurfaceRegistry } from '@/camera/surfaces/registry';
import { makeFloorSurface } from '@/camera/surfaces/floor-prior';
import type { EstimatedSurface } from '@/camera/contract';
import type { Surface } from '@/core/types';

function table(id: string, y: number, cx: number, cz: number, hx = 0.5, hz = 0.8): EstimatedSurface {
  const surface: Surface = {
    id,
    label: 'table',
    orientation: 'horizontal',
    pose: { position: { x: cx, y, z: cz }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    polygon: [],
    aabb: { min: { x: cx - hx, y: y - 0.01, z: cz - hz }, max: { x: cx + hx, y: y + 0.01, z: cz + hz } },
    lastChanged: 0,
  };
  return { surface, confidence: 0.8, origin: 'ransac' };
}

const floor: EstimatedSurface = { surface: makeFloorSurface(6, 0), confidence: 1, origin: 'prior' };

describe('SurfaceRegistry', () => {
  it('debounces one-run ghosts, keeps stable ids across runs, smooths, and expires after keepAlive', () => {
    const reg = new SurfaceRegistry({ keepAliveMs: 1000, minObservations: 2, smoothing: 0.5 });
    // Run 1: floor publishes immediately; the table is pending.
    let d = reg.ingest([floor, table('camera-plane-0', 0.31, 0, -2.1)], 0);
    expect(d.register.map((s) => s.id)).toEqual(['camera-floor']);
    // Run 2: the estimator gave it a new id and a slightly different box; same surface -> published with a registry id.
    d = reg.ingest([floor, table('camera-plane-7', 0.33, 0.04, -2.12)], 400);
    expect(d.register.length).toBe(1);
    const id = d.register[0]!.id;
    expect(id).toMatch(/^surface-/);
    expect(d.register[0]!.pose.position.y).toBeCloseTo(0.32, 3); // EMA of 0.31 and 0.33
    // Run 3: missing -> still alive (no removal).
    d = reg.ingest([floor], 800);
    expect(d.remove).toEqual([]);
    expect(reg.surfaces.some((s) => s.id === id)).toBe(true);
    // Run 4: back with a tiny jitter -> no re-registration (below changeEps).
    d = reg.ingest([floor, table('camera-plane-2', 0.325, 0.01, -2.11)], 1200);
    expect(d.register).toEqual([]);
    // Runs 5..: gone for longer than keepAlive -> removed once.
    d = reg.ingest([floor], 1600);
    expect(d.remove).toEqual([]);
    d = reg.ingest([floor], 2300);
    expect(d.remove).toEqual([id]);
    d = reg.ingest([floor], 2700);
    expect(d.remove).toEqual([]);
  });

  it('a second table at a different height is a different surface', () => {
    const reg = new SurfaceRegistry({ minObservations: 1 });
    const d = reg.ingest([floor, table('a', 0.3, 0, -2), table('b', 0.75, 0, -2)], 0);
    expect(d.register.filter((s) => s.label === 'table').length).toBe(2);
  });
});
