/**
 * Lightweight in-house sparse optical-flow tracker (NOT full SLAM/VO). Pure
 * TS, no DOM: everything here operates on plain typed arrays so it runs
 * identically under vitest node and in the browser.
 *
 * Pipeline: `toGray` + `downsample2` shrink a `GrabbedFrame` to a small
 * working resolution, `detectCorners` picks a spatially-spread set of
 * trackable points (Shi-Tomasi min-eigenvalue of the Sobel structure
 * tensor), `trackLK` follows them into the next frame with pyramidal
 * Lucas-Kanade, `summarizeFlow` reduces the per-point flow to a single
 * robust summary, and `rotationFromFlow` turns that summary into the small
 * camera rotation that would explain it under a pure-rotation (no
 * parallax) assumption. `FlowTracker` wires those pieces into a per-frame
 * `push()` call for `VisualPoseSource` (./visual.ts).
 *
 * See docs/general-camera/architecture.md ("Pose (visual)" in the model
 * table) and src/camera/contract.ts (PoseSource, GrabbedFrame,
 * CameraIntrinsics).
 */
import type { CameraIntrinsics, GrabbedFrame } from '@/camera/contract';

// ---------------------------------------------------------------------------
// Grayscale + pyramid
// ---------------------------------------------------------------------------

