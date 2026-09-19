/**
 * Metric fit for relative inverse depth.
 *
 * Depth Anything V2 (non-metric) predicts affine-invariant inverse depth:
 * v = a / z + b for unknown a > 0, b. Pixels the floor prior says are floor
 * have a known metric depth z (camera height, pitch, and FOV give it
 * analytically), so a and b follow from a robust least-squares fit of v
 * against 1/z over those pixels; z = a / (v - b) everywhere else. Objects
 * standing on the floor pollute the sample, so the fit iterates: fit, drop
 * residuals beyond 2 sigma, refit (up to 3 rounds). Pure TS, unit-tested.
 */

export interface InverseDepthFit {
  a: number;
  b: number;
  /** Fraction of candidate pixels kept as inliers by the final round. */
  inlierFraction: number;
  /** RMS residual of the final round in inverse-depth units. */
  rms: number;
  /** Number of candidate pixels considered. */
  samples: number;
}

/**
 * Fit `inverse` (row-major, w*h) to `floorDepth` (same grid, 0 where the
 * floor is not seen). Only pixels with floorDepth > 0 and finite inverse are
 * used; `stride` subsamples for speed. Returns null when fewer than `minSamples`
 * pixels are usable or the fit degenerates (a <= 0).
 */
export function fitInverseDepthToFloor(
  inverse: Float32Array,
  floorDepth: Float32Array,
  opts: { stride?: number; minSamples?: number; rounds?: number; sigmaClip?: number } = {},
): InverseDepthFit | null {
  const stride = opts.stride ?? 3;
  const minSamples = opts.minSamples ?? 64;
  const rounds = opts.rounds ?? 3;
  const sigmaClip = opts.sigmaClip ?? 2;
  const n = Math.min(inverse.length, floorDepth.length);

  // Gather candidates: x = 1/z, y = v.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const z = floorDepth[i] as number;
    const v = inverse[i] as number;
    if (!(z > 0) || !Number.isFinite(v)) continue;
    xs.push(1 / z);
    ys.push(v);
  }
  if (xs.length < minSamples) return null;

  const keep = new Uint8Array(xs.length).fill(1);
  let a = 0;
  let b = 0;
  let rms = 0;
  let kept = xs.length;
  for (let round = 0; round < rounds; round++) {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let m = 0;
    for (let i = 0; i < xs.length; i++) {
      if (!keep[i]) continue;
      const x = xs[i] as number;
      const y = ys[i] as number;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
      m += 1;
    }
    if (m < minSamples) return null;
    const det = m * sxx - sx * sx;
    if (Math.abs(det) < 1e-12) return null;
    a = (m * sxy - sx * sy) / det;
    b = (sy - a * sx) / m;

    let se = 0;
    for (let i = 0; i < xs.length; i++) {
      if (!keep[i]) continue;
      const r = (ys[i] as number) - (a * (xs[i] as number) + b);
      se += r * r;
    }
    rms = Math.sqrt(se / m);
    kept = m;
    if (round < rounds - 1 && rms > 0) {
      const limit = sigmaClip * rms;
      for (let i = 0; i < xs.length; i++) {
        if (!keep[i]) continue;
        const r = (ys[i] as number) - (a * (xs[i] as number) + b);
        if (Math.abs(r) > limit) keep[i] = 0;
      }
    }
  }
  if (!(a > 0)) return null;
  return { a, b, inlierFraction: kept / xs.length, rms, samples: xs.length };
}

/** Apply a fit: metric depth z = a / (v - b), clamped to [minM, maxM]; 0 where invalid. */
export function inverseToMetric(inverse: Float32Array, fit: InverseDepthFit, out: Float32Array, minM = 0.1, maxM = 20): void {
  const n = Math.min(inverse.length, out.length);
  for (let i = 0; i < n; i++) {
    const d = (inverse[i] as number) - fit.b;
    if (!(d > 0)) {
      out[i] = 0;
      continue;
    }
    const z = fit.a / d;
    out[i] = z < minM ? minM : z > maxM ? maxM : z;
  }
}

/** Nearest-neighbour resample of a depth grid to another size. */
export function resampleDepth(src: Float32Array, sw: number, sh: number, dw: number, dh: number, out?: Float32Array): Float32Array {
  const dst = out ?? new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) / dh) * sh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) / dw) * sw));
      dst[y * dw + x] = src[sy * sw + sx] as number;
    }
  }
  return dst;
}

/** 0..1 confidence from the fit's inlier fraction and relative residual (heuristic, documented in architecture.md). */
export function fitConfidence(fit: InverseDepthFit, meanInverse: number): number {
  const rel = meanInverse > 0 ? fit.rms / meanInverse : 1;
  const residualScore = Math.max(0, 1 - rel / 0.25);
  return Math.max(0, Math.min(1, 0.5 * fit.inlierFraction + 0.5 * residualScore));
}

/**
 * Last-resort scale anchor when no plane is available: assume the bottom
 * band of the image looks at the support surface at `anchorDepthM` and the
 * model's shift is zero (v = a / z). Confidence is low by construction.
 */
export function fitInverseDepthBand(inverse: Float32Array, width: number, height: number, anchorDepthM: number, bandFraction = 0.2): InverseDepthFit | null {
  const rows = Math.max(1, Math.floor(height * bandFraction));
  const vals: number[] = [];
  for (let y = height - rows; y < height; y++) {
    for (let x = 0; x < width; x += 2) {
      const v = inverse[y * width + x] as number;
      if (Number.isFinite(v) && v > 0) vals.push(v);
    }
  }
  if (vals.length < 16 || !(anchorDepthM > 0)) return null;
  vals.sort((p, q) => p - q);
  const median = vals[Math.floor(vals.length / 2)] as number;
  if (!(median > 0)) return null;
  return { a: median * anchorDepthM, b: 0, inlierFraction: 0.2, rms: 0, samples: vals.length };
}
