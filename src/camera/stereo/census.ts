/**
 * Pure-TS census-transform stereo matching: the CPU reference implementation
 * for the "general camera" stereo backend (see docs/general-camera and
 * src/camera/stereo/stereo-depth.ts, the WebGL2 version of the same
 * pipeline). Used directly by tests (no GPU in vitest) and as the algorithm
 * spec the shader passes mirror.
 *
 * Pipeline: toGray -> equalizeRowsToReference -> census5x5 -> matchCensus
 * (both directions) -> lrCheck -> median3x3 -> disparityToDepth.
 *
 * Depth convention: metres along the camera forward axis (src/capture/geom.ts).
 * Pixel y=0 is the top row (GrabbedFrame.rgba convention).
 */
import type { GrabbedFrame } from '../contract';

/** Luma from RGBA8 (row-major, top row first). */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number, out?: Float32Array): Float32Array {
  const dst = out ?? new Float32Array(w * h);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = rgba[o] as number;
    const g = rgba[o + 1] as number;
    const b = rgba[o + 2] as number;
    dst[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return dst;
}

/**
 * Per-row mean equalisation: scale each row of `img` in place so its mean
 * matches the same row's mean in `ref`. Compensates for the left/right
 * exposure difference a ZED reports (e.g. mean 81 vs 108).
 */
export function equalizeRowsToReference(ref: Float32Array, img: Float32Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const rowStart = y * w;
    let sumRef = 0;
    let sumImg = 0;
    for (let x = 0; x < w; x++) {
      sumRef += ref[rowStart + x] as number;
      sumImg += img[rowStart + x] as number;
    }
    const meanRef = sumRef / w;
    const meanImg = sumImg / w;
    if (meanImg < 1e-6) continue;
    const scale = meanRef / meanImg;
    for (let x = 0; x < w; x++) {
      img[rowStart + x] = (img[rowStart + x] as number) * scale;
    }
  }
}

/** 24-bit census transform over a 5x5 window (bit set when neighbour >= centre); border 2px = 0. */
export function census5x5(gray: Float32Array, w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const centre = gray[y * w + x] as number;
      let bits = 0;
      let bit = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const rowBase = (y + dy) * w;
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const v = gray[rowBase + x + dx] as number;
          if (v >= centre) bits |= 1 << bit;
          bit++;
        }
      }
      out[y * w + x] = bits >>> 0;
    }
  }
  return out;
}

function popcount24(x: number): number {
  let v = x - ((x >> 1) & 0x555555);
  v = (v & 0x333333) + ((v >> 2) & 0x333333);
  v = (v + (v >> 4)) & 0x0f0f0f;
  return (v * 0x010101) >> 16;
}

const LARGE_COST = 1e6;

/** Build a (w+1)x(h+1) summed-area table of `src` (w*h). */
function buildIntegral(src: Float32Array, w: number, h: number): Float64Array {
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const srcRow = y * w;
    const dstRow = (y + 1) * iw;
    const prevRow = y * iw;
    for (let x = 0; x < w; x++) {
      rowSum += src[srcRow + x] as number;
      integral[dstRow + x + 1] = (integral[prevRow + x + 1] as number) + rowSum;
    }
  }
  return integral;
}

/** Sum of `src` over the (2r+1)^2 window centred at (x,y), clamped to the image. */
function windowSumFromIntegral(integral: Float64Array, w: number, h: number, x: number, y: number, r: number): number {
  const iw = w + 1;
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(w, x + r + 1);
  const y1 = Math.min(h, y + r + 1);
  const a = integral[y0 * iw + x0] as number;
  const b = integral[y0 * iw + x1] as number;
  const c = integral[y1 * iw + x0] as number;
  const d = integral[y1 * iw + x1] as number;
  return d - b - c + a;
}

export interface MatchCensusOptions {
  maxDisparity: number;
  /** +-rows to search when frames are unrectified; 0 = epipolar rows only. */
  rowSearch?: number;
}

/**
 * For each `ref` pixel, aggregate 5x5-window census Hamming cost against
 * `other` shifted by `dir*d` (dir=-1: other sampled at x-d, i.e. left-ref
 * matching against the right eye; dir=+1: other sampled at x+d, right-ref
 * matching against the left eye), for d in [0, maxDisparity). Returns the
 * winner-take-all disparity with subpixel parabola refinement.
 */
