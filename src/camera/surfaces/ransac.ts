/**
 * Pure-TS RANSAC plane fitting and above-plane clustering on world-space
 * point clouds derived from a `DepthMap` (see docs/general-camera/architecture.md,
 * "Model and library choices" -> Planes). No DOM. Deterministic (seeded LCG)
 * so unit tests are reproducible.
 */
import type { Aabb, Vec3 } from '@/core/types';
import { cross, dot, length, normalize, sub } from '@/core/math';
import type { DepthMap } from '@/camera/contract';
import { unprojectPixel } from '@/capture/geom';

// ---------------------------------------------------------------------------
// Point cloud extraction
// ---------------------------------------------------------------------------

/**
 * World-space XYZ triples (flat Float32Array, 3 per point) for every valid
 * pixel (`depth > 0`, `<= maxDepthM`) on a `stride` pixel grid of `depth`.
 */
export function depthToPoints(depth: DepthMap, stride: number, maxDepthM = 8): Float32Array {
  const { width, height, metric, pose, fovY, aspect } = depth;
  const out: number[] = [];
  const step = Math.max(1, Math.floor(stride));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const d = metric[y * width + x];
      if (d === undefined || !(d > 0) || d > maxDepthM) continue;
      const p = unprojectPixel(x + 0.5, y + 0.5, d, pose, fovY, aspect, width, height);
      out.push(p.x, p.y, p.z);
    }
  }
  return Float32Array.from(out);
}

function pointAt(points: Float32Array, i: number): Vec3 {
  return { x: points[i * 3] as number, y: points[i * 3 + 1] as number, z: points[i * 3 + 2] as number };
}

// ---------------------------------------------------------------------------
// Deterministic RNG (LCG)
// ---------------------------------------------------------------------------

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }
  next(): number {
    // Numerical Recipes LCG constants.
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0xffffffff;
  }
  nextInt(maxExclusive: number): number {
    return Math.min(maxExclusive - 1, Math.floor(this.next() * maxExclusive));
  }
}

// ---------------------------------------------------------------------------
// Plane fit
// ---------------------------------------------------------------------------

export interface PlaneFit {
  /** Unit plane normal. */
  normal: Vec3;
  /** Plane equation: dot(normal, p) + d = 0. */
  d: number;
  /** Indices into the source `points` array that are inliers. */
  inliers: Uint32Array;
  /** inliers.length / usable point count. */
  inlierFraction: number;
  centroid: Vec3;
  extentMin: Vec3;
  extentMax: Vec3;
}

export interface RansacPlaneOptions {
  iterations?: number;
  thresholdM?: number;
  minInliers?: number;
  /** Constrain the fitted normal to be within `maxNormalAngleRad` of this direction. */
  normalHint?: Vec3;
  maxNormalAngleRad?: number;
  /** 1 = usable for sampling/counting; restricts a second search to exclude prior inliers. */
  candidateMask?: Uint8Array;
  seed?: number;
}

function planeFromThreePoints(a: Vec3, b: Vec3, c: Vec3): { normal: Vec3; d: number } | null {
  const n = cross(sub(b, a), sub(c, a));
  const len = length(n);
  if (len < 1e-9) return null;
  const normal = { x: n.x / len, y: n.y / len, z: n.z / len };
  const d = -dot(normal, a);
  return { normal, d };
}

function angleBetween(a: Vec3, b: Vec3): number {
  const cosA = Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))));
  return Math.acos(cosA);
}

/** Flip `n` so it points into the same hemisphere as `hint`. */
function alignToHint(n: Vec3, hint: Vec3): Vec3 {
  return dot(n, hint) < 0 ? { x: -n.x, y: -n.y, z: -n.z } : n;
}