/** Rec. 601 luma, 0..255. `rgba` is row-major, top row first (contract.ts). */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number, out?: Float32Array): Float32Array {
  const n = width * height;
  const dst = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = rgba[o] ?? 0;
    const g = rgba[o + 1] ?? 0;
    const b = rgba[o + 2] ?? 0;
    dst[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return dst;
}

/** 2x2 box downsample. Output is `floor(width/2) x floor(height/2)`. */
export function downsample2(gray: Float32Array, width: number, height: number, out?: Float32Array): Float32Array {
  const outW = Math.max(1, Math.floor(width / 2));
  const outH = Math.max(1, Math.floor(height / 2));
  const n = outW * outH;
  const dst = out && out.length === n ? out : new Float32Array(n);
  for (let y = 0; y < outH; y++) {
    const sy = y * 2;
    for (let x = 0; x < outW; x++) {
      const sx = x * 2;
      const i00 = sy * width + sx;
      const a = gray[i00] ?? 0;
      const b = gray[i00 + 1] ?? 0;
      const c = gray[i00 + width] ?? 0;
      const d = gray[i00 + width + 1] ?? 0;
      dst[y * outW + x] = (a + b + c + d) * 0.25;
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Corner detection (Shi-Tomasi / min-eigenvalue of the structure tensor)
// ---------------------------------------------------------------------------

export interface DetectCornersOptions {
  /** Maximum number of corners to return. Default 150. */
  max?: number;
  /** Pixels to keep clear of every edge (gradients + tracking windows need it). Default 8. */
  border?: number;
  /** Minimum min-eigenvalue response to accept a corner. Default 1 (near-flat regions rejected). */
  minResponse?: number;
  /** Grid cell size (px) used to spread corners across the image. Default 16. */
  cell?: number;
}

/**
 * Shi-Tomasi corners: Sobel gradients, a 3x3-window structure tensor per
 * pixel, and its minimum eigenvalue as the "cornerness" response. One best
 * corner is kept per `cell x cell` grid cell so points spread across the
 * frame instead of clustering on the strongest single edge. Returns a flat
 * `[x0, y0, x1, y1, ...]` array, strongest cells first.
 */
export function detectCorners(
  gray: Float32Array,
  width: number,
  height: number,
  opts: DetectCornersOptions = {},
): Float32Array {
  const max = opts.max ?? 150;
  const border = Math.max(2, opts.border ?? 8);
  const cell = opts.cell ?? 16;
  const minResponse = opts.minResponse ?? 1;

  const ix = new Float32Array(width * height);
  const iy = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = gray[i - width - 1] ?? 0;
      const t = gray[i - width] ?? 0;
      const tr = gray[i - width + 1] ?? 0;
      const l = gray[i - 1] ?? 0;
      const r = gray[i + 1] ?? 0;
      const bl = gray[i + width - 1] ?? 0;
      const b = gray[i + width] ?? 0;
      const br = gray[i + width + 1] ?? 0;
      ix[i] = tr + 2 * r + br - (tl + 2 * l + bl);
      iy[i] = bl + 2 * b + br - (tl + 2 * t + tr);
    }
  }

  const response = new Float32Array(width * height);
  for (let y = border; y < height - border; y++) {
    for (let x = border; x < width - border; x++) {
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (let wy = -1; wy <= 1; wy++) {
        for (let wx = -1; wx <= 1; wx++) {
          const idx = (y + wy) * width + (x + wx);
          const gx = ix[idx] ?? 0;
          const gy = iy[idx] ?? 0;
          sxx += gx * gx;
          sxy += gx * gy;
          syy += gy * gy;
        }
      }
      const trace = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const disc = Math.max(0, (trace * trace) / 4 - det);
      response[y * width + x] = trace / 2 - Math.sqrt(disc);
    }
  }

  const cellsX = Math.max(1, Math.ceil(width / cell));
  const cellsY = Math.max(1, Math.ceil(height / cell));
  const best: { x: number; y: number; response: number }[] = [];
  for (let cy = 0; cy < cellsY; cy++) {
    const y0 = Math.max(border, cy * cell);
    const y1 = Math.min(height - border, (cy + 1) * cell);
    if (y1 <= y0) continue;
    for (let cx = 0; cx < cellsX; cx++) {
      const x0 = Math.max(border, cx * cell);
      const x1 = Math.min(width - border, (cx + 1) * cell);
      if (x1 <= x0) continue;
      let bestX = -1;
      let bestY = -1;
      let bestR = minResponse;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const r = response[y * width + x] ?? 0;
          if (r > bestR) {
            bestR = r;
            bestX = x;
            bestY = y;
          }
        }
      }
      if (bestX >= 0) best.push({ x: bestX, y: bestY, response: bestR });
    }
  }

  best.sort((a, b) => b.response - a.response);
  const count = Math.min(max, best.length);
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const c = best[i]!;
    out[i * 2] = c.x;
    out[i * 2 + 1] = c.y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pyramidal Lucas-Kanade
// ---------------------------------------------------------------------------

/** Bilinear sample, clamped to the image edge (so windows near the border still sample something). */
function sampleBilinear(img: Float32Array, width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = Math.min(Math.max(x0, 0), width - 1);
  const cx1 = Math.min(Math.max(x0 + 1, 0), width - 1);
  const cy0 = Math.min(Math.max(y0, 0), height - 1);
  const cy1 = Math.min(Math.max(y0 + 1, 0), height - 1);
  const v00 = img[cy0 * width + cx0] ?? 0;
  const v10 = img[cy0 * width + cx1] ?? 0;
  const v01 = img[cy1 * width + cx0] ?? 0;
  const v11 = img[cy1 * width + cx1] ?? 0;
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

interface PyramidLevel {
  data: Float32Array;
  width: number;
  height: number;
}

function buildPyramid(gray: Float32Array, width: number, height: number, levels: number): PyramidLevel[] {
  const pyr: PyramidLevel[] = [{ data: gray, width, height }];
  let w = width;
  let h = height;
  let src = gray;
  for (let l = 1; l < levels; l++) {
    const dst = downsample2(src, w, h);
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
    pyr.push({ data: dst, width: w, height: h });
    src = dst;
  }
  return pyr;
}

interface LkResult {
  ok: boolean;
  dx: number;
  dy: number;
}

/** One pyramid level of Newton iterations for a single point (forward-additive KLT). */
function iterateLK(
  I: Float32Array,
  J: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  dx0: number,
  dy0: number,
  half: number,
  iterations: number,
): LkResult {
  const margin = half + 1;
  if (cx < margin || cx > width - 1 - margin || cy < margin || cy > height - 1 - margin) {
    return { ok: false, dx: dx0, dy: dy0 };
  }

  let dx = dx0;
  let dy = dy0;
  for (let iter = 0; iter < iterations; iter++) {
    const wx = cx + dx;
    const wy = cy + dy;
    if (wx < margin || wx > width - 1 - margin || wy < margin || wy > height - 1 - margin) {
      return { ok: false, dx, dy };
    }

    let gxx = 0;
    let gxy = 0;
    let gyy = 0;
    let bx = 0;
    let by = 0;
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        const ixp = cx + ox;
        const iyp = cy + oy;
        const gx = (sampleBilinear(I, width, height, ixp + 1, iyp) - sampleBilinear(I, width, height, ixp - 1, iyp)) * 0.5;
        const gy = (sampleBilinear(I, width, height, ixp, iyp + 1) - sampleBilinear(I, width, height, ixp, iyp - 1)) * 0.5;
        const iVal = sampleBilinear(I, width, height, ixp, iyp);
        const jVal = sampleBilinear(J, width, height, wx + ox, wy + oy);
        const diff = iVal - jVal;
        gxx += gx * gx;
        gxy += gx * gy;
        gyy += gy * gy;
        bx += gx * diff;
        by += gy * diff;
      }
    }

    const det = gxx * gyy - gxy * gxy;
    if (Math.abs(det) < 1e-6) return { ok: false, dx, dy };
    const ddx = (gyy * bx - gxy * by) / det;
    const ddy = (gxx * by - gxy * bx) / det;
    dx += ddx;
    dy += ddy;
    if (Math.abs(ddx) < 0.01 && Math.abs(ddy) < 0.01) break;
  }

  const wx = cx + dx;
  const wy = cy + dy;
  if (wx < margin || wx > width - 1 - margin || wy < margin || wy > height - 1 - margin) {
    return { ok: false, dx, dy };
  }

  let residual = 0;
  let count = 0;
  for (let oy = -half; oy <= half; oy++) {
    for (let ox = -half; ox <= half; ox++) {
      const iVal = sampleBilinear(I, width, height, cx + ox, cy + oy);
      const jVal = sampleBilinear(J, width, height, wx + ox, wy + oy);
      residual += Math.abs(iVal - jVal);
      count++;
    }
  }
  const meanResidual = count > 0 ? residual / count : 0;
  if (meanResidual > 25) return { ok: false, dx, dy };
  return { ok: true, dx, dy };
}

