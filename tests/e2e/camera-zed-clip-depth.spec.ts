/**
 * Real ZED 2 footage through the whole stereo path: the owner's 8 s
 * side-by-side HD720 clip (public/zed/zed2-sbs-hd720-8s.webm, unrectified)
 * plays through ZedStereoFrameSource, the factory calibration (SN 25491304)
 * builds the rectification maps, and the WebGL2 matcher publishes metric depth.
 *
 * Ground truth for real pixels comes from the images themselves: the
 * gradient cross-correlation of the two rectified eyes over signed horizontal
 * shifts has a clear peak in the middle band of this clip (the cans / laptop
 * ~0.4 m in front of the camera), and the matcher's median disparity there
 * must agree with it within a few pixels. The desk (bottom band) and the room
 * behind (top band) are only bounded loosely and printed for the docs.
 */
import { test, expect } from '@playwright/test';

interface Band {
  corrPeak: number;
  corrRatio: number;
  dispMedian: number;
  depthMedian: number;
  valid: number;
}

test('ZED SBS clip: rectified WebGL2 stereo depth agrees with the image correlation; desk and room depths', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/camera.html?headless=1&autostart=1&source=url&url=/zed/zed2-sbs-hd720-8s.webm&stereo=sbs&pose=static&depth=prior');
  await page.waitForFunction(() => Boolean(window.__realityEditor && window.__camera), { timeout: 30_000 });
  await expect.poll(async () => page.evaluate(() => window.__realityEditor!.inSession && window.__camera!.frameSource.ready), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => page.evaluate(() => window.__camera!.depthEstimator.status.frames), { timeout: 30_000 }).toBeGreaterThan(5);

  const result = await page.evaluate(() => {
    const cam = window.__camera!;
    const src = cam.frameSource as unknown as {
      stereo: { baselineM: number; fxPx: number; eyeWidth: number };
      rectifyMaps(mode: string): { left: Float32Array; right: Float32Array; width: number; height: number } | null;
      grabStereo(w: number): { width: number; height: number; rgba: Uint8ClampedArray; right?: Uint8ClampedArray } | null;
    };
    const est = cam.depthEstimator as unknown as {
      status: { backend: string; error: string | null; frames: number };
      stats: Record<string, number | string | boolean>;
      latest?: { width: number; height: number; metric: Float32Array; confidence: number; source: string };
      latestDisparity?: { data: Float32Array; width: number; height: number };
      latestConfidence?: Float32Array;
    };
    const map = est.latest!;
    const { width: W, height: H, metric } = map;
    const disp = est.latestDisparity!.data;
    const conf = est.latestConfidence!;
    const fx = (src.stereo.fxPx * W) / src.stereo.eyeWidth;
    const maps = src.rectifyMaps('hd720')!;
    const pair = src.grabStereo(W)!;

    // CPU nearest-neighbour rectification of both eyes, row-mean removed, horizontal gradient.
    const remap = (rgba: Uint8ClampedArray, m: Float32Array): Float32Array => {
      const g = new Float32Array(W * H);
      const sx = maps.width / W;
      const sy = maps.height / H;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const mi = (Math.min(maps.height - 1, Math.floor((y + 0.5) * sy)) * maps.width + Math.min(maps.width - 1, Math.floor((x + 0.5) * sx))) * 2;
          const u = Math.round(m[mi]! / sx);
          const v = Math.round(m[mi + 1]! / sy);
          if (u < 0 || v < 0 || u >= W || v >= H) continue;
          const si = (v * W + u) * 4;
          g[y * W + x] = 0.299 * rgba[si]! + 0.587 * rgba[si + 1]! + 0.114 * rgba[si + 2]!;
        }
      }
      for (let y = 0; y < H; y++) {
        let s = 0;
        for (let x = 0; x < W; x++) s += g[y * W + x]!;
        s /= W;
        for (let x = 0; x < W; x++) g[y * W + x] = g[y * W + x]! - s;
      }
      const o = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 1; x < W - 1; x++) o[y * W + x] = g[y * W + x + 1]! - g[y * W + x - 1]!;
      return o;
    };
    const GL = remap(pair.rgba, maps.left);
    const GR = remap(pair.right!, maps.right);

    const band = (y0: number, y1: number): Band => {
      let best: [number, number] = [0, -Infinity];
      let second: [number, number] = [0, -Infinity];
      for (let s = -20; s <= 80; s++) {
        let acc = 0;
        let n = 0;
        for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
          for (let x = 64; x < W - 64; x++) {
            const xr = x - s;
            if (xr < 0 || xr >= W) continue;
            acc += GL[y * W + x]! * GR[y * W + xr]!;
            n++;
          }
        }
        const v = n ? acc / n : 0;
        if (v > best[1]) {
          if (Math.abs(s - best[0]) > 3) second = best;
          best = [s, v];
        } else if (v > second[1] && Math.abs(s - best[0]) > 3) second = [s, v];
      }
      const ds: number[] = [];
      const zs: number[] = [];
      let n = 0;
      let valid = 0;
      for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
        for (let x = 0; x < W; x++) {
          n++;
          const i = y * W + x;
          if (conf[i]! >= 1) {
            valid++;
            ds.push(disp[i]!);
            zs.push(metric[i]!);
          }
        }
      }
      ds.sort((a, b) => a - b);
      zs.sort((a, b) => a - b);
      return { corrPeak: best[0], corrRatio: best[1] / Math.max(1e-6, second[1]), dispMedian: ds[ds.length >> 1] ?? NaN, depthMedian: zs[zs.length >> 1] ?? NaN, valid: valid / n };
    };
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
      status: est.status,
      stats: est.stats,
      source: map.source,
      confidence: map.confidence,
      size: { w: W, h: H },
      fx,
      top: band(0.05, 0.3),
      mid: band(0.3, 0.67),
      bottom: band(0.67, 1.0),
      diag: cam.diagnostics.getLines().find((l) => l.includes('stereo')) ?? '',
    };
  });

  const fmt = (b: Band): string => `corr peak ${b.corrPeak} px (ratio ${b.corrRatio.toFixed(2)}), matcher median ${b.dispMedian.toFixed(1)} px = ${b.depthMedian.toFixed(3)} m, valid ${(b.valid * 100).toFixed(0)}%`;
  console.log(`ZED clip on ${result.renderer}: ${result.diag}; map ${result.size.w}x${result.size.h} fx ${result.fx.toFixed(1)} LR-valid ${(result.confidence * 100).toFixed(0)}%\n  top (room): ${fmt(result.top)}\n  mid (cans/laptop): ${fmt(result.mid)}\n  bottom (desk): ${fmt(result.bottom)}`);

  expect(errors).toEqual([]);
  expect(result.status.backend).toBe('webgl2');
  expect(result.status.error).toBeNull();
  expect(result.source).toBe('stereo');
  expect(result.stats['rectified']).toBe(true);
  expect(result.stats['eyesSwapped']).toBe(false);
  expect(result.size.w).toBe(336);
  expect(result.confidence).toBeGreaterThan(0.25);
  // The middle band has a clear correlation peak; the matcher must agree with it.
  expect(result.mid.corrRatio).toBeGreaterThan(1.15);
  expect(Math.abs(result.mid.dispMedian - result.mid.corrPeak)).toBeLessThanOrEqual(3);
  expect(result.mid.valid).toBeGreaterThan(0.3);
  // Loose plausibility for the desk edge (near) and the room behind (far).
  expect(result.bottom.depthMedian).toBeGreaterThan(0.25);
  expect(result.bottom.depthMedian).toBeLessThan(1.3);
  expect(result.top.depthMedian).toBeGreaterThan(1.0);
  expect(result.top.depthMedian).toBeLessThan(4.0);
});
