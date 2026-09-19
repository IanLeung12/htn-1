/**
 * Real ZED 2 footage through the whole stereo path: the owner's 8 s
 * side-by-side HD720 clip (public/zed/zed2-sbs-hd720-8s.webm, unrectified)
 * plays through ZedStereoFrameSource, the factory calibration (SN 25491304)
 * builds the rectification maps, and the WebGL2 matcher publishes metric depth.
 *
 * The scene is the owner's desk (bottom third of the frame, ~0.6-0.9 m) with
 * the far wall at the top centre (~2.5 m). Bounds are loose: the point is that
 * the rectified pipeline produces plausible metric depth on real pixels, and
 * the measured numbers are printed for the STATE/stereo docs.
 */
import { test, expect } from '@playwright/test';

test('ZED SBS clip: rectified WebGL2 stereo depth of the desk and the far wall', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/camera.html?headless=1&autostart=1&source=url&url=/zed/zed2-sbs-hd720-8s.webm&stereo=sbs&pose=static&depth=prior');
  await page.waitForFunction(() => Boolean(window.__realityEditor && window.__camera), { timeout: 30_000 });
  await expect.poll(async () => page.evaluate(() => window.__realityEditor!.inSession && window.__camera!.frameSource.ready), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => page.evaluate(() => window.__camera!.depthEstimator.status.frames), { timeout: 30_000 }).toBeGreaterThan(5);

  const result = await page.evaluate(() => {
    const cam = window.__camera!;
    const est = cam.depthEstimator as unknown as { status: { backend: string; error: string | null; frames: number }; stats: Record<string, number | string | boolean>; latest?: { width: number; height: number; metric: Float32Array; confidence: number; source: string } };
    const map = est.latest!;
    const { width: w, height: h, metric } = map;
    const median = (x0: number, x1: number, y0: number, y1: number): { median: number; valid: number } => {
      const xs: number[] = [];
      let total = 0;
      for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++) {
        for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
          total++;
          const m = metric[y * w + x]!;
          if (m > 0) xs.push(m);
        }
      }
      xs.sort((a, b) => a - b);
      return { median: xs.length ? xs[Math.floor(xs.length / 2)]! : NaN, valid: total ? xs.length / total : 0 };
    };
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    return {
      renderer,
      status: est.status,
      stats: est.stats,
      source: map.source,
      confidence: map.confidence,
      size: { w, h },
      desk: median(0.2, 0.8, 0.67, 1.0),
      wall: median(0.35, 0.65, 0.05, 0.25),
      diag: cam.diagnostics.getLines().find((l) => l.startsWith('stereo')) ?? '',
    };
  });

  console.log(`ZED clip on ${result.renderer}: ${result.diag}; map ${result.size.w}x${result.size.h} LR-valid ${(result.confidence * 100).toFixed(0)}%; desk median ${result.desk.median.toFixed(3)} m (valid ${(result.desk.valid * 100).toFixed(0)}%), wall median ${result.wall.median.toFixed(3)} m (valid ${(result.wall.valid * 100).toFixed(0)}%)`);

  expect(errors).toEqual([]);
  expect(result.status.backend).toBe('webgl2');
  expect(result.status.error).toBeNull();
  expect(result.source).toBe('stereo');
  expect(result.stats['rectified']).toBe(true);
  expect(result.size.w).toBe(336);
  expect(result.confidence).toBeGreaterThan(0.3);
  expect(result.desk.valid).toBeGreaterThan(0.3);
  expect(result.desk.median).toBeGreaterThan(0.4);
  expect(result.desk.median).toBeLessThan(1.3);
  expect(result.wall.median).toBeGreaterThan(1.5);
  expect(result.wall.median).toBeLessThan(4.5);
});
