/**
 * Owner bug: a depth pick landed 0.66 m above the plane the estimator had just
 * fitted, because picking and RANSAC unprojected differently. Both now share
 * pick.ts + the estimator's frame; pixels of a fitted plane must pick onto it.
 */
import { describe, expect, it } from 'vitest';
import { DepthSurfaceEstimator } from '@/camera/surfaces/depth-surfaces';
import { pickFromMap, pickFromMapRobust } from '@/camera/pick';
import { syntheticSceneDepth, SCENE_W, SCENE_H, WALL_Z } from './helpers/synthetic-scene';

describe('pickFromMap shares the estimator frame', () => {
  it('floor pixels pick onto y=0 and wall pixels onto the wall, within 2 cm', () => {
    const est = new DepthSurfaceEstimator({ cameraHeightM: 1.1 });
    const map = syntheticSceneDepth(false);
    est.update(map, map.pose, 5000);
    expect(est.lastFrame).not.toBeNull();
    // Bottom rows look at the floor.
    for (const px of [20, SCENE_W / 2, SCENE_W - 20]) {
      const p = pickFromMap(map, px, SCENE_H - 10, est.lastFrame)!;
      expect(Math.abs(p.y)).toBeLessThan(0.02);
    }
    // Top rows look at the wall.
    const w = pickFromMapRobust(map, SCENE_W / 2, 5, est.lastFrame)!;
    expect(Math.abs(w.z - WALL_Z)).toBeLessThan(0.02);
    // Same answer as the map's own pose when the estimator agrees with it (static camera, exact depth).
    const viaPose = pickFromMap(map, SCENE_W / 2, SCENE_H - 10, null)!;
    const viaFrame = pickFromMap(map, SCENE_W / 2, SCENE_H - 10, est.lastFrame)!;
    expect(Math.hypot(viaPose.x - viaFrame.x, viaPose.y - viaFrame.y, viaPose.z - viaFrame.z)).toBeLessThan(0.02);
  });

  it('a mis-pitched map pose still picks onto the fitted plane through the frame', () => {
    const est = new DepthSurfaceEstimator({ cameraHeightM: 1.1 });
    const map = syntheticSceneDepth(false);
    // Pretend the pose source believed the camera was level: the raw pose pick is wrong, the frame pick is right.
    const wrongPose = { position: { x: 0, y: 1.1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const skewed = { ...map, pose: wrongPose };
    est.update(skewed, wrongPose, 5000);
    const viaPose = pickFromMap(skewed, SCENE_W / 2, SCENE_H - 10, null)!;
    const viaFrame = pickFromMap(skewed, SCENE_W / 2, SCENE_H - 10, est.lastFrame)!;
    expect(Math.abs(viaPose.y)).toBeGreaterThan(0.2);
    expect(Math.abs(viaFrame.y)).toBeLessThan(0.02);
  });
});
