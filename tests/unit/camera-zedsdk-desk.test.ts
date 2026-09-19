/**
 * A real ZED SDK frame (bridge map, 320x180 mm depth + confidence, tracked pose at the
 * tuning height 0.75 m, camera resting on a desk): the desk beyond the ZED's minimum
 * range is a table, valid pixels pick onto it, and a hole picks through to it.
 * Fixture captured by test-results/dumpmap.mjs against the live bridge.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { DepthMap } from '@/camera/contract';
import type { Surface } from '@/core/types';
import { DepthSurfaceEstimator } from '@/camera/surfaces/depth-surfaces';
import { pickFromMapRobust, pickOnSurfaceThroughHole, nearestValidDepth } from '@/camera/pick';
import { depthMillimetresToMetres } from '@/camera/zedsdk/protocol';

interface Fixture {
  width: number;
  height: number;
  fovY: number;
  aspect: number;
  pose: DepthMap['pose'];
  depthMmB64: string;
  confB64: string;
}

function loadFixture(): DepthMap {
  const j = JSON.parse(fs.readFileSync(path.resolve('tests', 'unit', 'fixtures', 'zed-sdk-desk-320x180.json'), 'utf-8')) as Fixture;
  const mmBytes = Buffer.from(j.depthMmB64, 'base64');
  const mm = new Uint16Array(mmBytes.buffer.slice(mmBytes.byteOffset, mmBytes.byteOffset + mmBytes.byteLength));
  const conf = new Uint8Array(Buffer.from(j.confB64, 'base64'));
  const metric = new Float32Array(mm.length);
  depthMillimetresToMetres(mm, conf, metric, 128);
  return { width: j.width, height: j.height, metric, confidence: 0.95, source: 'zed-sdk', pose: j.pose, fovY: j.fovY, aspect: j.aspect, timestamp: 1000, confidenceMap: conf };
}

describe('zed-sdk desk frame in trustPose mode', () => {
  const map = loadFixture();
  const est = new DepthSurfaceEstimator({ cameraHeightM: 0.75, trustPose: true, minIntervalMs: 0 });
  est.update(map, map.pose, 1000);
  const tables = est.surfaces.filter((s) => s.surface.label === 'table');

  it('registers the desk (0.65-0.78 m, just under the camera at 0.75 m) as a table, no ceiling tables', () => {
    expect(map.confidenceMap).toBeInstanceOf(Uint8Array);
    expect(tables.length).toBeGreaterThanOrEqual(1);
    const desk = tables.find((t) => t.surface.aabb.max.y > 0.62 && t.surface.aabb.max.y < 0.78);
    expect(desk).toBeDefined();
    for (const t of tables) expect(t.surface.aabb.max.y).toBeLessThan(1.6);
    // The frame stays the tracked pose.
    expect(est.lastFrame!.position.y).toBeCloseTo(0.75, 9);
  });

  it('objects standing on the desk (cans, controller) survive as volumes instead of being rejected as the table top', () => {
    // Every object on the desk lies entirely inside the desk footprint; only thin sheets or
    // clusters covering most of the table are table-top noise.
    const onDesk = est.volumes.filter((v) => {
      const bottom = v.pose.position.y - v.halfExtents.y;
      return bottom > 0.6 && bottom < 0.9 && v.halfExtents.y * 2 >= 0.06;
    });
    expect(onDesk.length).toBeGreaterThanOrEqual(1);
    for (const v of onDesk) {
      expect(v.halfExtents.x * 2).toBeLessThan(0.6);
      expect(v.halfExtents.z * 2).toBeLessThan(0.6);
    }
  });

  it('valid pixels pick the unprojected point (desk pixels land on the desk plane)', () => {
    const desk = tables.find((t) => t.surface.aabb.max.y > 0.62 && t.surface.aabb.max.y < 0.78)!;
    // Row 108 (NDC y = -0.2) has desk depth across the width in the fixture.
    let onDesk = 0;
    let picked = 0;
    for (const px of [64, 128, 160, 192, 256]) {
      const p = pickFromMapRobust(map, px, 108, est.lastFrame);
      if (!p) continue;
      picked += 1;
      if (Math.abs(p.y - desk.surface.aabb.max.y) < 0.08) onDesk += 1;
    }
    expect(picked).toBeGreaterThanOrEqual(3);
    expect(onDesk).toBeGreaterThanOrEqual(3);
  });

  it('a hole over the desk picks through to the desk surface', () => {
    const desk = tables.find((t) => t.surface.aabb.max.y > 0.62 && t.surface.aabb.max.y < 0.78)!;
    const surfaces: Surface[] = [est.surfaces[0]!.surface, desk.surface];
    // Punch a hole into a valid desk region and pick at its centre: the nearest valid depth
    // around the hole says how far the desk is, and the desk plane crosses the pixel ray there.
    const holed: DepthMap = { ...map, metric: new Float32Array(map.metric) };
    // Centre of the hole: a desk pixel whose 7x7 neighbourhood is fully valid (ZED desk depth is sparse).
    const R = 3;
    let cx = -1;
    let cy = -1;
    for (let y = 100; y < 135 && cx < 0; y++) {
      for (let x = 100; x < 220 && cx < 0; x++) {
        let ok = true;
        for (let dy = -R; dy <= R && ok; dy++) for (let dx = -R; dx <= R; dx++) if (!(map.metric[(y + dy) * map.width + x + dx]! > 0)) { ok = false; break; }
        const p = ok ? pickFromMapRobust(map, x, y, est.lastFrame) : null;
        if (p && Math.abs(p.y - desk.surface.aabb.max.y) < 0.02) { cx = x; cy = y; }
      }
    }
    expect(cx).toBeGreaterThan(0);
    for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) holed.metric[y * map.width + x] = 0;
    expect(pickFromMapRobust(holed, cx, cy, est.lastFrame)).toBeNull();
    const near = nearestValidDepth(holed, cx, cy);
    expect(near).not.toBeNull();
    expect(near!.distancePx).toBeGreaterThanOrEqual(R + 1);
    const pick = pickOnSurfaceThroughHole(holed, cx, cy, est.lastFrame, surfaces);
    expect(pick).not.toBeNull();
    expect(pick!.mode).toBe('surface');
    expect(pick!.point.y).toBeCloseTo(desk.surface.aabb.max.y, 6);
    // Where the ray meets the desk is within a few cm of where the depth said the desk was.
    const direct = pickFromMapRobust(map, cx, cy, est.lastFrame)!;
    expect(Math.hypot(pick!.point.x - direct.x, pick!.point.z - direct.z)).toBeLessThan(0.1);
  });
});