export interface TrackLkOptions {
  /** Window side length (odd; half-size 3 -> 7). Default 7. */
  window?: number;
  /** Newton iterations per pyramid level. Default 10. */
  iterations?: number;
  /** Pyramid levels, coarsest-to-finest (1 = no pyramid). Default 2. */
  pyramidLevels?: number;
}

/**
 * Pyramidal Lucas-Kanade: tracks `points` (flat `[x0,y0,x1,y1,...]`, `prev`
 * image coordinates) into `next`. Points that leave the image or whose
 * final patch residual is too high to trust get `status[i] = 0`.
 */
export function trackLK(
  prev: Float32Array,
  next: Float32Array,
  width: number,
  height: number,
  points: Float32Array,
  opts: TrackLkOptions = {},
): { flow: Float32Array; status: Uint8Array } {
  const half = Math.max(1, Math.floor((opts.window ?? 7) / 2));
  const iterations = opts.iterations ?? 10;
  const levels = Math.max(1, opts.pyramidLevels ?? 2);

  const prevPyr = buildPyramid(prev, width, height, levels);
  const nextPyr = buildPyramid(next, width, height, levels);

  const n = Math.floor(points.length / 2);
  const flow = new Float32Array(n * 2);
  const status = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const px = points[i * 2] ?? 0;
    const py = points[i * 2 + 1] ?? 0;
    let dx = 0;
    let dy = 0;
    let ok = true;

    for (let level = levels - 1; level >= 0; level--) {
      const scale = 2 ** level;
      const lp = prevPyr[level]!;
      const ln = nextPyr[level]!;
      const cx = px / scale;
      const cy = py / scale;
      dx *= 2;
      dy *= 2;

      const result = iterateLK(lp.data, ln.data, lp.width, lp.height, cx, cy, dx, dy, half, iterations);
      if (!result.ok) {
        ok = false;
        break;
      }
      dx = result.dx;
      dy = result.dy;
    }

    if (ok) {
      flow[i * 2] = dx;
      flow[i * 2 + 1] = dy;
      status[i] = 1;
    } else {
      flow[i * 2] = 0;
      flow[i * 2 + 1] = 0;
      status[i] = 0;
    }
  }

  return { flow, status };
}

