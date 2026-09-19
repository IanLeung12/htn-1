/**
 * Pass 3 — verification sweep. Re-projects the baked plate from deliberate
 * off-path viewpoints; degrades the tier when off-path views reveal texels
 * the plate never actually observed.
 */
import type { EditTier, Pose } from '@/core/types';
import { distance } from '@/core/math';
import type { CameraFrame, CameraFrameSource, CleanPlateResult, PlateTextureRegistry } from './contract';
import { footprintFromProxy, OBSERVED_ALPHA_THRESHOLD } from './plates';
import { inFrame, projectPoint } from './geom';

const KEEP_THRESHOLD = 0.85;
const ONE_TIER_THRESHOLD = 0.6;
const VERIFY_GRID = 32;

const TIER_ORDER: EditTier[] = ['A', 'B', 'C', 'D', 'E'];

function degrade(tier: EditTier, fraction: number, provenanceUnavailable: boolean): EditTier {
  const idx = TIER_ORDER.indexOf(tier);
  if (fraction >= KEEP_THRESHOLD) return tier;
  if (fraction >= ONE_TIER_THRESHOLD) return TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)] ?? tier;
  const floor = provenanceUnavailable ? TIER_ORDER.length - 1 : TIER_ORDER.length - 2; // E or D
  return TIER_ORDER[Math.min(idx + 2, floor)] ?? tier;
}

export interface VerifyOptions {
  registry: PlateTextureRegistry;
}

export async function verify(
  result: CleanPlateResult,
  offPathViewpoints: Pose[],
  source: CameraFrameSource,
  opts: VerifyOptions,
) {
  const { plate, object } = result;

  if (!source.available || !plate.textureRef || offPathViewpoints.length === 0) {
    // Nothing to re-check; return the object as captured.
    return { ...object, tierConfidence: plate.provenance === 'unavailable' ? 0 : object.tierConfidence };
  }

  const baked = opts.registry.get(plate.textureRef);
  if (!baked) {
    return object;
  }

  const points: { x: number; y: number; z: number }[] = [];
  const gridY = (plate.region.min.y + plate.region.max.y) / 2;
  for (let row = 0; row < VERIFY_GRID; row++) {
    const z = plate.region.min.z + ((row + 0.5) / VERIFY_GRID) * (plate.region.max.z - plate.region.min.z);
    for (let col = 0; col < VERIFY_GRID; col++) {
      const x = plate.region.min.x + ((col + 0.5) / VERIFY_GRID) * (plate.region.max.x - plate.region.min.x);
      points.push({ x, y: gridY, z });
    }
  }

  // Map each verification sample to its nearest baked-texture texel so we can
  // read whether the original plate actually observed it.
  const bakedObservedAt = (col: number, row: number): boolean => {
    const tx = Math.min(baked.width - 1, Math.floor((col / VERIFY_GRID) * baked.width));
    const ty = Math.min(baked.height - 1, Math.floor((row / VERIFY_GRID) * baked.height));
    const idx = (ty * baked.width + tx) * 4 + 3;
    return (baked.rgba[idx] ?? 0) >= OBSERVED_ALPHA_THRESHOLD;
  };

  const passedFractions: number[] = [];
  const passedDistances: number[] = [];

  for (const viewpoint of offPathViewpoints) {
    const frame = await source.capture();
    if (!frame) continue;

    let visibleCount = 0;
    let coveredCount = 0;
    let i = 0;
    for (let row = 0; row < VERIFY_GRID; row++) {
      for (let col = 0; col < VERIFY_GRID; col++) {
        const point = points[i];
        i += 1;
        if (!point) continue;
        const proj = projectPoint(point, frame.pose, frame.fovY, frame.aspect, frame.width, frame.height);
        if (!proj || !inFrame(proj, frame.width, frame.height)) continue;
        visibleCount += 1;
        if (bakedObservedAt(col, row)) coveredCount += 1;
      }
    }

    const fraction = visibleCount > 0 ? coveredCount / visibleCount : 1;
    if (fraction >= KEEP_THRESHOLD) {
      passedDistances.push(distance(viewpoint.position, plate.envelope.center));
    }
    passedFractions.push(fraction);
  }

  const worstFraction = passedFractions.length > 0 ? Math.min(...passedFractions) : 1;
  const provenanceUnavailable = plate.provenance === 'unavailable';
  const newTier = degrade(object.tier, worstFraction, provenanceUnavailable);

  const radius = passedDistances.length > 0 ? Math.max(...passedDistances) : object.envelope.radius;

  return {
    ...object,
    tier: newTier,
    tierConfidence: worstFraction,
    envelope: { ...object.envelope, radius },
  };
}

// re-export so callers of this module don't need to import from plates.ts too
export type { CameraFrame };
export { footprintFromProxy };
