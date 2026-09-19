/**
 * Extra tier cap for `Capture plate` on a SINGLE fixed camera (general-
 * camera backend, "Delete with a static camera", docs/general-camera). A
 * static-tripod capture never gets multi-view verification regardless of
 * how good the depth source is (`src/camera/tier-cap.ts` already handles the
 * monocular/plane-prior cases; this covers the remaining case where every
 * frame is "sensor"-sourced, e.g. a stereo backend, which
 * `capTierForEstimatedDepth` otherwise leaves uncapped because a measured
 * XR sensor is normally multi-angle-verified): tier B when the frames'
 * average `depthConfidence` is >= 0.8, tier C otherwise. Only ever
 * DOWNGRADES a tier - never raises one `capTierForEstimatedDepth` already
 * lowered.
 */
import type { EditTier } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import type { CappedResult } from '../tier-cap';

const TIER_ORDER: EditTier[] = ['A', 'B', 'C', 'D', 'E'];
const STEREO_CONFIDENCE_FOR_TIER_B = 0.8;

export function capTierForSingleViewpoint(capped: CappedResult, frames: readonly CameraFrame[]): CappedResult {
  if (capped.cap !== 'none') return capped; // tier-cap.ts already applied a cap (monocular/plane-prior).

  const measured = frames.filter((f) => f.depth && (f.depthSource === 'sensor' || f.depthSource === undefined));
  if (measured.length === 0) return capped;

  const avgConfidence = measured.reduce((sum, f) => sum + (f.depthConfidence ?? 1), 0) / measured.length;
  const cap: EditTier = avgConfidence >= STEREO_CONFIDENCE_FOR_TIER_B ? 'B' : 'C';
  const tier = TIER_ORDER.indexOf(capped.tier) >= TIER_ORDER.indexOf(cap) ? capped.tier : cap;
  if (tier === capped.tier) return capped;

  let plate = capped.plate;
  if (tier === 'B' && plate.provenance === 'observed_clean_plate') {
    plate = { ...plate, provenance: 'multi_view_observed', version: 'fused_v2' };
  } else if (tier === 'C' && (plate.provenance === 'observed_clean_plate' || plate.provenance === 'multi_view_observed')) {
    plate = { ...plate, provenance: 'constrained_surface', version: 'fused_v2' };
  }
  return { plate, tier, confidence: Math.min(capped.confidence, avgConfidence), cap };
}
