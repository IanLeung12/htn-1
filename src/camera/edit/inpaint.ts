/**
 * Screen-space inpainting of one object's silhouette for the static-camera
 * SYNTHETIC delete path (general-camera backend, docs/general-camera/STATE.md
 * "Synthetic delete"). The truthful delete path composites a CLEAN-PLATE
 * frame - the desk as it really looked with the object physically removed -
 * into the object's tracked silhouette (`./eraser.ts`). When no such frame
 * exists (the user never took the object away and pressed Capture plate),
 * this module fabricates one: it copies the most recent frame that still
 * shows the object at its original spot and fills the pixels inside its
 * (slightly dilated) silhouette from the ring of observed pixels just
 * outside it - every masked pixel takes the colour of its nearest ring
 * pixel, then a small box blur inside the fill hides the seams.
 *
 * This is the 2D counterpart of `../synthetic-plate.ts` (which inpaints a
 * support-plane texture in world space): same "nearest donor from the
 * ring" idea, but on the frame's own pixel grid, because with a static
 * camera "what is behind the object" is exactly where its silhouette sits.
 * The result is honestly marked `synthetic: true` (`CameraFrame`) and looks
 * approximate: flat surfaces (desk, wall) fill convincingly, anything with
 * texture or a background edge crossing behind the object smears.
 *
 * Pure TS/typed arrays; no three.js, unit-testable without a renderer.
 * Nearest-donor lookup is a two-pass (Danielsson-style) propagation of the
 * nearest seed over the local bbox, so a 320x180 frame with a 60x80 mask
 * takes a few milliseconds (see tests/unit/camera-inpaint.test.ts).
 */
import type { CameraFrame } from '@/capture/contract';
import type { SilhouetteMask } from './silhouette';

/** Mask dilation (px) before filling: the tracked mask's feathered edge still shows a rim of the object. */
export const INPAINT_DILATE_PX = 2;

/** Mask alpha above which a pixel counts as inside the object. */
const INSIDE_ALPHA = 32;

/**
 * Smallest fraction of ring pixels that must be observed (inside the frame)
 * for a synthetic fill to be worth a delete: below this the object sits on
 * the frame edge and there is nothing plausible to copy from. Also the
 * `synthetic_completion` delete coverage floor the camera app hands the
 * resolver (`src/camera/app.ts`).
 */
export const SYNTHETIC_DELETE_MIN_DONOR_FRACTION = 0.02;

export interface InpaintResult {
  frame: CameraFrame;
  /** Pixels written inside the (dilated) mask. */
  filledPx: number;
  /** Ring pixels that were inside the frame (usable donors). */
  donorPx: number;
  /** Ring pixels the frame could have provided (including off-frame ones). */
  ringPx: number;
  /** `donorPx / ringPx` (0 when the mask has no ring). */
  donorFraction: number;
}

interface Grid {
  width: number;
  height: number;
}

/**
 * Returns a copy of `frame` whose pixels inside `mask` (dilated by
 * `INPAINT_DILATE_PX`) are filled from the `ringPx`-wide ring of observed
 * pixels just outside it. `mask` is expressed in `grid`'s pixel grid (the
 * depth map it was tracked in, see `cutoutFromMask`); it defaults to the
 * frame's own resolution. The copy carries `synthetic: true`.
 */
export function inpaintMask(frame: CameraFrame, mask: SilhouetteMask, ringPx = 6, grid?: Grid): CameraFrame {
  return inpaintMaskDetailed(frame, mask, ringPx, grid).frame;
}

