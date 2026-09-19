/**
 * Click-to-detect: a local object segmentation around one depth pixel.
 *
 * Automatic discovery clusters everything above every plane at once and drops
 * small, thin or crowded blobs by design. When the user clicks something the
 * automatic pass missed, this grows a region from the clicked pixel over the
 * depth map (4-connected flood fill with a depth-continuity test) keeping only
 * points that stand above the support surface under the click, and returns it
 * as a `DetectedVolume` for the normal discovery/approval path.
 */
import type { Surface, Vec3 } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import type { DetectedVolume } from '@/capture/contract';
import type { DepthMap } from '../contract';
import { pickFromMap, pickFromMapRobust, type WorldFrame } from '../pick';

export interface LocalDetectOptions {
  /** Points closer to the support top than this are the support itself. Default 0.015 m. */
  minAboveSupportM?: number;
  /** Horizontal search radius around the clicked point. Default 0.35 m. */
  radiusM?: number;
  /** Largest side accepted (bigger = a wall/person, not a desk object). Default 1.2 m. */
  maxSideM?: number;
  /** Fewest pixels for a volume. Default 12. */
  minCount?: number;
  /** Depth continuity between 4-neighbours: max(absM, relative * depth). Defaults 0.03 m / 0.04. */
  depthStepAbsM?: number;
  depthStepRel?: number;
  /** Id for the resulting volume. */
  id?: string;
  /** Filled with intermediate values for diagnostics. */
  trace?: LocalDetectTrace;
}

export interface LocalDetectTrace {
  seed?: Vec3;
  localMinY?: number;
  registeredY?: number | null;
  supportY?: number;
  seedMoved?: boolean;
  count?: number;
  size?: Vec3;
  reason?: string;
}

/** Top of the highest horizontal surface at or just below `p` whose footprint (padded) contains it; else 0 (the ground). */
export function supportTopAt(surfaces: readonly Surface[], p: Vec3, padM = 0.2): { y: number; surface: Surface | null } {
  let best: Surface | null = null;
  let bestY = -Infinity;
  for (const s of surfaces) {
    if (s.orientation !== 'horizontal') continue;
    const top = s.aabb.max.y;
    if (top > p.y + 0.05) continue;
    const m = s.label === 'floor' ? Infinity : padM;
    if (p.x < s.aabb.min.x - m || p.x > s.aabb.max.x + m || p.z < s.aabb.min.z - m || p.z > s.aabb.max.z + m) continue;
    if (top > bestY) {
      bestY = top;
      best = s;
    }
  }
  return best ? { y: bestY, surface: best } : { y: 0, surface: null };
}

/**
 * Support height around `around`: the most populated 2 cm height band among the depth
 * points within `radius` (XZ) that lie at or below `around.y + 0.03`. The desk/floor an
 * object stands on contributes far more points than the object or than stray stereo
 * matches (the ZED sees a desk edge-on and scatters some points 30 cm below it, which
 * ruins a minimum/percentile estimate). `around.y` if nothing qualifies.
 */
