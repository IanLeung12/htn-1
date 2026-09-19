/**
 * The synthetic RGB-D scene the camera e2e spec injects (floor + wall + a
 * 0.3 m box at (0.2, 0, -2)) must be recoverable by DepthSurfaceEstimator;
 * this pins the generator and the estimator together so an e2e failure is
 * attributable.
 */
import { describe, expect, it } from 'vitest';
import { DepthSurfaceEstimator } from '@/camera/surfaces/depth-surfaces';
import { syntheticSceneDepth, WALL_Z } from './helpers/synthetic-scene';

describe('synthetic camera scene', () => {
  it('DepthSurfaceEstimator recovers the ground, the wall, the attitude, and the box volume', () => {
    const est = new DepthSurfaceEstimator({ cameraHeightM: 1.1 });
    const map = syntheticSceneDepth(true);
    expect(map.boxPixels).toBeGreaterThan(200);
    est.update(map, map.pose, 5000);
    expect(est.surfaces[0]!.origin).toBe('ransac');
    expect(Math.abs(est.cameraHeightM - 1.1)).toBeLessThan(0.08);
    expect(est.correction).not.toBeNull();
    expect(Math.abs(est.correction!.pitchRad + 0.35)).toBeLessThan(0.03);
    expect(Math.abs(est.correction!.rollRad)).toBeLessThan(0.03);
    const wall = est.surfaces.find((s) => s.surface.orientation === 'vertical');
    expect(wall).toBeDefined();
    expect(Math.abs(wall!.surface.pose.position.z - WALL_Z)).toBeLessThan(0.1);
    expect(est.surfaces.filter((s) => s.surface.label === 'table').length).toBe(0);
    expect(est.volumes.length).toBeGreaterThanOrEqual(1);
    const v = est.volumes[0]!;
    expect(Math.abs(v.pose.position.x - 0.2)).toBeLessThan(0.12);
    expect(Math.abs(v.pose.position.z + 2.0)).toBeLessThan(0.15);
    expect(v.halfExtents.y * 2).toBeGreaterThan(0.2);
    expect(v.halfExtents.y * 2).toBeLessThan(0.45);
  });

  it('the empty scene yields no volumes and keeps the wall', () => {
    const est = new DepthSurfaceEstimator({ cameraHeightM: 1.1 });
    const map = syntheticSceneDepth(false);
    est.update(map, map.pose, 5000);
    expect(est.volumes.length).toBe(0);
    expect(est.surfaces.some((s) => s.surface.orientation === 'vertical')).toBe(true);
  });
});
