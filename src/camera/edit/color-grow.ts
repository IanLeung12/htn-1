/**
 * Colour-grown silhouette (general-camera backend, see docs/general-camera/
 * STATE.md "Colour-grown silhouettes").
 *
 * Stereo depth is sparse on shiny cans, matte black controllers and fabric,
 * so the depth-only silhouette (`./silhouette.ts`) often covers only a
 * fraction of the object and Delete/impostor cutouts show a patch. This
 * module grows that sparse depth mask through the RGB frame: a 4-neighbour
 * BFS from every confident seed pixel into neighbours whose colour is close
 * both to the pixel it came from and to the running mean colour of the
 * region. Colour distance is measured in a lightness-desensitised space
 * (r-g, g-b, 0.4*mean(r,g,b)) so shading across a curved can is tolerated
 * while a hue change (can -> desk) is not. Growth is bounded by a pixel
 * radius around the seed bbox, by depth (a valid depth more than 0.2 m from
 * the blob depth is background of a similar colour), and by a visit budget.
 *
 * Pure TS/typed arrays; unit-tested in tests/unit/camera-color-grow.test.ts.
 */
import { feather, type SilhouetteMask } from './silhouette';

export interface ColorGrowOptions {
  /** Colour distance tolerance (see module doc for the space). Default 26. */
  colorTolerance?: number;
  /** Max growth (frame px) beyond the seed bbox. Default 2.5x the bbox's larger side, capped at 140. */
  maxGrowPx?: number;
  /** Depth disagreement (m) with `seed.blobDepthM` that blocks a pixel. Default 0.2. */
  depthToleranceM?: number;
  /** Hard cap on BFS visits. Default 60000. */
  maxVisits?: number;
  /** Feather radius (px) applied to the grown mask. Default 2. */
  featherPx?: number;
  /** Size of the grid `seed` and `depth` are in; defaults to the frame size. */
  depthWidth?: number;
  depthHeight?: number;
  /** Seed alpha at or above which a pixel seeds the fill. Default 128. */
  seedAlphaMin?: number;
}

const DEFAULT_TOLERANCE = 26;
const DEFAULT_MAX_GROW_CAP = 140;
const DEFAULT_DEPTH_TOLERANCE_M = 0.2;
const DEFAULT_MAX_VISITS = 60_000;
const DEFAULT_FEATHER_PX = 2;
const LIGHTNESS_WEIGHT = 0.4;

/** Squared distance of the rgba pixel at byte index `i` from the point (c0, c1, c2) in the lightness-desensitised space. */
function colorDist2(rgba: Uint8ClampedArray, i: number, c0: number, c1: number, c2: number): number {
  const r = rgba[i] as number;
  const g = rgba[i + 1] as number;
  const b = rgba[i + 2] as number;
  const d0 = r - g - c0;
  const d1 = g - b - c1;
  const d2 = (LIGHTNESS_WEIGHT * (r + g + b)) / 3 - c2;
  return d0 * d0 + d1 * d1 + d2 * d2;
}

/**
 * Grows `seed` (a depth-only silhouette in the depth grid) through the RGB
 * frame by colour; returns a new bbox-cropped mask in the depth grid with
 * the same `blobDepthM`. Seed alpha is kept (max with the grown alpha).
 * `width`/`height` are the frame's; the depth grid size comes from
 * `opts.depthWidth/depthHeight` (default: same as the frame).
 */
