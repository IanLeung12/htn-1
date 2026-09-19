/**
 * General-camera backend, phases 3-4: estimated depth -> RANSAC surfaces and
 * volumes -> discovery -> clean-plate capture (tier capped for estimated
 * depth) -> delete with a background hull drawn over the video.
 *
 * Depth is injected (`?depth=injected`) as a synthetic metric map computed
 * in Node from the same camera model the page uses: an analytic floor plus
 * a 0.3 m box standing on it. A second map without the box plays the role
 * of "the user lifted the object away" before the clean plate is taken.
 */
import { test, expect } from './camera-fixtures';
import { syntheticSceneDepth, SCENE_W as W, SCENE_H as H, SCENE_FOV as FOV } from '../unit/helpers/synthetic-scene';
import type { Pose } from '@/core/types';

function syntheticDepth(withBox: boolean): { pose: Pose; metric: number[] } {
  const map = syntheticSceneDepth(withBox);
  return { pose: map.pose, metric: Array.from(map.metric) };
}

test.use({ cameraParams: { depth: 'injected' } });

test('injected depth yields a floor and a volume; discovery, capped capture, and delete with hull', async ({ evalCam }) => {
  await expect.poll(async () => evalCam(() => window.__realityEditor!.inSession), { timeout: 15_000 }).toBe(true);

  const withBox = syntheticDepth(true);
  await evalCam(
    ({ pose, metric, w, h, fov }) => {
      const est = window.__camera!.depthEstimator as unknown as { inject(map: unknown): void };
      est.inject({ width: w, height: h, metric: Float32Array.from(metric), confidence: 0.9, source: 'monocular', pose, fovY: fov, aspect: w / h });
    },
    { pose: withBox.pose, metric: withBox.metric, w: W, h: H, fov: FOV },
  );

  // RANSAC replaces the floor prior and finds the box as a volume.
  await expect
    .poll(async () => evalCam(() => (window.__camera!.surfaceEstimator as unknown as { lastRunAt: number }).lastRunAt), { timeout: 10_000 })
    .toBeGreaterThan(0);
  console.log('surface stats', JSON.stringify(await evalCam(() => (window.__camera!.surfaceEstimator as unknown as { lastStats: unknown }).lastStats)));
  await expect.poll(async () => evalCam(() => window.__camera!.surfaceEstimator.volumes.length), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  const est = await evalCam(() => {
    const se = window.__camera!.surfaceEstimator;
    const v = se.volumes[0]!;
    return { floor: se.surfaces[0]!, cameraHeight: se.cameraHeightM, volume: { pos: v.pose.position, half: v.halfExtents, label: v.label } };
  });
  expect(est.floor.origin).toBe('ransac');
  expect(Math.abs(est.cameraHeight - 1.1)).toBeLessThan(0.08);
  expect(Math.abs(est.volume.pos.x - 0.2)).toBeLessThan(0.12);
  expect(Math.abs(est.volume.pos.z + 2.0)).toBeLessThan(0.15);
  expect(est.volume.half.y * 2).toBeGreaterThan(0.2);
  expect(est.volume.half.y * 2).toBeLessThan(0.45);

  // Discovery registers it against the ground surface, approves it, captures its appearance from
  // the live frame and synthesizes a support plate (tier D: movable, not deletable).
  const ids = await evalCam(() => window.__realityEditor!.runCandidateDiscovery());
  expect(ids.length).toBeGreaterThanOrEqual(1);
  const objectId = ids[0]!;
  const candidate = await evalCam((id) => window.__realityEditor!.store.current.objects[id]!, objectId);
  expect(candidate.origin).toBe('physical');
  expect(candidate.approved).toBe(true);
  expect(candidate.supportSurfaces).toContain('camera-floor');
  expect(candidate.tier).toBe('D');
  expect(candidate.visual.kind).toBe('baked');
  expect(candidate.background.at(-1)?.provenance).toBe('synthetic_completion');

  // Tier D: a move commits (and shows the synthetic plate at the old spot); delete is refused.
  const moved = await evalCam(
    (id) => {
      const o = window.__realityEditor!.store.current.objects[id]!;
      const pose = { position: { x: o.currentPose.position.x + 0.4, y: o.currentPose.position.y, z: o.currentPose.position.z }, rotation: o.currentPose.rotation };
      return window.__cameraTestHelpers!.dispatchIntent({ kind: 'move', objectId: id, pose });
    },
    objectId,
  );
  expect(moved.ok).toBe(true);
  // The moved copy renders its captured appearance (depth mesh from the live RGB-D frame), not a box.
  await expect.poll(async () => evalCam(() => window.__camera!.renderStats().appearanceActive), { timeout: 5_000 }).toBeGreaterThan(0);
  const early = await evalCam((id) => window.__cameraTestHelpers!.dispatchIntent({ kind: 'delete', objectId: id }), objectId);
  expect(early.ok).toBe(false);
  const undo = await evalCam(() => window.__cameraTestHelpers!.dispatchIntent({ kind: 'undo' }));
  expect(undo.ok).toBe(true);

  // "Lift the object away": inject the empty-floor depth, then capture the clean plate.
  const empty = syntheticDepth(false);
  await evalCam(
    ({ pose, metric, w, h, fov }) => {
      const est2 = window.__camera!.depthEstimator as unknown as { inject(map: unknown): void };
      est2.inject({ width: w, height: h, metric: Float32Array.from(metric), confidence: 0.9, source: 'monocular', pose, fovY: fov, aspect: w / h });
    },
    { pose: empty.pose, metric: empty.metric, w: W, h: H, fov: FOV },
  );
  const capture = await evalCam((id) => window.__realityEditor!.captureCleanPlate(id), objectId);
  expect(capture.coverage).toBeGreaterThan(0.6);
  // Monocular depth from one viewpoint: never tier A.
  expect(['B', 'C']).toContain(capture.tier);
  const plate = await evalCam((id) => window.__realityEditor!.store.current.objects[id]!.background.at(-1)!, objectId);
  expect(plate.provenance).not.toBe('observed_clean_plate');

  // Delete now succeeds and the background hull draws over the video.
  const del = await evalCam((id) => window.__cameraTestHelpers!.dispatchIntent({ kind: 'delete', objectId: id }), objectId);
  expect(del.ok).toBe(true);
  await expect.poll(async () => evalCam(() => window.__camera!.renderStats().hullChildren), { timeout: 5_000 }).toBeGreaterThan(0);

  const restore = await evalCam((id) => window.__cameraTestHelpers!.dispatchIntent({ kind: 'restore', objectId: id }), objectId);
  expect(restore.ok).toBe(true);
});
