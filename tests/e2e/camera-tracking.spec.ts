/**
 * Phase 5: a camera that gets bumped loses tracking (edits pause through the
 * resolver's tracking_lost rule) and recovers once the image settles. The
 * fake video barely moves, so the spec pushes two synthetic frames shifted
 * by 14 px through the same `pushFrame` path the frame loop uses.
 */
import { test, expect } from './camera-fixtures';

test('large image motion drops trackingOk, edits are refused, then it recovers', async ({ camPage, evalCam }) => {
  await expect.poll(async () => evalCam(() => window.__realityEditor!.inSession && window.__camera!.frameSource.ready), { timeout: 15_000 }).toBe(true);
  const id = await evalCam(() => window.__cameraTestHelpers!.spawnTestObject({ position: { x: 0, y: 0.08, z: -1.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }));
  expect(await evalCam(() => window.__camera!.poseSource.quality.trackingOk)).toBe(true);

  const lost = await evalCam(() => {
    const cam = window.__camera!;
    const pose = cam.poseSource as unknown as { pushFrame(f: unknown, i: unknown, now: number): void; quality: { trackingOk: boolean }; motionPx: number };
    const w = 160;
    const h = 120;
    const make = (shift: number): { width: number; height: number; rgba: Uint8ClampedArray; timestamp: number } => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      let seed = 7;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const tex = new Uint8ClampedArray((w + 64) * h);
      for (let i = 0; i < tex.length; i++) tex[i] = rnd() < 0.5 ? 30 : 220;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = tex[y * (w + 64) + x + 32 + shift]!;
          const o = (y * w + x) * 4;
          rgba[o] = v;
          rgba[o + 1] = v;
          rgba[o + 2] = v;
          rgba[o + 3] = 255;
        }
      }
      return { width: w, height: h, rgba, timestamp: performance.now() };
    };
    const intr = { fovY: cam.config.fovY, aspect: w / h, width: w, height: h };
    const t = performance.now();
    pose.pushFrame(make(0), intr, t);
    pose.pushFrame(make(14), intr, t + 100);
    cam.poseSource.update(t + 100);
    return { trackingOk: pose.quality.trackingOk, motionPx: pose.motionPx };
  });
  expect(lost.motionPx).toBeGreaterThan(6);
  expect(lost.trackingOk).toBe(false);

  const refused = await evalCam((oid) => window.__cameraTestHelpers!.dispatchIntent({ kind: 'delete', objectId: oid }), id);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.reason).toBe('tracking_lost');

  // The frame loop keeps pushing near-static fake-video frames; after settleMs tracking returns.
  await camPage.waitForTimeout(400);
  await expect.poll(async () => evalCam(() => window.__camera!.poseSource.quality.trackingOk), { timeout: 5_000 }).toBe(true);
  const ok = await evalCam((oid) => window.__cameraTestHelpers!.dispatchIntent({ kind: 'delete', objectId: oid }), id);
  // The region that fell back on tracking loss has returned to LIVE (RegionManager.recoverTrackingFallbacks).
  expect(ok.ok).toBe(true);
});