/** Tiny symmetric 3x3 Jacobi eigensolver; returns eigenvector for the smallest eigenvalue. */
function smallestEigenvector(m: number[][]): Vec3 {
  // m is 3x3 symmetric, row-major as m[row][col].
  const a: number[][] = [
    [m[0]![0]!, m[0]![1]!, m[0]![2]!],
    [m[1]![0]!, m[1]![1]!, m[1]![2]!],
    [m[2]![0]!, m[2]![1]!, m[2]![2]!],
  ];
  const v: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    // Find largest off-diagonal element.
    let p = 0;
    let q = 1;
    let max = Math.abs(a[0]![1]!);
    if (Math.abs(a[0]![2]!) > max) {
      max = Math.abs(a[0]![2]!);
      p = 0;
      q = 2;
    }
    if (Math.abs(a[1]![2]!) > max) {
      max = Math.abs(a[1]![2]!);
      p = 1;
      q = 2;
    }
    if (max < 1e-12) break;

    const app = a[p]![p]!;
    const aqq = a[q]![q]!;
    const apq = a[p]![q]!;
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    for (let k = 0; k < 3; k++) {
      const akp = a[k]![p]!;
      const akq = a[k]![q]!;
      a[k]![p] = c * akp - s * akq;
      a[k]![q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p]![k]!;
      const aqk = a[q]![k]!;
      a[p]![k] = c * apk - s * aqk;
      a[q]![k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k]![p]!;
      const vkq = v[k]![q]!;
      v[k]![p] = c * vkp - s * vkq;
      v[k]![q] = s * vkp + c * vkq;
    }
  }

  let minIdx = 0;
  let minVal = a[0]![0]!;
  if (a[1]![1]! < minVal) {
    minVal = a[1]![1]!;
    minIdx = 1;
  }
  if (a[2]![2]! < minVal) {
    minIdx = 2;
  }
  const vec: Vec3 = { x: v[0]![minIdx]!, y: v[1]![minIdx]!, z: v[2]![minIdx]! };
  return normalize(vec);
}

function refitPlane(points: Float32Array, inlierIdx: number[]): { normal: Vec3; d: number; centroid: Vec3 } {
  const centroid = { x: 0, y: 0, z: 0 };
  for (const i of inlierIdx) {
    const p = pointAt(points, i);
    centroid.x += p.x;
    centroid.y += p.y;
    centroid.z += p.z;
  }
  const n = inlierIdx.length;
  centroid.x /= n;
  centroid.y /= n;
  centroid.z /= n;

  const cov: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const i of inlierIdx) {
    const p = pointAt(points, i);
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    const dz = p.z - centroid.z;
    cov[0]![0]! += dx * dx;
    cov[0]![1]! += dx * dy;
    cov[0]![2]! += dx * dz;
    cov[1]![1]! += dy * dy;
    cov[1]![2]! += dy * dz;
    cov[2]![2]! += dz * dz;
  }
  cov[1]![0] = cov[0]![1]!;
  cov[2]![0] = cov[0]![2]!;
  cov[2]![1] = cov[1]![2]!;

  const normal = smallestEigenvector(cov);
  const d = -dot(normal, centroid);
  return { normal, d, centroid };
}

