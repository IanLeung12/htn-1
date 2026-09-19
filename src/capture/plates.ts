/**
 * Pass 2 — clean-plate acquisition. Projects the predicted exposed region
 * into each captured viewpoint, aggregates observed coverage, and bakes a
 * plate texture from the best (most-perpendicular, observed) frame per texel.
 */
import type {
  Aabb, BackgroundPlate, BackgroundProvenance, BackgroundVersionTag, EditTier, Pose, Surface, Vec3,
} from '@/core/types';
import { distance, quatRotateVec3 } from '@/core/math';
import type { CameraFrame, CameraFrameSource, CleanPlateRequest, CleanPlateResult, PlateTextureRegistry } from './contract';
import { inFrame, projectPoint, sampleDepthNearest, sampleNearest } from './geom';

const DEPTH_TOLERANCE_M = 0.05;
const COVERAGE_GRID = 32;
/** Alpha used for constrained-tier texels filled with the mean observed color
 * (renderable, but distinguishable from a truly observed texel at alpha 255). */
export const FILLED_ALPHA = 160;
/** A texel is treated as "directly observed" (for verification) only above this. */
export const OBSERVED_ALPHA_THRESHOLD = 200;

export interface ObservationGrid {
  points: Vec3[];
  cols: number;
  rows: number;
  observed: boolean[];
  bestFrame: number[];
  score: number[];
}

/** Recompute the exposed footprint from the object's proxy + support surface. */
export function footprintFromProxy(
  center: Vec3,
  halfExtents: Vec3,
  supportSurface: Surface | undefined,
): Aabb {
  const thickness = 0.01;
  const y = supportSurface ? supportSurface.aabb.max.y : center.y - halfExtents.y;
  return {
    min: { x: center.x - halfExtents.x, y: y - thickness / 2, z: center.z - halfExtents.z },
    max: { x: center.x + halfExtents.x, y: y + thickness / 2, z: center.z + halfExtents.z },
  };
}

function regionOf(req: CleanPlateRequest): Aabb {
  const predicted = req.object.background[req.object.background.length - 1]?.region;
  if (predicted) return predicted;
  const proxy = req.object.interactionProxy;
  const halfExtents = proxy.kind === 'box' ? proxy.halfExtents : { x: 0.3, y: 0.3, z: 0.3 };
  return footprintFromProxy(req.object.currentPose.position, halfExtents, req.supportSurface);
}

function sampleGridPoints(region: Aabb, gridSize: number): Vec3[] {
  const points: Vec3[] = [];
  const y = (region.min.y + region.max.y) / 2;
  for (let row = 0; row < gridSize; row++) {
    const z = region.min.z + ((row + 0.5) / gridSize) * (region.max.z - region.min.z);
    for (let col = 0; col < gridSize; col++) {
      const x = region.min.x + ((col + 0.5) / gridSize) * (region.max.x - region.min.x);
      points.push({ x, y, z });
    }
  }
  return points;
}

/**
 * Project a set of sample points into every frame, tracking whether each is
 * actually observed (in-frame, and depth-consistent with the support surface
 * when depth is available) and which frame gives the best (most-perpendicular)
 * observed view of each point.
 */
export function computeObservation(points: Vec3[], frames: CameraFrame[]): {
  observed: boolean[];
  bestFrame: number[];
  hadDepth: boolean;
} {
  const observed = new Array<boolean>(points.length).fill(false);
  const bestFrame = new Array<number>(points.length).fill(-1);
  const bestScore = new Array<number>(points.length).fill(-Infinity);
  let hadDepth = false;

  frames.forEach((frame, frameIdx) => {
    const forward = quatRotateVec3(frame.pose.rotation, { x: 0, y: 0, z: -1 });
    // How perpendicular this frame's view is to a horizontal surface (looking
    // straight down scores highest).
    const perpScore = -forward.y;
    if (frame.depth) hadDepth = true;

    points.forEach((point, i) => {
      const proj = projectPoint(point, frame.pose, frame.fovY, frame.aspect, frame.width, frame.height);
      if (!proj || !inFrame(proj, frame.width, frame.height)) return;

      if (frame.depth) {
        const sampled = sampleDepthNearest(frame.depth, frame.width, frame.height, proj.x, proj.y);
        if (sampled === undefined || Math.abs(sampled - proj.depth) > DEPTH_TOLERANCE_M) return;
      }

      observed[i] = true;
      if (perpScore > (bestScore[i] ?? -Infinity)) {
        bestScore[i] = perpScore;
        bestFrame[i] = frameIdx;
      }
    });
  });

  return { observed, bestFrame, hadDepth };
}

function tierForProvenance(provenance: BackgroundProvenance): EditTier {
  switch (provenance) {
    case 'observed_clean_plate': return 'A';
    case 'multi_view_observed': return 'B';
    case 'constrained_surface': return 'C';
    case 'synthetic_completion': return 'D';
    case 'unavailable':
    default:
      return 'E';
  }
}

export interface AcquireOptions {
  now?: () => number;
  textureSize?: number;
  registry: PlateTextureRegistry;
}

