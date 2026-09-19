/**
 * Per-object silhouette mask for real-object editing quality (general-camera
 * backend, see docs/general-camera/architecture.md and STATE.md "Multi-frame
 * appearance"/"Delete with a static camera" next steps).
 *
 * The moved-object impostor (`src/camera/impostor.ts`) and the static-camera
 * eraser (`./eraser.ts`) both need to know exactly WHICH pixels of a captured
 * frame belong to a discovered object, not just its axis-aligned occlusion
 * box projected into that frame (a box always includes background corners).
 * This module computes that per-pixel mask from a depth map: pixels inside
 * the object's occlusion box footprint AND within `depthToleranceM` (default
 * 8 cm) of the object's own ("blob") depth are kept, then dilated 2 px
 * (closes small depth-noise holes) and feathered 3 px (soft alpha edge, so
 * composited cutouts don't have a hard aliased boundary).
 *
 * Pure TS/typed-array math; no three.js dependency, so it is unit-testable
 * without a renderer.
 */
import type { EditableObject, Pose, Vec3 } from '@/core/types';
import { add } from '@/core/math';
import { inFrame, projectPoint } from '@/capture/geom';

/** Minimal shape both `DepthMap` (src/camera/contract.ts) and `CameraFrame`
 * (src/capture/contract.ts, when it carries depth) satisfy. */
export interface DepthFrameLike {
  width: number;
  height: number;
  /** Per-pixel metric depth (m), row-major, top row first. */
  depth: Float32Array;
  pose: Pose;
  fovY: number;
  aspect: number;
}

export function depthFrameFromMap(map: {
  width: number;
  height: number;
  metric: Float32Array;
  pose: Pose;
  fovY: number;
  aspect: number;
}): DepthFrameLike {
  return { width: map.width, height: map.height, depth: map.metric, pose: map.pose, fovY: map.fovY, aspect: map.aspect };
}

export function depthFrameFromCameraFrame(frame: {
  width: number;
  height: number;
  depth?: Float32Array;
  pose: Pose;
  fovY: number;
  aspect: number;
}): DepthFrameLike | null {
  if (!frame.depth) return null;
  return { width: frame.width, height: frame.height, depth: frame.depth, pose: frame.pose, fovY: frame.fovY, aspect: frame.aspect };
}

export interface SilhouetteMask {
  /** Bounding box of the mask within the depth frame's pixel grid. */
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** Per-pixel alpha (0..255), row-major, top row first, `width x height`. */
  alpha: Uint8ClampedArray;
  /** Depth (m) used as the object's own "blob" depth for the threshold. */
  blobDepthM: number;
}

export interface SilhouetteOptions {
  /** Depth agreement tolerance (m) around the blob depth. Default 0.08. */
  depthToleranceM?: number;
  /** Dilation radius in pixels. Default 2. */
  dilatePx?: number;
  /** Feather radius in pixels. Default 3. */
  featherPx?: number;
  /** Padding (px) added to the projected box bbox before masking. Default 2. */
  padPx?: number;
  /** Pose to project the occlusion box from; default `obj.originalPose` (where the object was discovered/still is). */
  pose?: Pose;
}

const DEFAULT_DEPTH_TOLERANCE_M = 0.08;
const DEFAULT_DILATE_PX = 2;
const DEFAULT_FEATHER_PX = 3;
const DEFAULT_PAD_PX = 2;
/** Minimum fraction of the padded bbox that must be masked in for a usable silhouette. */
const MIN_COVERAGE = 0.03;

function halfExtentsForProxy(shape: EditableObject['occlusionProxy']): Vec3 {
  switch (shape.kind) {
    case 'box':
      return shape.halfExtents;
    case 'sphere':
      return { x: shape.radius, y: shape.radius, z: shape.radius };
    case 'capsule':
      return { x: shape.radius, y: shape.halfHeight + shape.radius, z: shape.radius };
  }
}

function boxCorners(halfExtents: Vec3): Vec3[] {
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push({ x: sx * halfExtents.x, y: sy * halfExtents.y, z: sz * halfExtents.z });
      }
    }
  }
  return corners;
}