export function inpaintMaskDetailed(frame: CameraFrame, mask: SilhouetteMask, ringPx = 6, grid?: Grid): InpaintResult {
  const gridW = grid?.width ?? frame.width;
  const gridH = grid?.height ?? frame.height;
  const rgba = new Uint8ClampedArray(frame.rgba);
  const out: CameraFrame = { ...frame, rgba, synthetic: true };
  const empty: InpaintResult = { frame: out, filledPx: 0, donorPx: 0, ringPx: 0, donorFraction: 0 };
  if (gridW <= 0 || gridH <= 0 || mask.width <= 0 || mask.height <= 0 || frame.width <= 0 || frame.height <= 0) return empty;

  const ring = Math.max(1, Math.round(ringPx));
  const dilate = INPAINT_DILATE_PX;
  const sx = frame.width / gridW;
  const sy = frame.height / gridH;

  // Working window in frame pixels: the mask bbox scaled to the frame, plus the dilation and
  // ring. May extend past the frame (so off-frame ring pixels count as missing donors); the
  // pixel loops clamp reads/writes to the frame.
  const bx0 = Math.floor(mask.x0 * sx) - dilate - ring;
  const by0 = Math.floor(mask.y0 * sy) - dilate - ring;
  const bx1 = Math.ceil((mask.x0 + mask.width) * sx) + dilate + ring; // exclusive
  const by1 = Math.ceil((mask.y0 + mask.height) * sy) + dilate + ring;
  const w = bx1 - bx0;
  const h = by1 - by0;
  if (w <= 0 || h <= 0) return empty;

  // 1. Inside map: mask alpha sampled (nearest) at each window pixel's grid position.
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.floor((by0 + y) / sy) - mask.y0;
    if (gy < 0 || gy >= mask.height) continue;
    for (let x = 0; x < w; x++) {
      const gx = Math.floor((bx0 + x) / sx) - mask.x0;
      if (gx < 0 || gx >= mask.width) continue;
      if ((mask.alpha[gy * mask.width + gx] ?? 0) > INSIDE_ALPHA) inside[y * w + x] = 1;
    }
  }

  // 2. Dilate by `dilate` px (separable square max), then the ring is a further `ring` px.
  const dilated = dilateSquare(inside, w, h, dilate);
  const ringMask = dilateSquare(dilated, w, h, ring);

  // 3. Seeds = ring pixels (outside the dilated mask) that lie inside the frame.
  const seedX = new Int32Array(w * h).fill(-1);
  const seedY = new Int32Array(w * h).fill(-1);
  let ringPxCount = 0;
  let donorPx = 0;
  for (let y = 0; y < h; y++) {
    const fy = by0 + y;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ringMask[i] || dilated[i]) continue;
      ringPxCount += 1;
      const fx = bx0 + x;
      if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) continue;
      donorPx += 1;
      seedX[i] = x;
      seedY[i] = y;
    }
  }
  const donorFraction = ringPxCount > 0 ? donorPx / ringPxCount : 0;
  if (donorPx === 0) return { frame: out, filledPx: 0, donorPx, ringPx: ringPxCount, donorFraction };

  // 4. Propagate the nearest seed to every window pixel: two raster passes with 4 causal
  // neighbours each (Danielsson-style; near-exact Euclidean for our small windows).
  propagate(seedX, seedY, w, h, true);
  propagate(seedX, seedY, w, h, false);

  // 5. Fill: every dilated-mask pixel inside the frame takes its nearest donor's colour.
  const filled = new Uint8Array(w * h);
  let filledPx = 0;
  for (let y = 0; y < h; y++) {
    const fy = by0 + y;
    if (fy < 0 || fy >= frame.height) continue;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!dilated[i]) continue;
      const fx = bx0 + x;
      if (fx < 0 || fx >= frame.width) continue;
      const dx = seedX[i] ?? -1;
      const dy = seedY[i] ?? -1;
      if (dx < 0 || dy < 0) continue;
      const src = ((by0 + dy) * frame.width + (bx0 + dx)) * 4;
      const dst = (fy * frame.width + fx) * 4;
      rgba[dst] = frame.rgba[src] ?? 0;
      rgba[dst + 1] = frame.rgba[src + 1] ?? 0;
      rgba[dst + 2] = frame.rgba[src + 2] ?? 0;
      rgba[dst + 3] = 255;
      filled[i] = 1;
      filledPx += 1;
    }
  }

  // 6. 3x3 box blur over the filled pixels (reading the pre-blur fill plus the observed ring)
  // to soften the Voronoi seams between donor cells.
  const pre = new Uint8ClampedArray(rgba);
  for (let y = 0; y < h; y++) {
    const fy = by0 + y;
    for (let x = 0; x < w; x++) {
      if (!filled[y * w + x]) continue;
      const fx = bx0 + x;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const py = fy + oy;
        if (py < 0 || py >= frame.height) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const px = fx + ox;
          if (px < 0 || px >= frame.width) continue;
          const k = (py * frame.width + px) * 4;
          r += pre[k] ?? 0;
          g += pre[k + 1] ?? 0;
          b += pre[k + 2] ?? 0;
          n += 1;
        }
      }
      if (n === 0) continue;
      const dst = (fy * frame.width + fx) * 4;
      rgba[dst] = Math.round(r / n);
      rgba[dst + 1] = Math.round(g / n);
      rgba[dst + 2] = Math.round(b / n);
    }
  }

  return { frame: out, filledPx, donorPx, ringPx: ringPxCount, donorFraction };
}

/** Binary dilation by a `radius` px square (Chebyshev), separable: rows then columns. */
function dilateSquare(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return src.slice();
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!src[row + x]) continue;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      for (let k = x0; k <= x1; k++) tmp[row + k] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue;
      for (let k = y0; k <= y1; k++) out[k * w + x] = 1;
    }
  }
  return out;
}

/**
 * One raster pass of nearest-seed propagation. Forward: top-left to
 * bottom-right, pulling from the left, upper-left, upper and upper-right
 * neighbours; backward: the mirror. Each pixel keeps whichever known seed
 * is closest (squared Euclidean distance).
 */
function propagate(seedX: Int32Array, seedY: Int32Array, w: number, h: number, forward: boolean): void {
  const offsets: [number, number][] = forward
    ? [[-1, 0], [-1, -1], [0, -1], [1, -1]]
    : [[1, 0], [1, 1], [0, 1], [-1, 1]];
  const yStart = forward ? 0 : h - 1;
  const yEnd = forward ? h : -1;
  const step = forward ? 1 : -1;
  for (let y = yStart; y !== yEnd; y += step) {
    const xStart = forward ? 0 : w - 1;
    const xEnd = forward ? w : -1;
    for (let x = xStart; x !== xEnd; x += step) {
      const i = y * w + x;
      let bx = seedX[i] ?? -1;
      let by = seedY[i] ?? -1;
      let best = bx >= 0 ? (x - bx) * (x - bx) + (y - by) * (y - by) : Infinity;
      for (const [ox, oy] of offsets) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const cx = seedX[j] ?? -1;
        if (cx < 0) continue;
        const cy = seedY[j] ?? -1;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < best) {
          best = d;
          bx = cx;
          by = cy;
        }
      }
      seedX[i] = bx;
      seedY[i] = by;
    }
  }
}
