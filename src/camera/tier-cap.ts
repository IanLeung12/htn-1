/**
 * Tier caps for clean plates built from ESTIMATED depth (see
 * docs/general-camera/architecture.md, "Truthfulness contract"):
 *
 *  - monocular depth: never tier A unless multi-view agreement passes
 *    (>= 3 frames, bearings differing by > 15 degrees, region depth
 *    agreeing within 8 cm RMS). Otherwise capped at B
 *    (`multi_view_observed` / `fused_v2`).
 *  - plane-prior depth (or no depth at all): capped at C
 *    (`constrained_surface`).
 *
 * Pure TS; the camera app applies it after `acquireCleanPlate` + `verify`.
 */
import type { BackgroundPlate, EditTier, EditableObject } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import { quatRotateVec3 } from '@/core/math';
import { inFrame, projectPoint, sampleDepthNearest } from '@/capture/geom';

const TIER_ORDER: EditTier[] = ['A', 'B', 'C', 'D', 'E'];
const MIN_AGREEING_FRAMES = 3;
const MIN_BEARING_SPREAD_RAD = (15 * Math.PI) / 180;
const MAX_AGREEMENT_RMS_M = 0.08;
const AGREEMENT_GRID = 8;

export interface CappedResult {
  plate: BackgroundPlate;
  tier: EditTier;
  confidence: number;
  /** Which cap applied ('none' when the capture was allowed to keep its tier). */
  cap: 'none' | 'B' | 'C';
}

function worstTier(a: EditTier, b: EditTier): EditTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/** Largest pairwise horizontal bearing difference between frame poses (rad). */
export function bearingSpread(frames: readonly Pick<CameraFrame, 'pose'>[]): number {
  let spread = 0;
  const headings = frames.map((f) => {
    const fwd = quatRotateVec3(f.pose.rotation, { x: 0, y: 0, z: -1 });
    return Math.atan2(fwd.x, -fwd.z);
  });
  for (let i = 0; i < headings.length; i++) {
    for (let j = i + 1; j < headings.length; j++) {
      let d = Math.abs((headings[i] as number) - (headings[j] as number));
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > spread) spread = d;
    }
  }
  return spread;
}

/**
 * RMS disagreement (m) between frames' depth of the plate region: every grid
 * point of the region is projected into each frame with depth; the point's
 * predicted depth is compared with the sampled depth. Returns Infinity when
 * fewer than two frames see the region.
 */
export function regionDepthRms(plate: BackgroundPlate, frames: readonly CameraFrame[]): number {
  const { min, max } = plate.region;
  const y = (min.y + max.y) / 2;
  let se = 0;
  let n = 0;
  let framesSeeing = 0;
  for (const frame of frames) {
    if (!frame.depth) continue;
    let sawAny = false;
    for (let r = 0; r < AGREEMENT_GRID; r++) {
      for (let c = 0; c < AGREEMENT_GRID; c++) {
        const p = {
          x: min.x + ((c + 0.5) / AGREEMENT_GRID) * (max.x - min.x),
          y,
          z: min.z + ((r + 0.5) / AGREEMENT_GRID) * (max.z - min.z),
        };
        const proj = projectPoint(p, frame.pose, frame.fovY, frame.aspect, frame.width, frame.height);
        if (!proj || !inFrame(proj, frame.width, frame.height)) continue;
        const d = sampleDepthNearest(frame.depth, frame.width, frame.height, proj.x, proj.y);
        if (d === undefined || !(d > 0)) continue;
        se += (d - proj.depth) * (d - proj.depth);
        n += 1;
        sawAny = true;
      }
    }
    if (sawAny) framesSeeing += 1;
  }
  if (framesSeeing < 2 || n === 0) return Infinity;
  return Math.sqrt(se / n);
}

export function multiViewAgreement(plate: BackgroundPlate, frames: readonly CameraFrame[]): boolean {
  const withDepth = frames.filter((f) => f.depth && f.depthSource === 'monocular');
  if (withDepth.length < MIN_AGREEING_FRAMES) return false;
  if (bearingSpread(withDepth) < MIN_BEARING_SPREAD_RAD) return false;
  return regionDepthRms(plate, withDepth) <= MAX_AGREEMENT_RMS_M;
}

/** Stereo depth with at least this LR-consistent fraction counts as measured (tier A allowed). */
const STEREO_MEASURED_MIN_CONFIDENCE = 0.8;

export function capTierForEstimatedDepth(plate: BackgroundPlate, verified: EditableObject, frames: readonly CameraFrame[]): CappedResult {
  // Stereo depth is a measurement (triangulated, metric); a well-covered stereo frame is treated
  // like a sensor frame, a sparse one like monocular (tier B cap).
  const sources = new Set(
    frames.map((f) => {
      if (!f.depth) return 'none';
      const src = f.depthSource ?? 'sensor';
      if (src === 'stereo') return (f.depthConfidence ?? 0) >= STEREO_MEASURED_MIN_CONFIDENCE ? 'sensor' : 'monocular';
      // ZED SDK depth is a calibrated measurement (tier A allowed) unless the frame was mostly holes.
      if (src === 'zed-sdk') return (f.depthConfidence ?? 0) >= STEREO_MEASURED_MIN_CONFIDENCE ? 'sensor' : 'monocular';
      return src;
    }),
  );
  const allSensor = frames.length > 0 && [...sources].every((s) => s === 'sensor');
  if (allSensor) return { plate, tier: verified.tier, confidence: verified.tierConfidence, cap: 'none' };

  const onlyMonocular = frames.length > 0 && [...sources].every((s) => s === 'monocular' || s === 'sensor');
  if (onlyMonocular && multiViewAgreement(plate, frames)) {
    return { plate, tier: verified.tier, confidence: verified.tierConfidence, cap: 'none' };
  }

  const cap: EditTier = onlyMonocular ? 'B' : 'C';
  const tier = worstTier(verified.tier, cap);
  let capped = plate;
  if (cap === 'B' && plate.provenance === 'observed_clean_plate') {
    capped = { ...plate, provenance: 'multi_view_observed', version: 'fused_v2' };
  } else if (cap === 'C' && (plate.provenance === 'observed_clean_plate' || plate.provenance === 'multi_view_observed')) {
    capped = { ...plate, provenance: 'constrained_surface', version: 'fused_v2' };
  }
  return { plate: capped, tier, confidence: Math.min(verified.tierConfidence, 0.8), cap };
}