function matchDirection(
  censusRef: Uint32Array,
  censusOther: Uint32Array,
  w: number,
  h: number,
  maxDisparity: number,
  rowSearch: number,
  dir: -1 | 1,
): Float32Array {
  const n = w * h;
  const bestCost = new Float32Array(n).fill(Infinity);
  const bestDisp = new Int16Array(n).fill(-1);
  // Costs at (bestDisp-1) and (bestDisp+1) for the winning disparity, filled in as we sweep d.
  const costBefore = new Float32Array(n).fill(LARGE_COST);
  const costAfter = new Float32Array(n).fill(LARGE_COST);
  let prevAgg: Float32Array | null = null;

  for (let d = 0; d < maxDisparity; d++) {
    const raw = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const rowBase = y * w;
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let ro = -rowSearch; ro <= rowSearch; ro++) {
          const yo = y + ro;
          if (yo < 0 || yo >= h) continue;
          const xo = x + dir * d;
          if (xo < 0 || xo >= w) continue;
          const a = censusRef[rowBase + x] as number;
          const b = censusOther[yo * w + xo] as number;
          const hd = popcount24(a ^ b);
          if (hd < best) best = hd;
        }
        raw[rowBase + x] = best === Infinity ? LARGE_COST : best;
      }
    }
    const integral = buildIntegral(raw, w, h);
    const agg = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        agg[y * w + x] = windowSumFromIntegral(integral, w, h, x, y, 2);
      }
    }

    // Update running winner using agg (current d) and prevAgg (d-1) for anyone whose
    // winner just became prevAgg's disparity (d-1).
    for (let i = 0; i < n; i++) {
      const c = agg[i] as number;
      if (c < (bestCost[i] as number)) {
        bestCost[i] = c;
        bestDisp[i] = d;
        costBefore[i] = prevAgg ? (prevAgg[i] as number) : LARGE_COST;
        costAfter[i] = LARGE_COST; // filled in on the next iteration if this stays the winner
      } else if (bestDisp[i] === d - 1) {
        // The previous disparity is still the winner; record its right neighbour cost.
        costAfter[i] = c;
      }
    }
    prevAgg = agg;
  }

  const disp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = bestDisp[i] as number;
    if (d < 0) {
      disp[i] = 0;
      continue;
    }
    const c0 = costBefore[i] as number;
    const c1 = bestCost[i] as number;
    const c2 = costAfter[i] as number;
    let sub = d;
    if (d > 0 && d < maxDisparity - 1 && c0 < LARGE_COST && c2 < LARGE_COST) {
      const denom = c0 - 2 * c1 + c2;
      if (Math.abs(denom) > 1e-6) {
        let offset = (0.5 * (c0 - c2)) / denom;
        if (offset > 0.5) offset = 0.5;
        else if (offset < -0.5) offset = -0.5;
        sub = d + offset;
      }
    }
    disp[i] = sub;
  }
  return disp;
}

/**
 * Census-window matching in both directions. `dispL[x,y]` is the disparity
 * of the left pixel (right sampled at x-d); `dispR[x,y]` is the disparity of
 * the right pixel (left sampled at x+d), used for the LR consistency check.
 */
export function matchCensus(
  censusL: Uint32Array,
  censusR: Uint32Array,
  w: number,
  h: number,
  opts: MatchCensusOptions,
): { dispL: Float32Array; dispR: Float32Array } {
  const rowSearch = opts.rowSearch ?? 0;
  const dispL = matchDirection(censusL, censusR, w, h, opts.maxDisparity, rowSearch, -1);
  const dispR = matchDirection(censusR, censusL, w, h, opts.maxDisparity, rowSearch, 1);
  return { dispL, dispR };
}

/** Left-right consistency check: 1 where `dispL` agrees with `dispR` within `tol` pixels. */
export function lrCheck(dispL: Float32Array, dispR: Float32Array, w: number, h: number, tol = 1): Uint8Array {
  const valid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dL = dispL[i] as number;
      const xr = Math.round(x - dL);
      if (xr < 0 || xr >= w) continue;
      const dR = dispR[y * w + xr] as number;
      if (Math.abs(dL - dR) <= tol) valid[i] = 1;
    }
  }
  return valid;
}

/** 3x3 median filter over `disp`, using only pixels flagged `valid`; untouched (0) where no valid neighbour exists. */
export function median3x3(disp: Float32Array, valid: Uint8Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const buf: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!valid[i]) continue;
      buf.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (valid[j]) buf.push(disp[j] as number);
        }
      }
      if (buf.length === 0) {
        out[i] = disp[i] as number;
        continue;
      }
      buf.sort((a, b) => a - b);
      out[i] = buf[Math.floor(buf.length / 2)] as number;
    }
  }
  return out;
}

/** Z = fx*B/d (metres); 0 where invalid or d <= 0.5. */
export function disparityToDepth(disp: Float32Array, valid: Uint8Array, fxPx: number, baselineM: number, out: Float32Array): Float32Array {
  const n = Math.min(disp.length, valid.length, out.length);
  for (let i = 0; i < n; i++) {
    const d = disp[i] as number;
    if (!valid[i] || !(d > 0.5)) {
      out[i] = 0;
      continue;
    }
    out[i] = (fxPx * baselineM) / d;
  }
  return out;
}

