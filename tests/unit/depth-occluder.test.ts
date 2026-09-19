import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DepthOccluder, forwardDepthToNdc, OCCLUDER_STALE_MS } from '@/camera/depth-occluder';
import { IDENTITY_QUAT } from '@/core/types';
import type { DepthMap } from '@/camera/contract';

function ndcFromThreeCamera(depthM: number, near: number, far: number, fovYDeg = 50, aspect = 4 / 3): number {
  const camera = new THREE.PerspectiveCamera(fovYDeg, aspect, near, far);
  camera.updateProjectionMatrix();
  const clip = new THREE.Vector4(0, 0, -depthM, 1).applyMatrix4(camera.projectionMatrix);
  const ndc = clip.z / clip.w;
  return Math.min(1, Math.max(0, ndc * 0.5 + 0.5));
}

describe('forwardDepthToNdc', () => {
  it('matches three.js perspective projection at several depths', () => {
    const near = 0.01;
    const far = 50;
    for (const depth of [0.05, 0.38, 0.49, 1, 2.5, 10, 49]) {
      const expected = ndcFromThreeCamera(depth, near, far);
      const actual = forwardDepthToNdc(depth, near, far);
      expect(actual).toBeCloseTo(expected, 5);
    }
  });

  it('is monotonically increasing with depth (farther = larger depth-buffer value)', () => {
    const a = forwardDepthToNdc(0.4, 0.01, 50);
    const b = forwardDepthToNdc(0.9, 0.01, 50);
    expect(b).toBeGreaterThan(a);
  });

  it('maps invalid depths to the far plane (1.0)', () => {
    expect(forwardDepthToNdc(0, 0.01, 50)).toBe(1);
    expect(forwardDepthToNdc(-1, 0.01, 50)).toBe(1);
    expect(forwardDepthToNdc(NaN, 0.01, 50)).toBe(1);
    expect(forwardDepthToNdc(Infinity, 0.01, 50)).toBe(1);
  });

  it('clamps depths beyond the far plane to 1.0 and at/inside near to 0.0', () => {
    expect(forwardDepthToNdc(1000, 0.01, 50)).toBe(1);
    expect(forwardDepthToNdc(0.001, 0.01, 50)).toBe(0);
  });
});

function makeMap(overrides: Partial<DepthMap> = {}): DepthMap {
  const width = 4;
  const height = 4;
  const metric = new Float32Array(width * height).fill(0.5);
  return {
    width,
    height,
    metric,
    confidence: 1,
    source: 'monocular',
    pose: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT },
    fovY: (50 * Math.PI) / 180,
    aspect: width / height,
    timestamp: 1000,
    ...overrides,
  };
}

describe('DepthOccluder', () => {
  it('is disabled and invisible with no map', () => {
    const occluder = new DepthOccluder();
    occluder.update(undefined, 1000, true, 0.02);
    expect(occluder.mesh.visible).toBe(false);
    expect(occluder.state.enabled).toBe(true);
  });

  it('is invisible when the tuning flag is off, even with a fresh map', () => {
    const occluder = new DepthOccluder();
    occluder.update(makeMap(), 1000, false, 0.02);
    expect(occluder.mesh.visible).toBe(false);
    expect(occluder.state.enabled).toBe(false);
  });

  it('skips a stale map (older than OCCLUDER_STALE_MS)', () => {
    const occluder = new DepthOccluder();
    const map = makeMap({ timestamp: 0 });
    occluder.update(map, OCCLUDER_STALE_MS + 1, true, 0.02);
    expect(occluder.mesh.visible).toBe(false);
  });

  it('becomes visible and uploads once for a fresh, enabled map', () => {
    const occluder = new DepthOccluder();
    const map = makeMap({ timestamp: 500 });
    occluder.update(map, 500 + OCCLUDER_STALE_MS - 1, true, 0.02);
    expect(occluder.mesh.visible).toBe(true);
    expect(occluder.state.lastUploadTs).toBe(500);
    expect(occluder.state.textureWidth).toBe(4);
    expect(occluder.state.textureHeight).toBe(4);
  });

  it('does not re-upload for the same timestamp on a later call', () => {
    const occluder = new DepthOccluder();
    const map = makeMap({ timestamp: 500 });
    occluder.update(map, 500, true, 0.02);
    const firstUpload = occluder.state.lastUploadTs;
    // Mutate the buffer without changing the timestamp: a second update() at
    // the same timestamp must not re-read it (matches "update only when
    // timestamp changes").
    map.metric.fill(9);
    occluder.update(map, 510, true, 0.02);
    expect(occluder.state.lastUploadTs).toBe(firstUpload);
  });

  it('reallocates the texture when the map size changes', () => {
    const occluder = new DepthOccluder();
    occluder.update(makeMap({ timestamp: 1 }), 1, true, 0.02);
    expect(occluder.state.textureWidth).toBe(4);
    const bigger: DepthMap = makeMap({ timestamp: 2, width: 8, height: 6, metric: new Float32Array(8 * 6).fill(0.5) });
    occluder.update(bigger, 2, true, 0.02);
    expect(occluder.state.textureWidth).toBe(8);
    expect(occluder.state.textureHeight).toBe(6);
  });
});