/** Standard 3-point RANSAC plane fit with least-squares refit, deterministic. */
export function ransacPlane(points: Float32Array, opts: RansacPlaneOptions = {}): PlaneFit | null {
  const n = Math.floor(points.length / 3);
  if (n < 3) return null;

  const iterations = opts.iterations ?? 200;
  const thresholdM = opts.thresholdM ?? 0.03;
  const minInliers = opts.minInliers ?? 50;
  const mask = opts.candidateMask;

  const usable: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!mask || mask[i] === 1) usable.push(i);
  }
  if (usable.length < 3) return null;

  const rng = new Lcg(opts.seed ?? 1);

  let bestInliers: number[] | null = null;
  let bestNormal: Vec3 | null = null;
  let bestD = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const i0 = usable[rng.nextInt(usable.length)] as number;
    const i1 = usable[rng.nextInt(usable.length)] as number;
    const i2 = usable[rng.nextInt(usable.length)] as number;
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;

    const plane = planeFromThreePoints(pointAt(points, i0), pointAt(points, i1), pointAt(points, i2));
    if (!plane) continue;

    let normal = plane.normal;
    if (opts.normalHint) {
      normal = alignToHint(normal, opts.normalHint);
      if (opts.maxNormalAngleRad !== undefined) {
        const angle = angleBetween(normal, opts.normalHint);
        if (angle > opts.maxNormalAngleRad) continue;
      }
    }
    const d = -dot(normal, pointAt(points, i0));

    const inliers: number[] = [];
    for (const idx of usable) {
      const p = pointAt(points, idx);
      const dist = Math.abs(dot(normal, p) + d);
      if (dist <= thresholdM) inliers.push(idx);
    }

    if (!bestInliers || inliers.length > bestInliers.length) {
      bestInliers = inliers;
      bestNormal = normal;
      bestD = d;
    }
  }

  if (!bestInliers || !bestNormal || bestInliers.length < minInliers) return null;

  // Least-squares refit on the inliers.
  const refit = refitPlane(points, bestInliers);
  let normal = refit.normal;
  if (opts.normalHint) {
    normal = alignToHint(normal, opts.normalHint);
    if (opts.maxNormalAngleRad !== undefined) {
      const angle = angleBetween(normal, opts.normalHint);
      if (angle > opts.maxNormalAngleRad) {
        // Refit strayed outside the hint cone; fall back to the RANSAC-sample normal.
        normal = bestNormal;
      }
    }
  }
  const d = -dot(normal, refit.centroid);

  // Final inlier recount against the refit plane.
  const finalInliers: number[] = [];
  const extentMin: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const extentMax: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const idx of usable) {
    const p = pointAt(points, idx);
    const dist = Math.abs(dot(normal, p) + d);
    if (dist <= thresholdM) {
      finalInliers.push(idx);
      if (p.x < extentMin.x) extentMin.x = p.x;
      if (p.y < extentMin.y) extentMin.y = p.y;
      if (p.z < extentMin.z) extentMin.z = p.z;
      if (p.x > extentMax.x) extentMax.x = p.x;
      if (p.y > extentMax.y) extentMax.y = p.y;
      if (p.z > extentMax.z) extentMax.z = p.z;
    }
  }
  if (finalInliers.length < minInliers) return null;

  // Extents from the 3rd..97th percentile of inlier coordinates so a handful of
  // mis-scaled far points cannot stretch a desk into a 7 m slab.
  trimExtents(points, finalInliers, extentMin, extentMax);

  const centroid = { x: 0, y: 0, z: 0 };
  for (const idx of finalInliers) {
    const p = pointAt(points, idx);
    centroid.x += p.x;
    centroid.y += p.y;
    centroid.z += p.z;
  }
  centroid.x /= finalInliers.length;
  centroid.y /= finalInliers.length;
  centroid.z /= finalInliers.length;

  return {
    normal,
    d,
    inliers: Uint32Array.from(finalInliers),
    inlierFraction: finalInliers.length / usable.length,
    centroid,
    extentMin,
    extentMax,
  };
}

function trimExtents(points: Float32Array, inliers: number[], extentMin: Vec3, extentMax: Vec3): void {
  if (inliers.length < 20) return;
  const lo = Math.floor(inliers.length * 0.03);
  const hi = Math.min(inliers.length - 1, Math.ceil(inliers.length * 0.97));
  const xs = new Float32Array(inliers.length);
  const ys = new Float32Array(inliers.length);
  const zs = new Float32Array(inliers.length);
  for (let i = 0; i < inliers.length; i++) {
    const idx = (inliers[i] as number) * 3;
    xs[i] = points[idx] as number;
    ys[i] = points[idx + 1] as number;
    zs[i] = points[idx + 2] as number;
  }
  xs.sort();
  ys.sort();
  zs.sort();
  extentMin.x = xs[lo] as number;
  extentMax.x = xs[hi] as number;
  extentMin.y = ys[lo] as number;
  extentMax.y = ys[hi] as number;
  extentMin.z = zs[lo] as number;
  extentMax.z = zs[hi] as number;
}

/**
 * Merge near-coplanar horizontal fits (height within `heightTolM`, XZ boxes
 * overlapping): RANSAC on noisy monocular depth splits one bed into layers a
 * few centimetres apart. Inliers are unioned, extents unioned, centroid
 * weighted by inlier count. Result sorted lowest first.
 */