export interface StereoDepthCpuParams {
  fxPx: number;
  baselineM: number;
  maxDisparity: number;
  /** +-rows to search when unrectified; default 0. */
  rowSearch?: number;
}

export interface StereoDepthCpuResult {
  metric: Float32Array;
  valid: Uint8Array;
  validFraction: number;
}

/** Full CPU stereo pipeline at the frame's native size. */
export function stereoDepthCpu(left: GrabbedFrame, right: Uint8ClampedArray, params: StereoDepthCpuParams): StereoDepthCpuResult {
  const w = left.width;
  const h = left.height;
  const grayL = toGray(left.rgba, w, h);
  const grayR = toGray(right, w, h);
  equalizeRowsToReference(grayL, grayR, w, h);

  const censusL = census5x5(grayL, w, h);
  const censusR = census5x5(grayR, w, h);

  const { dispL, dispR } = matchCensus(censusL, censusR, w, h, {
    maxDisparity: params.maxDisparity,
    rowSearch: params.rowSearch ?? 0,
  });

  const valid = lrCheck(dispL, dispR, w, h, 1);
  const smoothed = median3x3(dispL, valid, w, h);
  const metric = new Float32Array(w * h);
  disparityToDepth(smoothed, valid, params.fxPx, params.baselineM, metric);

  let validCount = 0;
  for (let i = 0; i < valid.length; i++) if (valid[i]) validCount++;

  return { metric, valid, validFraction: validCount / (w * h) };
}

export interface PlaneFillOptions {
  /** Neighbourhood radius (7 -> 15x15). */
  radius?: number;
  /** Minimum valid fraction of the neighbourhood (excluding the centre). */
  minValidFraction?: number;
  /** Largest RMS residual (px) of the neighbours to the fitted plane. */
  maxRmsPx?: number;
  /** Confidence written for filled pixels. */
  confidence?: number;
}

/**
 * CPU reference of the matcher's plane-aware hole fill (stereo-depth.ts FS_FINAL):
 * every invalid pixel (disparity <= 0) whose (2r+1)^2 neighbourhood is at least
 * `minValidFraction` valid gets the value at its centre of the least-squares plane
 * d = a*x + b*y + c through those neighbours, provided they fit it to within
 * `maxRmsPx`. Larger holes and non-planar neighbourhoods stay 0. Returns the
 * filled disparity and per-pixel confidence (1 valid input, `confidence` filled, 0).
 */
export function planeFillDisparity(disp: Float32Array, w: number, h: number, opts: PlaneFillOptions = {}): { disp: Float32Array; confidence: Float32Array } {
  const r = opts.radius ?? 7;
  const minFraction = opts.minValidFraction ?? 0.2;
  const maxRms = opts.maxRmsPx ?? 2;
  const fillConf = opts.confidence ?? 0.4;
  const out = new Float32Array(disp);
  const confidence = new Float32Array(w * h);
  const side = 2 * r + 1;
  const minCount = minFraction * (side * side - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((disp[i] as number) > 0) {
        confidence[i] = 1;
        continue;
      }
      let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sd = 0, Sxd = 0, Syd = 0, Sdd = 0, N = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = disp[yy * w + xx] as number;
          if (!(v > 0)) continue;
          Sxx += dx * dx; Sxy += dx * dy; Syy += dy * dy; Sx += dx; Sy += dy;
          Sd += v; Sxd += dx * v; Syd += dy * v; Sdd += v * v; N += 1;
        }
      }
      if (N < minCount) continue;
      // Solve [Sxx Sxy Sx; Sxy Syy Sy; Sx Sy N] [a b c]^T = [Sxd Syd Sd]^T by Cramer's rule.
      const det = Sxx * (Syy * N - Sy * Sy) - Sxy * (Sxy * N - Sy * Sx) + Sx * (Sxy * Sy - Syy * Sx);
      if (Math.abs(det) < 1e-3) continue;
      const a = (Sxd * (Syy * N - Sy * Sy) - Sxy * (Syd * N - Sy * Sd) + Sx * (Syd * Sy - Syy * Sd)) / det;
      const b = (Sxx * (Syd * N - Sy * Sd) - Sxd * (Sxy * N - Sy * Sx) + Sx * (Sxy * Sd - Syd * Sx)) / det;
      const c = (Sxx * (Syy * Sd - Syd * Sy) - Sxy * (Sxy * Sd - Syd * Sx) + Sxd * (Sxy * Sy - Syy * Sx)) / det;
      const sse = Math.max(0, Sdd - a * Sxd - b * Syd - c * Sd);
      if (Math.sqrt(sse / N) > maxRms) continue;
      if (!(c > 0)) continue;
      out[i] = c;
      confidence[i] = fillConf;
    }
  }
  return { disp: out, confidence };
}