interface ProjectedBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Projects the object's occlusion box into the depth frame; null if it doesn't project usefully. */
function projectBox(df: DepthFrameLike, obj: EditableObject, pose: Pose, padPx: number): ProjectedBox | null {
  const halfExtents = halfExtentsForProxy(obj.occlusionProxy);
  const corners = boxCorners(halfExtents).map((c) => add(pose.position, c));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let anyInFront = false;

  for (const corner of corners) {
    const p = projectPoint(corner, df.pose, df.fovY, df.aspect, df.width, df.height);
    if (!p) continue;
    anyInFront = true;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!anyInFront) return null;

  const x0 = Math.max(0, Math.floor(minX - padPx));
  const x1 = Math.min(df.width, Math.ceil(maxX + padPx));
  const y0 = Math.max(0, Math.floor(minY - padPx));
  const y1 = Math.min(df.height, Math.ceil(maxY + padPx));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x0, x1, y0, y1 };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

/** Grows a binary mask by `radius` pixels (4-neighbour dilation, `radius` passes). */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let cur = mask;
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (cur[i]) {
          next[i] = 1;
          continue;
        }
        const up = y > 0 ? cur[i - width] : 0;
        const down = y < height - 1 ? cur[i + width] : 0;
        const left = x > 0 ? cur[i - 1] : 0;
        const right = x < width - 1 ? cur[i + 1] : 0;
        next[i] = up || down || left || right ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}

/** Softens a binary mask's edges into a 0..255 alpha ramp over ~`radius` pixels via repeated box blur. */
function feather(mask: Uint8Array, width: number, height: number, radius: number): Uint8ClampedArray {
  let cur = new Float32Array(width * height);
  for (let i = 0; i < cur.length; i++) cur[i] = mask[i] ? 255 : 0;

  const passes = Math.max(1, radius);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            sum += cur[yy * width + xx] as number;
            n += 1;
          }
        }
        next[y * width + x] = n > 0 ? sum / n : 0;
      }
    }
    cur = next;
  }
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < cur.length; i++) out[i] = Math.round(cur[i] as number);
  return out;
}

/**
 * Computes a per-pixel silhouette mask for `obj` from a depth frame: pixels
 * inside the object's projected occlusion-box bbox whose sampled depth
 * agrees with the box's own "blob" depth (median depth inside the box,
 * before padding), dilated then feathered. Returns null when the box does
 * not project usefully or too little of it survives the depth filter.
 */
export function computeSilhouetteMask(df: DepthFrameLike, obj: EditableObject, opts?: SilhouetteOptions): SilhouetteMask | null {
  const depthToleranceM = opts?.depthToleranceM ?? DEFAULT_DEPTH_TOLERANCE_M;
  const dilatePx = opts?.dilatePx ?? DEFAULT_DILATE_PX;
  const featherPx = opts?.featherPx ?? DEFAULT_FEATHER_PX;
  const padPx = opts?.padPx ?? DEFAULT_PAD_PX;
  const pose = opts?.pose ?? obj.originalPose;

  const unpadded = projectBox(df, obj, pose, 0);
  if (!unpadded) return null;

  // Blob depth: median of valid depth samples strictly inside the unpadded box bbox.
  const blobSamples: number[] = [];
  for (let y = unpadded.y0; y < unpadded.y1; y++) {
    for (let x = unpadded.x0; x < unpadded.x1; x++) {
      const d = df.depth[y * df.width + x];
      if (d !== undefined && d > 0) blobSamples.push(d);
    }
  }
  if (blobSamples.length === 0) return null;
  const blobDepthM = median(blobSamples);

  const padded = projectBox(df, obj, pose, padPx);
  if (!padded) return null;
  const width = padded.x1 - padded.x0;
  const height = padded.y1 - padded.y0;

  const raw = new Uint8Array(width * height);
  let kept = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx = padded.x0 + x;
      const fy = padded.y0 + y;
      const d = df.depth[fy * df.width + fx];
      const inside = d !== undefined && d > 0 && Math.abs(d - blobDepthM) <= depthToleranceM;
      if (inside) {
        raw[y * width + x] = 1;
        kept += 1;
      }
    }
  }
  if (kept / (width * height) < MIN_COVERAGE) return null;

  const dilated = dilate(raw, width, height, dilatePx);
  const alpha = feather(dilated, width, height, featherPx);

  return { x0: padded.x0, y0: padded.y0, width, height, alpha, blobDepthM };
}