export function mergeHorizontalPlanes(fits: PlaneFit[], heightTolM: number): PlaneFit[] {
  const out: PlaneFit[] = [];
  const sorted = fits.slice().sort((a, b) => a.centroid.y - b.centroid.y);
  for (const fit of sorted) {
    const target = out.find(
      (o) =>
        Math.abs(o.centroid.y - fit.centroid.y) <= heightTolM &&
        o.extentMin.x <= fit.extentMax.x && o.extentMax.x >= fit.extentMin.x &&
        o.extentMin.z <= fit.extentMax.z && o.extentMax.z >= fit.extentMin.z,
    );
    if (!target) {
      out.push({ ...fit, inliers: Uint32Array.from(fit.inliers), extentMin: { ...fit.extentMin }, extentMax: { ...fit.extentMax } });
      continue;
    }
    const na = target.inliers.length;
    const nb = fit.inliers.length;
    const n = na + nb;
    target.centroid = {
      x: (target.centroid.x * na + fit.centroid.x * nb) / n,
      y: (target.centroid.y * na + fit.centroid.y * nb) / n,
      z: (target.centroid.z * na + fit.centroid.z * nb) / n,
    };
    target.d = -(target.normal.x * target.centroid.x + target.normal.y * target.centroid.y + target.normal.z * target.centroid.z);
    const merged = new Uint32Array(n);
    merged.set(target.inliers, 0);
    merged.set(fit.inliers, na);
    target.inliers = merged;
    target.inlierFraction += fit.inlierFraction;
    target.extentMin = { x: Math.min(target.extentMin.x, fit.extentMin.x), y: Math.min(target.extentMin.y, fit.extentMin.y), z: Math.min(target.extentMin.z, fit.extentMin.z) };
    target.extentMax = { x: Math.max(target.extentMax.x, fit.extentMax.x), y: Math.max(target.extentMax.y, fit.extentMax.y), z: Math.max(target.extentMax.z, fit.extentMax.z) };
  }
  return out.sort((a, b) => a.centroid.y - b.centroid.y);
}

// ---------------------------------------------------------------------------
// Repeated plane search
// ---------------------------------------------------------------------------

export interface FindPlanesOptions {
  maxPlanes?: number;
  thresholdM?: number;
  minInliers?: number;
  seed?: number;
  /** RANSAC iterations per plane (default 200). */
  iterations?: number;
  /** Initial usable-point mask (1 = usable); copied, never mutated. Lets a vertical
   * search skip every point already claimed by horizontal planes, which otherwise
   * dominate the random samples. */
  candidateMask?: Uint8Array;
}

export interface FindHorizontalPlanesOptions extends FindPlanesOptions {
  floorYPrior?: number;
}

const DEG15 = (15 * Math.PI) / 180;

function findPlanesWithHint(
  points: Float32Array,
  normalHint: Vec3,
  maxNormalAngleRad: number,
  opts: FindPlanesOptions,
): PlaneFit[] {
  const n = Math.floor(points.length / 3);
  if (n === 0) return [];
  const maxPlanes = opts.maxPlanes ?? 3;
  const mask = opts.candidateMask ? new Uint8Array(opts.candidateMask) : new Uint8Array(n).fill(1);
  const results: PlaneFit[] = [];

  for (let k = 0; k < maxPlanes; k++) {
    const fit = ransacPlane(points, {
      iterations: opts.iterations ?? 200,
      thresholdM: opts.thresholdM,
      minInliers: opts.minInliers,
      normalHint,
      maxNormalAngleRad,
      candidateMask: mask,
      seed: (opts.seed ?? 1) + k * 97,
    });
    if (!fit) break;
    results.push(fit);
    for (const idx of fit.inliers) mask[idx] = 0;
  }
  return results;
}

