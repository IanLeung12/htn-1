/**
 * ZED path without the device: the owner's 8 s side-by-side HD720 clip plays
 * through ZedStereoFrameSource. Checks the left-eye passthrough, per-eye
 * intrinsics, the factory calibration + rectification maps, and (once the
 * matcher branch is merged) that depth is published from the stereo backend.
 */
import { test, expect } from '@playwright/test';

test('side-by-side ZED clip drives the stereo frame source with the factory calibration', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/camera.html?headless=1&autostart=1&source=url&url=/zed/zed2-sbs-hd720-8s.webm&stereo=sbs&pose=static&depth=prior');
  await page.waitForFunction(() => Boolean(window.__realityEditor && window.__camera), { timeout: 30_000 });
  await expect.poll(async () => page.evaluate(() => window.__realityEditor!.inSession && window.__camera!.frameSource.ready), { timeout: 20_000 }).toBe(true);

  const info = await page.evaluate(() => {
    const cam = window.__camera!;
    const src = cam.frameSource as unknown as {
      kind: string;
      video: HTMLVideoElement;
      display: HTMLCanvasElement;
      intrinsics: { width: number; height: number; fovY: number };
      stereo?: { baselineM: number; fxPx: number; eyeWidth: number; eyeHeight: number; calibrationId: string | null };
      calibration: { serial: string | null; baselineM: number } | null;
      rectifyMaps(mode: string): { width: number; height: number; fxRect: number; left: Float32Array } | null;
      grabStereo(w: number): { width: number; height: number; rgba: Uint8ClampedArray; right?: Uint8ClampedArray } | null;
    };
    const maps = src.rectifyMaps('hd720');
    const pair = src.grabStereo(336);
    let diff = 0;
    if (pair && pair.right) {
      for (let i = 0; i < pair.rgba.length; i += 16) diff += Math.abs(pair.rgba[i]! - pair.right[i]!);
      diff /= pair.rgba.length / 16;
    }
    return {
      kind: src.kind,
      video: { w: src.video.videoWidth, h: src.video.videoHeight },
      display: { w: src.display.width, h: src.display.height, attached: src.display.isConnected },
      intr: src.intrinsics,
      stereo: src.stereo,
      serial: src.calibration?.serial ?? null,
      maps: maps ? { w: maps.width, h: maps.height, fx: maps.fxRect, finite: Number.isFinite(maps.left[0]!) } : null,
      pair: pair ? { w: pair.width, h: pair.height, hasRight: !!pair.right, meanAbsDiff: diff } : null,
      diag: cam.diagnostics.getLines().join('\n'),
    };
  });
  expect(info.kind).toBe('stereo');
  expect(info.video.w).toBe(2560);
  expect(info.video.h).toBe(720);
  expect(info.intr.width).toBe(1280);
  expect(info.intr.height).toBe(720);
  expect(info.display.w).toBe(1280);
  expect(info.display.attached).toBe(true);
  expect(info.stereo?.baselineM).toBeGreaterThan(0.115);
  expect(info.stereo?.baselineM).toBeLessThan(0.125);
  expect(info.serial).toBe('25491304');
  expect(info.stereo?.fxPx).toBeGreaterThan(500);
  expect(info.maps).not.toBeNull();
  expect(info.maps!.w).toBe(1280);
  expect(info.maps!.finite).toBe(true);
  expect(info.pair?.hasRight).toBe(true);
  expect(info.pair!.w).toBe(336);
  // The two eyes of a real scene differ (parallax + exposure); identical halves would mean a bad crop.
  expect(info.pair!.meanAbsDiff).toBeGreaterThan(2);
  expect(info.diag).toContain('stereo');
  expect(errors).toEqual([]);
});