// ---------------------------------------------------------------------------
// Flow summary + rotation estimate
// ---------------------------------------------------------------------------

export interface FlowSummary {
  tracked: number;
  total: number;
  /** Robust (median) horizontal flow, px. */
  meanDx: number;
  /** Robust (median) vertical flow, px. */
  meanDy: number;
  medianMagnitudePx: number;
  /** Fraction of tracked points within 2 px of the robust mean (pure-rotation / static-scene fit). */
  coherence: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return sorted[mid] ?? 0;
}

/**
 * Reduces per-point flow to a single robust summary. `meanDx`/`meanDy` are
 * medians (robust to the odd mistracked point), not arithmetic means.
 */
export function summarizeFlow(flow: Float32Array, status: Uint8Array): FlowSummary {
  const total = status.length;
  const dxs: number[] = [];
  const dys: number[] = [];
  for (let i = 0; i < total; i++) {
    if (status[i] === 1) {
      dxs.push(flow[i * 2] ?? 0);
      dys.push(flow[i * 2 + 1] ?? 0);
    }
  }
  const tracked = dxs.length;
  if (tracked === 0) {
    return { tracked: 0, total, meanDx: 0, meanDy: 0, medianMagnitudePx: 0, coherence: 0 };
  }

  const meanDx = median(dxs);
  const meanDy = median(dys);

  const mags: number[] = [];
  let coherentCount = 0;
  for (let i = 0; i < tracked; i++) {
    const dx = dxs[i]!;
    const dy = dys[i]!;
    mags.push(Math.hypot(dx, dy));
    if (Math.hypot(dx - meanDx, dy - meanDy) <= 2) coherentCount++;
  }

  return {
    tracked,
    total,
    meanDx,
    meanDy,
    medianMagnitudePx: median(mags),
    coherence: coherentCount / tracked,
  };
}

/**
 * Small-angle, pure-rotation camera-rotation estimate from a flow summary.
 * `focalPx = (height / 2) / tan(fovY / 2)` at the *processed* (working)
 * resolution the flow was measured at.
 *
 * Sign convention (verified numerically against the pinhole model in
 * src/capture/geom.ts's `projectPoint`, which this file's tests reproduce):
 * the camera looks down local -Z with +Y up, and pixel y = 0 is the top
 * row. Rotating the camera by `quatFromAxisAngle({x:0,y:1,z:0}, yawRad)`
 * (the *same* yaw convention `StaticPoseSource`/`OrientationPoseSource`
 * use) turns the heading from -Z towards -X; projecting a fixed world
 * point through `projectPoint` before and after that rotation shows the
 * point's pixel x increases by `yawRad * focalPx` (to first order). So
 * recovering `yawRad` from measured flow is `meanDx / focalPx`, with *no*
 * extra sign flip - the codebase's own positive-yaw direction already
 * matches "content moves right on screen". Concretely this means a real
 * rightward pan of the camera (heading swinging towards +X) is a
 * *negative* `yawRad` here and produces *leftward* flow (negative
 * `meanDx`), which is the physically-intuitive "pan right, world slides
 * left" relationship - it just isn't literally `yawRad = -meanDx/focalPx`
 * once you plug the result back into `quatFromAxisAngle(+Y, yawRad)` the
 * way `VisualPoseSource` does. The same derivation for pitch (rotation
 * about local +X, positive = look up, matching `StaticPoseSource`'s "more
 * negative pitch looks down") gives `pitchRad = meanDy / focalPx` with no
 * sign flip either. Both are exercised in tests/unit/camera-flow.test.ts.
 */