/** Repeated RANSAC for near-horizontal planes (normal within 15deg of +Y), lowest first. */
export function findHorizontalPlanes(points: Float32Array, opts: FindHorizontalPlanesOptions = {}): PlaneFit[] {
  const fits = findPlanesWithHint(points, { x: 0, y: 1, z: 0 }, DEG15, opts);
  return fits.slice().sort((a, b) => a.centroid.y - b.centroid.y);
}

/**
 * Repeated RANSAC for near-vertical planes (|normal.y| < sin(15deg)). Each
 * slot tries 8 horizontal normal hints (22.5 degrees apart, 15 degree cone)
 * and keeps the fit with the most inliers - a free sample among points
 * dominated by furniture sides rarely lands on the wall, a hinted one does.
 */
export function findVerticalPlanes(points: Float32Array, opts: FindPlanesOptions = {}): PlaneFit[] {
  const n = Math.floor(points.length / 3);
  if (n === 0) return [];
  const maxPlanes = opts.maxPlanes ?? 2;
  const maxNormalYAbs = Math.sin(DEG15);
  const mask = opts.candidateMask ? new Uint8Array(opts.candidateMask) : new Uint8Array(n).fill(1);
  const results: PlaneFit[] = [];
  const cone = DEG15;

  for (let k = 0; k < maxPlanes; k++) {
    let best: PlaneFit | null = null;
    for (let h = 0; h < 8; h++) {
      const angle = (h * Math.PI) / 8;
      const fit = ransacPlane(points, {
        iterations: Math.max(40, Math.floor((opts.iterations ?? 200) / 4)),
        thresholdM: opts.thresholdM,
        minInliers: opts.minInliers,
        normalHint: { x: Math.sin(angle), y: 0, z: Math.cos(angle) },
        maxNormalAngleRad: cone,
        candidateMask: mask,
        seed: (opts.seed ?? 1) + k * 97 + h * 13,
      });
      if (!fit || Math.abs(fit.normal.y) > maxNormalYAbs + 1e-6) continue;
      if (!best || fit.inliers.length > best.inliers.length) best = fit;
    }
    if (!best) break;
    results.push(best);
    for (const idx of best.inliers) mask[idx] = 0;
  }
  return results;
}

/**
 * Best-first plane extraction: repeatedly fit the single largest plane among
 * the points no earlier plane claimed (no normal constraint), classify it by
 * its normal, mask its inliers, repeat. Finding planes in size order is what
 * keeps a loose threshold from slicing a wall into "horizontal" strips: the
 * whole wall (thousands of points) wins before any 0.1 m strip of it can.
 * Fits that are neither horizontal nor vertical, or whose in-plane extent is
 * a sliver (< `sliverM`), are discarded (their points stay masked).
 */
export function extractPlanes(
  points: Float32Array,
  opts: FindPlanesOptions & { sliverM?: number } = {},
): { horizontal: PlaneFit[]; vertical: PlaneFit[] } {
  const n = Math.floor(points.length / 3);
  const horizontal: PlaneFit[] = [];
  const vertical: PlaneFit[] = [];
  if (n === 0) return { horizontal, vertical };
  const maxPlanes = opts.maxPlanes ?? 8;
  const mask = opts.candidateMask ? new Uint8Array(opts.candidateMask) : new Uint8Array(n).fill(1);
  const sliverM = opts.sliverM ?? Math.max(0.1, 3 * (opts.thresholdM ?? 0.03));
  const cosH = Math.cos(DEG15);
  const sinV = Math.sin(DEG15);
  for (let k = 0; k < maxPlanes; k++) {
    const fit = ransacPlane(points, {
      iterations: opts.iterations ?? 200,
      thresholdM: opts.thresholdM,
      minInliers: opts.minInliers,
      candidateMask: mask,
      seed: (opts.seed ?? 1) + k * 97,
    });
    if (!fit) break;
    for (const idx of fit.inliers) mask[idx] = 0;
    const ny = fit.normal.y;
    if (Math.abs(ny) >= cosH) {
      if (ny < 0) {
        fit.normal = { x: -fit.normal.x, y: -fit.normal.y, z: -fit.normal.z };
        fit.d = -fit.d;
      }
      const ex = fit.extentMax.x - fit.extentMin.x;
      const ez = fit.extentMax.z - fit.extentMin.z;
      if (Math.min(ex, ez) < sliverM) continue;
      horizontal.push(fit);
    } else if (Math.abs(ny) <= sinV) {
      const ey = fit.extentMax.y - fit.extentMin.y;
      const exz = Math.hypot(fit.extentMax.x - fit.extentMin.x, fit.extentMax.z - fit.extentMin.z);
      if (Math.min(ey, exz) < sliverM) continue;
      vertical.push(fit);
    }
  }
  horizontal.sort((a, b) => a.centroid.y - b.centroid.y);
  return { horizontal, vertical };
}