export function growMaskByColor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  seed: SilhouetteMask,
  depth: Float32Array | undefined,
  opts?: ColorGrowOptions,
): SilhouetteMask {
  const tol = opts?.colorTolerance ?? DEFAULT_TOLERANCE;
  const tol2 = tol * tol;
  const depthTol = opts?.depthToleranceM ?? DEFAULT_DEPTH_TOLERANCE_M;
  const maxVisits = opts?.maxVisits ?? DEFAULT_MAX_VISITS;
  const featherPx = opts?.featherPx ?? DEFAULT_FEATHER_PX;
  const seedAlphaMin = opts?.seedAlphaMin ?? 128;
  const gridW = opts?.depthWidth ?? width;
  const gridH = opts?.depthHeight ?? height;
  const sameGrid = gridW === width && gridH === height;
  // Frame px per grid px.
  const sx = width / gridW;
  const sy = height / gridH;

  // Seed bbox in frame px.
  const fx0 = Math.max(0, Math.floor(seed.x0 * sx));
  const fy0 = Math.max(0, Math.floor(seed.y0 * sy));
  const fx1 = Math.min(width, Math.ceil((seed.x0 + seed.width) * sx));
  const fy1 = Math.min(height, Math.ceil((seed.y0 + seed.height) * sy));
  const maxGrow = opts?.maxGrowPx ?? Math.min(DEFAULT_MAX_GROW_CAP, 2.5 * Math.max(fx1 - fx0, fy1 - fy0));
  // Search window in frame px.
  const wx0 = Math.max(0, Math.floor(fx0 - maxGrow));
  const wy0 = Math.max(0, Math.floor(fy0 - maxGrow));
  const wx1 = Math.min(width, Math.ceil(fx1 + maxGrow));
  const wy1 = Math.min(height, Math.ceil(fy1 + maxGrow));
  const ww = Math.max(0, wx1 - wx0);
  const wh = Math.max(0, wy1 - wy0);

  const inMask = new Uint8Array(ww * wh); // 1 = seed or grown, window coords
  const queue = new Int32Array(ww * wh);
  let head = 0;
  let tail = 0;
  let sum0 = 0;
  let sum1 = 0;
  let sum2 = 0;
  let count = 0;

  const accept = (wi: number, fi: number): void => {
    inMask[wi] = 1;
    queue[tail++] = wi;
    const r = rgba[fi] as number;
    const g = rgba[fi + 1] as number;
    const b = rgba[fi + 2] as number;
    sum0 += r - g;
    sum1 += g - b;
    sum2 += (LIGHTNESS_WEIGHT * (r + g + b)) / 3;
    count += 1;
  };

  // Seed: every confident seed pixel, mapped to frame px.
  for (let gy = 0; gy < seed.height; gy++) {
    for (let gx = 0; gx < seed.width; gx++) {
      if ((seed.alpha[gy * seed.width + gx] as number) < seedAlphaMin) continue;
      const px = sameGrid ? seed.x0 + gx : Math.floor((seed.x0 + gx + 0.5) * sx);
      const py = sameGrid ? seed.y0 + gy : Math.floor((seed.y0 + gy + 0.5) * sy);
      if (px < wx0 || px >= wx1 || py < wy0 || py >= wy1) continue;
      const wi = (py - wy0) * ww + (px - wx0);
      if (inMask[wi]) continue;
      accept(wi, (py * width + px) * 4);
    }
  }

  const depthAt = (px: number, py: number): number => {
    if (!depth) return 0;
    const gx = sameGrid ? px : Math.min(gridW - 1, Math.floor(px / sx));
    const gy = sameGrid ? py : Math.min(gridH - 1, Math.floor(py / sy));
    return depth[gy * gridW + gx] ?? 0;
  };

  let visits = 0;
  while (head < tail && visits < maxVisits) {
    const wi = queue[head++] as number;
    visits += 1;
    const wx = wi % ww;
    const wy = (wi - wx) / ww;
    const px = wx + wx0;
    const py = wy + wy0;
    const fi = (py * width + px) * 4;
    const r = rgba[fi] as number;
    const g = rgba[fi + 1] as number;
    const b = rgba[fi + 2] as number;
    const from0 = r - g;
    const from1 = g - b;
    const from2 = (LIGHTNESS_WEIGHT * (r + g + b)) / 3;
    const mean0 = sum0 / count;
    const mean1 = sum1 / count;
    const mean2 = sum2 / count;

    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? px - 1 : k === 1 ? px + 1 : px;
      const ny = k === 2 ? py - 1 : k === 3 ? py + 1 : py;
      if (nx < wx0 || nx >= wx1 || ny < wy0 || ny >= wy1) continue;
      const nwi = (ny - wy0) * ww + (nx - wx0);
      if (inMask[nwi]) continue;
      // Bound: at most maxGrow px outside the seed bbox (per axis).
      const dxOut = nx < fx0 ? fx0 - nx : nx >= fx1 ? nx - fx1 + 1 : 0;
      const dyOut = ny < fy0 ? fy0 - ny : ny >= fy1 ? ny - fy1 + 1 : 0;
      if (dxOut > maxGrow || dyOut > maxGrow) continue;
      const nfi = (ny * width + nx) * 4;
      if (colorDist2(rgba, nfi, from0, from1, from2) > tol2) continue;
      if (colorDist2(rgba, nfi, mean0, mean1, mean2) > tol2) continue;
      const d = depthAt(nx, ny);
      if (d > 0 && Math.abs(d - seed.blobDepthM) > depthTol) continue;
      accept(nwi, nfi);
    }
  }

  // Crop to the grown bbox (window coords).
  let bx0 = ww;
  let by0 = wh;
  let bx1 = -1;
  let by1 = -1;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      if (!inMask[y * ww + x]) continue;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  if (bx1 < 0) {
    // Nothing seeded (all seed alpha below threshold): return the seed unchanged.
    return { ...seed, alpha: new Uint8ClampedArray(seed.alpha) };
  }
  // Leave room for the feather ramp.
  bx0 = Math.max(0, bx0 - featherPx);
  by0 = Math.max(0, by0 - featherPx);
  bx1 = Math.min(ww - 1, bx1 + featherPx);
  by1 = Math.min(wh - 1, by1 + featherPx);
  const cw = bx1 - bx0 + 1;
  const ch = by1 - by0 + 1;
  const binary = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) binary[y * cw + x] = inMask[(y + by0) * ww + (x + bx0)] as number;
  }
  const alphaFrame = feather(binary, cw, ch, featherPx);
  // Frame-space bbox origin.
  const ox = wx0 + bx0;
  const oy = wy0 + by0;

  // Result in the depth grid: identical to frame space when the grids match, else nearest-sample.
  let gx0: number;
  let gy0: number;
  let gw: number;
  let gh: number;
  let alpha: Uint8ClampedArray;
  if (sameGrid) {
    gx0 = ox;
    gy0 = oy;
    gw = cw;
    gh = ch;
    alpha = alphaFrame;
  } else {
    gx0 = Math.max(0, Math.floor(ox / sx));
    gy0 = Math.max(0, Math.floor(oy / sy));
    const gx1 = Math.min(gridW, Math.ceil((ox + cw) / sx));
    const gy1 = Math.min(gridH, Math.ceil((oy + ch) / sy));
    gw = Math.max(1, gx1 - gx0);
    gh = Math.max(1, gy1 - gy0);
    alpha = new Uint8ClampedArray(gw * gh);
    for (let y = 0; y < gh; y++) {
      const fy = Math.min(ch - 1, Math.max(0, Math.floor((gy0 + y + 0.5) * sy) - oy));
      for (let x = 0; x < gw; x++) {
        const fx = Math.min(cw - 1, Math.max(0, Math.floor((gx0 + x + 0.5) * sx) - ox));
        alpha[y * gw + x] = alphaFrame[fy * cw + fx] as number;
      }
    }
  }

  // Keep the seed's own alpha (max) where the two masks overlap.
  for (let y = 0; y < seed.height; y++) {
    const gy = seed.y0 + y - gy0;
    if (gy < 0 || gy >= gh) continue;
    for (let x = 0; x < seed.width; x++) {
      const gx = seed.x0 + x - gx0;
      if (gx < 0 || gx >= gw) continue;
      const a = seed.alpha[y * seed.width + x] as number;
      const i = gy * gw + gx;
      if (a > (alpha[i] as number)) alpha[i] = a;
    }
  }

  return { x0: gx0, y0: gy0, width: gw, height: gh, alpha, blobDepthM: seed.blobDepthM };
}