export function supportYAround(map: DepthMap, frame: WorldFrame | null, around: Vec3, radius: number, stride = 2, binM = 0.02): number {
  const bins = new Map<number, number>();
  const ceiling = around.y + 0.03;
  for (let y = 0; y < map.height; y += stride) {
    for (let x = 0; x < map.width; x += stride) {
      const p = pickFromMap(map, x, y, frame);
      if (!p || p.y > ceiling) continue;
      if (Math.hypot(p.x - around.x, p.z - around.z) > radius) continue;
      const b = Math.floor(p.y / binM);
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
  }
  let best = -1;
  let bestCount = 0;
  for (const [b, c] of bins) {
    if (c > bestCount) {
      bestCount = c;
      best = b;
    }
  }
  if (bestCount === 0) return around.y;
  // Top of the band (objects stand on the surface's upper side).
  return (best + 1) * binM;
}

/**
 * Grow an object volume from depth pixel (px, py). Null when the pixel has no
 * depth, lies on the support surface itself, or the region is too small/large.
 */
export function detectVolumeAtPixel(
  map: DepthMap,
  px: number,
  py: number,
  frame: WorldFrame | null,
  surfaces: readonly Surface[],
  opts: LocalDetectOptions = {},
): DetectedVolume | null {
  const minAbove = opts.minAboveSupportM ?? 0.015;
  const radius = opts.radiusM ?? 0.35;
  const maxSide = opts.maxSideM ?? 1.2;
  const minCount = opts.minCount ?? 12;
  const stepAbs = opts.depthStepAbsM ?? 0.03;
  const stepRel = opts.depthStepRel ?? 0.04;

  const trace = opts.trace ?? {};
  const seed = pickFromMapRobust(map, px, py, frame);
  if (!seed) {
    trace.reason = 'no depth';
    return null;
  }
  trace.seed = seed;
  // Support height: the dominant height band around the click (the desk/floor the object stands
  // on is always visible around it). A registered surface is only trusted when it agrees with
  // that; transient planes fitted through can tops or a laptop lid sit at the object's own
  // height and would otherwise leave nothing "above the support".
  const localMinY = supportYAround(map, frame, seed, radius);
  const registered = supportTopAt(surfaces, seed);
  // When both agree take the LOWER of the two: a plane fitted to the far desk sits a few
  // centimetres above the near desk seen edge-on, which would swallow a low object's base.
  const support =
    registered.surface && Math.abs(registered.y - localMinY) <= 0.06
      ? { y: Math.min(registered.y, localMinY), surface: registered.surface }
      : { y: localMinY, surface: null };
  trace.localMinY = localMinY;
  trace.registeredY = registered.surface ? registered.y : null;
  trace.supportY = support.y;
  // Clicked the desk/floor itself: look for something standing just above it around the click.
  let sx = Math.floor(px);
  let sy = Math.floor(py);
  if (seed.y - support.y < minAbove) {
    let found = false;
    outer: for (let r = 1; r <= 6 && !found; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const p = pickFromMap(map, px + dx, py + dy, frame);
          if (p && p.y - support.y >= minAbove && Math.hypot(p.x - seed.x, p.z - seed.z) <= radius) {
            sx = Math.floor(px + dx);
            sy = Math.floor(py + dy);
            found = true;
            break outer;
          }
        }
      }
    }
    trace.seedMoved = found;
    if (!found) {
      trace.reason = 'on support, nothing above nearby';
      return null;
    }
  }

  const { width, height, metric } = map;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [sy * width + sx];
  visited[sy * width + sx] = 1;
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const maxVisits = 80_000;
  let visits = 0;
  while (stack.length > 0 && visits < maxVisits) {
    const i = stack.pop()!;
    visits += 1;
    const d = metric[i] as number;
    if (!(d > 0)) continue;
    const x = i % width;
    const y = (i - x) / width;
    const p = pickFromMap(map, x, y, frame);
    if (!p) continue;
    if (p.y - support.y < minAbove) continue;
    if (p.y - support.y > maxSide) continue;
    if (Math.hypot(p.x - seed.x, p.z - seed.z) > radius) continue;
    count += 1;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    const tol = Math.max(stepAbs, stepRel * d);
    const push = (j: number): void => {
      if (visited[j]) return;
      visited[j] = 1;
      const dj = metric[j] as number;
      if (!(dj > 0) || Math.abs(dj - d) > tol) return;
      stack.push(j);
    };
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }
  trace.count = count;
  if (count < minCount) {
    trace.reason = 'too few points';
    return null;
  }
  // The object stands on its support: extend the box down to the support top.
  minY = Math.min(minY, support.y);
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  trace.size = { x: dx, y: dy, z: dz };
  if (dx > maxSide || dy > maxSide || dz > maxSide) {
    trace.reason = 'too large';
    return null;
  }
  // Depth from a single viewpoint sees only the near face: give a flat box a plausible depth.
  const minHalf = 0.015;
  return {
    id: opts.id ?? 'camera-tap',
    label: 'other',
    pose: { position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }, rotation: { ...IDENTITY_QUAT } },
    halfExtents: { x: Math.max(minHalf, dx / 2), y: Math.max(minHalf, dy / 2), z: Math.max(minHalf, dz / 2) },
  };
}