// ---------------------------------------------------------------------------
// Clustering above a support plane
// ---------------------------------------------------------------------------

export interface VolumeCluster {
  aabb: Aabb;
  count: number;
  supportY: number;
  /** Lowest point actually seen in the cluster (aabb.min.y is forced to the plane). */
  lowestY: number;
}

export interface ClusterAbovePlaneOptions {
  cellM?: number;
  minHeightM?: number;
  maxHeightM?: number;
  minCells?: number;
  regionAabb?: Aabb;
}

export function clusterAbovePlane(points: Float32Array, planeY: number, opts: ClusterAbovePlaneOptions = {}): VolumeCluster[] {
  const cellM = opts.cellM ?? 0.05;
  const minHeightM = opts.minHeightM ?? 0.04;
  const maxHeightM = opts.maxHeightM ?? 2;
  const minCells = opts.minCells ?? 6;
  const region = opts.regionAabb;

  const n = Math.floor(points.length / 3);
  // cell key -> point indices
  const cells = new Map<string, number[]>();

  for (let i = 0; i < n; i++) {
    const p = pointAt(points, i);
    const h = p.y - planeY;
    if (h <= minHeightM || h > maxHeightM) continue;
    if (region) {
      if (p.x < region.min.x || p.x > region.max.x || p.z < region.min.z || p.z > region.max.z) continue;
      if (p.y < region.min.y || p.y > region.max.y) continue;
    }
    const cx = Math.floor(p.x / cellM);
    const cz = Math.floor(p.z / cellM);
    const key = `${cx},${cz}`;
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(i);
  }

  if (cells.size === 0) return [];

  // Connected components over 4-neighbour cell adjacency.
  const visited = new Set<string>();
  const clusters: VolumeCluster[] = [];

  function parseKey(key: string): [number, number] {
    const parts = key.split(',');
    return [Number(parts[0]), Number(parts[1])];
  }

  for (const startKey of cells.keys()) {
    if (visited.has(startKey)) continue;
    visited.add(startKey);
    const stack = [startKey];
    const componentCellKeys: string[] = [];

    while (stack.length > 0) {
      const key = stack.pop() as string;
      componentCellKeys.push(key);
      const [cx, cz] = parseKey(key);
      const neighbours = [`${cx + 1},${cz}`, `${cx - 1},${cz}`, `${cx},${cz + 1}`, `${cx},${cz - 1}`];
      for (const nb of neighbours) {
        if (cells.has(nb) && !visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      }
    }

    if (componentCellKeys.length < minCells) continue;

    const min: Vec3 = { x: Infinity, y: planeY, z: Infinity };
    const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
    let lowestY = Infinity;
    let count = 0;
    for (const key of componentCellKeys) {
      const idxs = cells.get(key) as number[];
      for (const idx of idxs) {
        const p = pointAt(points, idx);
        count += 1;
        if (p.y < lowestY) lowestY = p.y;
        if (p.x < min.x) min.x = p.x;
        if (p.z < min.z) min.z = p.z;
        if (p.x > max.x) max.x = p.x;
        if (p.y > max.y) max.y = p.y;
        if (p.z > max.z) max.z = p.z;
      }
    }
    min.y = planeY;
    if (!Number.isFinite(max.y)) continue;

    clusters.push({ aabb: { min, max }, count, supportY: planeY, lowestY });
  }

  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}
