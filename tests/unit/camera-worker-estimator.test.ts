import { describe, expect, it } from 'vitest';
import { WorkerSurfaceEstimator } from '@/camera/surfaces/worker-estimator';
import { DEFAULT_SURFACE_TUNING } from '@/camera/surfaces/depth-surfaces';
import { syntheticSceneDepth } from './helpers/synthetic-scene';

describe('WorkerSurfaceEstimator (inline fallback)', () => {
  it('publishes the floor prior first and the RANSAC scene after an update', () => {
    const est = new WorkerSurfaceEstimator({ cameraHeightM: 1.1, getTuning: () => DEFAULT_SURFACE_TUNING, inline: true });
    expect(est.mode).toBe('inline');
    expect(est.surfaces[0]!.origin).toBe('prior');
    const map = syntheticSceneDepth(true);
    est.update(map, map.pose, 5000);
    expect(est.surfaces[0]!.origin).toBe('ransac');
    expect(est.volumes.length).toBeGreaterThanOrEqual(1);
    expect(est.correction).not.toBeNull();
    expect(est.lastStats.walls).toBeGreaterThanOrEqual(1);
    est.setHeight(1.3);
    est.dispose();
  });
});
