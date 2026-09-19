/**
 * The WebGL2 stereo matcher (src/camera/stereo/stereo-depth.ts) on a synthetic
 * ray-cast pair (tests/unit/helpers/stereo-pair.ts: floor at 1.1 m under a
 * camera pitched -0.35 rad, a 0.3 m box at ~2 m, a wall at 3.5 m; the left eye
 * 0.8x darker than the right). Both modules are loaded straight from the Vite
 * dev server inside camera.html, so this runs the real shaders (SwiftShader
 * when headless) without the camera app.
 *
 * Checks: depth accuracy against the analytic ground truth, agreement with the
 * CPU reference (src/camera/stereo/census.ts) which the unit tests verify, the
 * identity rectification-map path, and the reported timing.
 */
import { test, expect } from '@playwright/test';

interface Run {
  renderer: string;
  status: { state: string; backend: string; error: string | null };
  stats: { workWidth: number; workHeight: number; maxDisparity: number; validFraction: number; lastMs: number; rectified: boolean; backend: string };
  msMedian: number;
  floor: { median: number; count: number };
  box: { median: number; count: number; truth: number };
  errMedian: number;
  errP90: number;
  cpuAgree: number;
  cpuValid: number;
  mapErrMedian: number;
}

test('WebGL2 census matcher: metric depth within 3% of the synthetic scene and agrees with the CPU reference', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/camera.html?headless=1');

  const run = await page.evaluate(async (): Promise<Run> => {
    // Served by the Vite dev server (TypeScript transformed on request); the paths are variables so tsc does not resolve them.
    const load = (p: string): Promise<unknown> => import(/* @vite-ignore */ p);
    const stereo = (await load('/src/camera/stereo/stereo-depth.ts')) as typeof import('@/camera/stereo/stereo-depth');
    const census = (await load('/src/camera/stereo/census.ts')) as typeof import('@/camera/stereo/census');
    const pairMod = (await load('/tests/unit/helpers/stereo-pair.ts')) as typeof import('../unit/helpers/stereo-pair');

    const W = 336;
    const H = 188;
    const FX = 132; // px at the work width (VGA eye fx 264 at 672 px, halved)
    const B = 0.12;
    const D = 64;
    const pair = pairMod.renderStereoPair({ eyeWidth: W, eyeHeight: H, fxPx: FX, baselineM: B });

    const calib = {
      baselineM: B,
      fxPx: FX * 2,
      eyeWidth: W * 2,
      eyeHeight: H * 2,
      rectifyMaps: null as null | { left: Float32Array; right: Float32Array; width: number; height: number; fxRect: number; cxRect: number; cyRect: number },
      calibration: null,
      mode: 'vga' as const,
      calibrationId: null,
    };
    const est = stereo.createStereoDepthEstimator({ getCalibration: () => calib, workWidth: W, maxDisparity: D });
    await est.start();
    const pose = { position: { x: 0, y: 1.1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const intr = { fovY: 2 * Math.atan(H / (2 * FX)), aspect: W / H, width: W, height: H };

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2')!;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';

    // Warm up, then time a few submits.
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const ok = est.submit(pair.left, pose, intr);
      if (!ok) throw new Error(`submit failed: ${est.status.error}`);
      times.push(est.stats.lastMs);
    }
    times.sort((a, b) => a - b);
    const map = est.latest!;
    const metric = map.metric;
    const disp = est.latestDisparity!.data;

    const median = (xs: number[]): number => {
      xs.sort((a, b) => a - b);
      return xs.length ? xs[Math.floor(xs.length / 2)]! : NaN;
    };
    // Floor: bottom rows, truth between 1 and 3 m and not on the box; box: truth 1.85..2.15 m in the box column band.
    const floor: number[] = [];
    const box: number[] = [];
    const boxTruth: number[] = [];
    const errs: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const m = metric[i]!;
        const t = pair.truthDepth[i]!;
        if (!(m > 0)) continue;
        if (t >= 1 && t <= 3) errs.push(Math.abs(m - t) / t);
        if (y > H * 0.7 && t >= 1 && t <= 3) floor.push(m);
        if (t >= 1.85 && t <= 2.15 && y > H * 0.3 && y < H * 0.7) {
          box.push(m);
          boxTruth.push(t);
        }
      }
    }
    errs.sort((a, b) => a - b);

    // CPU reference at the same size / range (both unrectified, rowSearch 0 vs GPU rowSearch 2 without maps).
    const cpu = census.stereoDepthCpu(pair.left, pair.left.right!, { fxPx: FX, baselineM: B, maxDisparity: D, rowSearch: 0 });
    let both = 0;
    let agree = 0;
    let cpuValid = 0;
    for (let i = 0; i < W * H; i++) {
      if (cpu.valid[i]) cpuValid++;
      if (!cpu.valid[i] || !(metric[i]! > 0)) continue;
      both++;
      const dCpu = (FX * B) / cpu.metric[i]!;
      if (Math.abs(dCpu - disp[i]!) <= 1) agree++;
    }

    const status = { state: est.status.state, backend: est.status.backend, error: est.status.error };
    const stats = { ...est.stats };
    // Identity rectification maps (full-eye coordinates): the map path (no row search) must also be accurate.
    const mw = W * 2;
    const mh = H * 2;
    const ident = new Float32Array(mw * mh * 2);
    for (let v = 0; v < mh; v++) for (let u = 0; u < mw; u++) {
      ident[(v * mw + u) * 2] = u;
      ident[(v * mw + u) * 2 + 1] = v;
    }
    calib.rectifyMaps = { left: ident, right: ident, width: mw, height: mh, fxRect: FX * 2, cxRect: mw / 2, cyRect: mh / 2 };
    if (!est.submit(pair.left, pose, intr)) throw new Error(`submit (maps) failed: ${est.status.error}`);
    const mapped = est.latest!.metric;
    const mapErrs: number[] = [];
    for (let i = 0; i < W * H; i++) {
      const t = pair.truthDepth[i]!;
      if (!(mapped[i]! > 0) || t < 1 || t > 3) continue;
      mapErrs.push(Math.abs(mapped[i]! - t) / t);
    }
    const rectifiedStat = est.stats.rectified;
    est.dispose();

    return {
      renderer,
      status,
      stats: { ...stats, rectified: rectifiedStat },
      msMedian: times[Math.floor(times.length / 2)]!,
      floor: { median: median(floor), count: floor.length },
      box: { median: median(box), count: box.length, truth: median(boxTruth) },
      errMedian: errs[Math.floor(errs.length / 2)] ?? NaN,
      errP90: errs[Math.floor(errs.length * 0.9)] ?? NaN,
      cpuAgree: both ? agree / both : 0,
      cpuValid: cpuValid / (W * H),
      mapErrMedian: median(mapErrs),
    };
  });

  console.log(`stereo matcher on ${run.renderer}: ${run.stats.workWidth}x${run.stats.workHeight} d0..${run.stats.maxDisparity} valid ${(run.stats.validFraction * 100).toFixed(0)}% median ${run.msMedian.toFixed(1)} ms; floor median ${run.floor.median.toFixed(3)} m, box median ${run.box.median.toFixed(3)} m (truth ${run.box.truth.toFixed(3)}), err median ${(run.errMedian * 100).toFixed(2)}% p90 ${(run.errP90 * 100).toFixed(2)}%, CPU agreement ${(run.cpuAgree * 100).toFixed(1)}% (CPU valid ${(run.cpuValid * 100).toFixed(0)}%), identity-map err median ${(run.mapErrMedian * 100).toFixed(2)}%`);

  expect(errors).toEqual([]);
  expect(run.status.state).toBe('ready');
  expect(run.status.backend).toBe('webgl2');
  expect(run.stats.validFraction).toBeGreaterThan(0.6);
  expect(run.floor.count).toBeGreaterThan(500);
  expect(run.box.count).toBeGreaterThan(50);
  expect(Math.abs(run.box.median - run.box.truth) / run.box.truth).toBeLessThan(0.05);
  expect(run.errMedian).toBeLessThan(0.03);
  expect(run.errP90).toBeLessThan(0.08);
  expect(run.cpuAgree).toBeGreaterThan(0.85);
  expect(run.stats.rectified).toBe(true);
  expect(run.mapErrMedian).toBeLessThan(0.03);
});