/**
 * Tracks a per-object silhouette mask across frames while the object is
 * present: the returned mask is the per-pixel MEDIAN of the last 5 computed
 * masks (so a single noisy depth frame does not flicker the cutout edge).
 * History resets when the mask's bbox changes (object moved, or the camera
 * did). A frame that yields NO mask (object presumed gone/occluded, or the
 * depth frame momentarily has nothing there) does NOT clear history: it
 * FREEZES the last tracked mask instead, since that frozen shape is exactly
 * what the moved-object impostor and the static-camera eraser need after
 * the object moves, is physically removed, or is deleted (see
 * `src/camera/app.ts`'s per-frame tracking loop, which only calls `update`
 * while the object is still visible at its original pose). Use `clear()` to
 * actually forget an object (e.g. it leaves the scene for good).
 */
export class SilhouetteTracker {
  private readonly history = new Map<
    string,
    { x0: number; y0: number; width: number; height: number; blobDepthM: number[]; frames: Uint8ClampedArray[] }
  >();

  /**
   * Feeds one frame's mask for `objectId`; returns the tracked (median)
   * mask, or the previously frozen one if this frame's depth yields no
   * mask, or undefined if nothing has ever been tracked for it.
   */
  update(objectId: string, df: DepthFrameLike, obj: EditableObject, opts?: SilhouetteOptions & { historyLength?: number }): SilhouetteMask | undefined {
    const historyLength = opts?.historyLength ?? 5;
    const mask = computeSilhouetteMask(df, obj, opts);
    if (!mask) {
      return this.peek(objectId);
    }

    let entry = this.history.get(objectId);
    if (!entry || entry.x0 !== mask.x0 || entry.y0 !== mask.y0 || entry.width !== mask.width || entry.height !== mask.height) {
      entry = { x0: mask.x0, y0: mask.y0, width: mask.width, height: mask.height, blobDepthM: [], frames: [] };
      this.history.set(objectId, entry);
    }
    entry.frames.push(mask.alpha);
    entry.blobDepthM.push(mask.blobDepthM);
    if (entry.frames.length > historyLength) entry.frames.shift();
    if (entry.blobDepthM.length > historyLength) entry.blobDepthM.shift();

    const n = mask.width * mask.height;
    const medianAlpha = new Uint8ClampedArray(n);
    const column: number[] = [];
    for (let i = 0; i < n; i++) {
      column.length = 0;
      for (const frame of entry.frames) column.push(frame[i] as number);
      medianAlpha[i] = Math.round(median(column));
    }

    return { x0: entry.x0, y0: entry.y0, width: entry.width, height: entry.height, alpha: medianAlpha, blobDepthM: median(entry.blobDepthM) };
  }

  /** Latest tracked mask without feeding a new frame, or undefined if none tracked. */
  peek(objectId: string): SilhouetteMask | undefined {
    const entry = this.history.get(objectId);
    if (!entry || entry.frames.length === 0) return undefined;
    const n = entry.width * entry.height;
    const medianAlpha = new Uint8ClampedArray(n);
    const column: number[] = [];
    for (let i = 0; i < n; i++) {
      column.length = 0;
      for (const frame of entry.frames) column.push(frame[i] as number);
      medianAlpha[i] = Math.round(median(column));
    }
    return { x0: entry.x0, y0: entry.y0, width: entry.width, height: entry.height, alpha: medianAlpha, blobDepthM: median(entry.blobDepthM) };
  }

  clear(objectId: string): void {
    this.history.delete(objectId);
  }
}

/** True if a projected pixel lands within the depth frame (re-exported convenience for callers building masks manually). */
export { inFrame };