export function rotationFromFlow(summary: FlowSummary, focalPx: number): { yawRad: number; pitchRad: number } {
  if (!(focalPx > 0)) return { yawRad: 0, pitchRad: 0 };
  return {
    yawRad: summary.meanDx / focalPx,
    pitchRad: summary.meanDy / focalPx,
  };
}

// ---------------------------------------------------------------------------
// FlowTracker: per-frame wiring for VisualPoseSource
// ---------------------------------------------------------------------------

export interface FlowTrackerOptions {
  /** Downsample the grabbed frame until its width is <= this. Default 160. */
  workWidth?: number;
}

/**
 * Stateful per-frame tracker: converts each pushed `GrabbedFrame` to gray,
 * downsamples to a small working resolution, tracks the previous frame's
 * corners into it, and re-detects corners on every frame (simpler and more
 * robust than trying to keep a track alive across many frames at 5-10 Hz).
 * The two working-resolution grayscale buffers are reused (ping-ponged)
 * across pushes; only the small per-frame corner/flow/status arrays
 * allocate fresh (bounded by `opts.max` corners, negligible).
 */
export class FlowTracker {
  private readonly workWidth: number;

  private grayScratch: Float32Array | undefined;
  private readonly levelScratch: Float32Array[] = [];

  private bufA: Float32Array | undefined;
  private bufB: Float32Array | undefined;
  private useA = true;
  private haveWork = false;

  private prevCorners: Float32Array | null = null;

  /** Focal length in pixels at the current working resolution. */
  focalPx = 0;
  /** Rotation estimate from the most recent successful `push`, or null. */
  lastRotation: { yawRad: number; pitchRad: number } | null = null;

  constructor(opts: FlowTrackerOptions = {}) {
    this.workWidth = opts.workWidth ?? 160;
  }

  /** Returns null on the first frame (nothing to track against yet). */
  push(frame: GrabbedFrame, intrinsics: CameraIntrinsics): FlowSummary | null {
    const { width, height, rgba } = frame;

    if (!this.grayScratch || this.grayScratch.length !== width * height) {
      this.grayScratch = new Float32Array(width * height);
    }
    let src = toGray(rgba, width, height, this.grayScratch);
    let w = width;
    let h = height;
    let level = 0;
    while (w > this.workWidth) {
      const outW = Math.max(1, Math.floor(w / 2));
      const outH = Math.max(1, Math.floor(h / 2));
      let buf = this.levelScratch[level];
      if (!buf || buf.length !== outW * outH) {
        buf = new Float32Array(outW * outH);
        this.levelScratch[level] = buf;
      }
      downsample2(src, w, h, buf);
      src = buf;
      w = outW;
      h = outH;
      level++;
    }

    if (!this.bufA || this.bufA.length !== w * h) {
      this.bufA = new Float32Array(w * h);
      this.bufB = new Float32Array(w * h);
      this.haveWork = false;
    }

    this.focalPx = h / 2 / Math.tan(intrinsics.fovY / 2);

    const dst = this.useA ? this.bufA : this.bufB!;
    dst.set(src);
    const prev = this.useA ? this.bufB! : this.bufA;
    this.useA = !this.useA;

    if (!this.haveWork) {
      this.haveWork = true;
      this.prevCorners = detectCorners(dst, w, h);
      this.lastRotation = null;
      return null;
    }

    const points = this.prevCorners ?? new Float32Array(0);
    const { flow, status } = trackLK(prev!, dst, w, h, points);
    const summary = summarizeFlow(flow, status);
    this.lastRotation = rotationFromFlow(summary, this.focalPx);
    this.prevCorners = detectCorners(dst, w, h);
    return summary;
  }
}
