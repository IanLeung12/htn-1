/**
 * Per-region state machine. Dynamic reality always wins: a verified
 * obstruction forces the region out of a pure captured-shell presentation,
 * and persistent loss of confidence pushes it all the way to FALLBACK
 * (live passthrough). Regions are immutable: every transition returns a new
 * Region object; `since` tracks when the current (state, reason) pair was
 * entered.
 */
import type { FallbackReason, Millis, Region, RegionState } from './types';
import type { RegionStateMachine } from './api';

export interface RegionStateMachineOptions {
  /** Depth age (ms) beyond which a HYBRID region under obstruction escalates to FALLBACK. */
  depthStaleMs?: number;
  /**
   * Obstruction evidence hold time (ms). Used two ways: (1) if obstruction is
   * reported continuously for this long, the region escalates HYBRID ->
   * FALLBACK; (2) if obstruction evidence stops arriving for this long, the
   * region returns to CAPTURED via TRANSITION.
   */
  obstructionHoldMs?: number;
}

function withState(region: Region, state: RegionState, reason: FallbackReason, now: Millis): Region {
  return { ...region, state, reason, since: now };
}

export function createRegionStateMachine(opts?: RegionStateMachineOptions): RegionStateMachine {
  const depthStaleMs = opts?.depthStaleMs ?? 150;
  const obstructionHoldMs = opts?.obstructionHoldMs ?? 500;

  // Internal bookkeeping keyed by region id. Not part of the public Region
  // shape - regions themselves stay plain, immutable data.
  const obstructionStart = new Map<string, Millis>();
  const lastObstruction = new Map<string, Millis>();

  function clearObstruction(id: string): void {
    obstructionStart.delete(id);
    lastObstruction.delete(id);
  }

  function isLegalRequest(from: RegionState, to: RegionState, reason: FallbackReason): boolean {
    if (from === to) return true;
    if (to === 'FALLBACK') return true; // anything -> FALLBACK always allowed
    if (from === 'FALLBACK' && to === 'LIVE') return true;
    if (from === 'LIVE' && to === 'CAPTURED') return reason === 'none';
    if (from === 'CAPTURED' && to === 'HYBRID') return true;
    if (from === 'HYBRID' && to === 'CAPTURED') return true;
    if (from === 'TRANSITION' && (to === 'CAPTURED' || to === 'HYBRID')) return true;
    return false;
  }

  return {
    request(region: Region, target: RegionState, reason: FallbackReason, now: Millis): Region {
      if (!isLegalRequest(region.state, target, reason)) {
        return region;
      }
      if (target !== 'HYBRID' && target !== 'FALLBACK') {
        clearObstruction(region.id);
      }
      if (region.state === target && region.reason === reason) {
        return region;
      }
      return withState(region, target, reason, now);
    },

    reportObstruction(region: Region, now: Millis): Region {
      const isObstructedHybrid = region.state === 'HYBRID' && region.reason === 'dynamic_obstruction';
      if (region.state !== 'CAPTURED' && !isObstructedHybrid) {
        // Obstruction evidence is only meaningful while showing a captured
        // shell (or already flagged as such); ignore it otherwise.
        return region;
      }

      if (!obstructionStart.has(region.id)) {
        obstructionStart.set(region.id, now);
      }
      lastObstruction.set(region.id, now);
      const start = obstructionStart.get(region.id) as Millis;

      if (isObstructedHybrid && now - start >= obstructionHoldMs) {
        // Obstruction has persisted too long for a hybrid presentation.
        return withState(region, 'FALLBACK', 'dynamic_obstruction', now);
      }

      if (region.state === 'CAPTURED') {
        return withState(region, 'HYBRID', 'dynamic_obstruction', now);
      }

      return region;
    },

    tick(region: Region, now: Millis, depthAgeMs: number, trackingOk: boolean): Region {
      if (!trackingOk) {
        if (region.state === 'FALLBACK' && region.reason === 'tracking_lost') {
          return region;
        }
        clearObstruction(region.id);
        return withState(region, 'FALLBACK', 'tracking_lost', now);
      }

      if (region.state === 'HYBRID' && region.reason === 'dynamic_obstruction') {
        if (depthAgeMs > depthStaleMs) {
          clearObstruction(region.id);
          return withState(region, 'FALLBACK', 'depth_stale', now);
        }
        const last = lastObstruction.get(region.id);
        if (last === undefined || now - last >= obstructionHoldMs) {
          clearObstruction(region.id);
          return withState(region, 'TRANSITION', 'evidence_expired', now);
        }
        return region;
      }

      if (region.state === 'FALLBACK' && region.reason === 'dynamic_obstruction') {
        const last = lastObstruction.get(region.id);
        if (last === undefined || now - last >= obstructionHoldMs) {
          clearObstruction(region.id);
          return withState(region, 'TRANSITION', 'evidence_expired', now);
        }
        return region;
      }

      if (region.state === 'TRANSITION' && region.reason === 'evidence_expired') {
        return withState(region, 'CAPTURED', 'none', now);
      }

      return region;
    },
  };
}

export default createRegionStateMachine;