export async function acquireCleanPlate(
  req: CleanPlateRequest,
  source: CameraFrameSource,
  opts: AcquireOptions,
): Promise<CleanPlateResult> {
  const now = opts.now ?? (() => Date.now());
  const region = regionOf(req);

  if (!source.available) {
    const plate: BackgroundPlate = {
      id: `plate:${req.object.id}:invalidated`,
      provenance: 'unavailable',
      version: 'invalidated',
      region,
      coverage: 0,
      envelope: { center: req.object.currentPose.position, radius: 1.5, maxAngle: 1.0 },
    };
    return {
      plate,
      object: {
        ...req.object,
        tier: 'E',
        tierConfidence: 0,
        background: [...req.object.background, plate],
      },
      framesUsed: 0,
    };
  }

  const frames: CameraFrame[] = [];
  for (const viewpoint of req.viewpoints) {
    const frame = await source.capture(viewpoint);
    if (frame) frames.push(frame);
  }

  const coveragePoints = sampleGridPoints(region, COVERAGE_GRID);
  const coverageObs = computeObservation(coveragePoints, frames);
  const observedCount = coverageObs.observed.filter(Boolean).length;
  const coverage = coveragePoints.length > 0 ? observedCount / coveragePoints.length : 0;

  const depthVerified = coverageObs.hadDepth;

  let provenance: BackgroundProvenance;
  let version: BackgroundVersionTag;
  if (coverage >= 0.9 && depthVerified) {
    provenance = 'observed_clean_plate';
    version = 'observed_v1';
  } else if (coverage >= 0.6) {
    provenance = 'multi_view_observed';
    version = 'fused_v2';
  } else if (coverage >= 0.3) {
    provenance = 'constrained_surface';
    version = 'fused_v2';
  } else {
    provenance = 'unavailable';
    version = 'invalidated';
  }

  const textureSize = opts.textureSize ?? 128;
  const texturePoints = sampleGridPoints(region, textureSize);
  const textureObs = computeObservation(texturePoints, frames);

  const rgba = new Uint8ClampedArray(textureSize * textureSize * 4);
  const observedColors: [number, number, number][] = [];

  for (let i = 0; i < texturePoints.length; i++) {
    const outIdx = i * 4;
    if (textureObs.observed[i]) {
      const frameIdx = textureObs.bestFrame[i] ?? -1;
      const frame = frameIdx >= 0 ? frames[frameIdx] : undefined;
      const point = texturePoints[i];
      if (frame && point) {
        const proj = projectPoint(point, frame.pose, frame.fovY, frame.aspect, frame.width, frame.height);
        if (proj) {
          const [r, g, b] = sampleNearest(frame.rgba, frame.width, frame.height, proj.x, proj.y);
          rgba[outIdx] = r;
          rgba[outIdx + 1] = g;
          rgba[outIdx + 2] = b;
          rgba[outIdx + 3] = 255;
          observedColors.push([r, g, b]);
          continue;
        }
      }
    }
    rgba[outIdx] = 0;
    rgba[outIdx + 1] = 0;
    rgba[outIdx + 2] = 0;
    rgba[outIdx + 3] = 0;
  }

  if (provenance === 'constrained_surface' && observedColors.length > 0) {
    const mean: [number, number, number] = [0, 0, 0];
    for (const [r, g, b] of observedColors) {
      mean[0] += r;
      mean[1] += g;
      mean[2] += b;
    }
    mean[0] /= observedColors.length;
    mean[1] /= observedColors.length;
    mean[2] /= observedColors.length;

    // Filled texels are renderable but not truly observed: use a distinct
    // alpha (FILLED_ALPHA, below) so verification can tell a directly
    // observed texel (alpha 255) apart from a mean-color fill.
    for (let i = 0; i < texturePoints.length; i++) {
      const outIdx = i * 4;
      if (rgba[outIdx + 3] === 0) {
        rgba[outIdx] = mean[0];
        rgba[outIdx + 1] = mean[1];
        rgba[outIdx + 2] = mean[2];
        rgba[outIdx + 3] = FILLED_ALPHA;
      }
    }
  }

  const textureRef = `plate:${req.object.id}:${version}`;
  opts.registry.put(textureRef, { width: textureSize, height: textureSize, rgba });

  // The envelope is anchored on the exposed region itself: "within radius of the
  // edited spot and looking roughly at it" (pointInEnvelope measures the angle between
  // head forward and the direction to the centre). Radius covers every capture
  // viewpoint plus a metre of slack.
  const center: Vec3 = {
    x: (region.min.x + region.max.x) / 2,
    y: (region.min.y + region.max.y) / 2,
    z: (region.min.z + region.max.z) / 2,
  };
  const farthestViewpoint = req.viewpoints.reduce((m, v) => Math.max(m, distance(v.position, center)), 0);
  const radius = Math.max(1.5, farthestViewpoint + 1.0);

  const plate: BackgroundPlate = {
    id: textureRef,
    provenance,
    version,
    region,
    coverage,
    textureRef: provenance === 'unavailable' ? undefined : textureRef,
    envelope: { center, radius, maxAngle: 1.0 },
  };

  const object = {
    ...req.object,
    tier: tierForProvenance(provenance),
    tierConfidence: coverage,
    background: [...req.object.background, plate],
    provenance: {
      method: 'guided_clean_plate' as const,
      capturedAt: now(),
      capturePath: req.viewpoints,
    },
  };

  return { plate, object, framesUsed: frames.length };
}
