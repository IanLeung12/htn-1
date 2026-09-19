/**
 * Watchdog + quality tier manager. Degrades fast (one tier at a time, the
 * instant a watchdog trips) and recovers slow (only after a long run of
 * healthy samples), so the tier never flaps.
 */
import type { DegradeReason, FrameSample, Millis, QualityDecision, QualityTier } from './types';
import type { QualityManager, Unsubscribe } from './api';

export interface QualityManagerOptions {
  targetFrameMs?: number;
  /** Window (sample count) used for the frame-time p95 watchdog. */
  windowSize?: number;
  /** Consecutive thermal-throttled samples before degrading. */
  thermalFrames?: number;
  /** Consecutive healthy samples required before upgrading one tier. */
  recoverSamples?: number;
  /** Ceiling for automatic tier selection; tier 3 is reachable only via force(). */
  maxTier?: number;
}

const DEPTH_STALE_MS = 200;
const DEPTH_STALE_STREAK = 30;
const TRACKING_LOST_STREAK = 10;
const HAND_CONFIDENCE_STREAK = 15;
const HAND_CONFIDENCE_THRESHOLD = 0.3;
const DROPPED_FRAMES_BURST = 3;
const REGISTRATION_ERROR_LIMIT = 0.05;

function nearestRankP95(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = Math.ceil(0.95 * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return sorted[idx] as number;
}

function sameReasons(a: readonly DegradeReason[], b: readonly DegradeReason[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

function decisionsEqual(a: QualityDecision, b: QualityDecision): boolean {
  return (
    a.tier === b.tier &&
    a.allowCapturedShell === b.allowCapturedShell &&
    a.trustDepth === b.trustDepth &&
    sameReasons(a.reasons, b.reasons)
  );
}

export function createQualityManager(opts?: QualityManagerOptions): QualityManager {
  const targetFrameMs = opts?.targetFrameMs ?? 14.2;
  const windowSize = opts?.windowSize ?? 90;
  const thermalFrames = opts?.thermalFrames ?? 30;
  const recoverSamples = opts?.recoverSamples ?? 300;
  const maxTier = (opts?.maxTier ?? 2) as QualityTier;

  let autoTier: QualityTier = maxTier;
  let forcedTier: QualityTier | null = null;
  let forcedReason: DegradeReason | undefined;

  let trustDepth = true;
  let handBlocked = false;
  let consecutiveHealthy = 0;
  let lastAt: Millis = 0;
  let lastRegistrationOk = true;

  const frameWindow: number[] = [];
  let thermalCount = 0;
  let depthStaleCount = 0;
  let trackingLostCount = 0;
  let lowHandCount = 0;

  // Edge-detection latches: a watchdog degrades the tier once when it first
  // trips, not on every subsequent sample while it remains tripped (that is
  // what "degrade one tier" means - the persisting reason still shows up in
  // `reasons` every sample, but it does not keep sliding the tier down).
  let frameTimeTripped = false;
  let thermalTripped = false;
  let memoryTripped = false;
  let droppedTripped = false;

  const listeners = new Set<(decision: QualityDecision, previous: QualityDecision) => void>();
  const historyLog: { at: Millis; from: QualityTier; to: QualityTier; reasons: DegradeReason[] }[] = [];

  function computeAllowCapturedShell(tier: QualityTier): boolean {
    return tier >= 1 && trustDepth && !handBlocked && lastRegistrationOk;
  }

  let decision: QualityDecision = {
    tier: autoTier,
    reasons: [],
    allowCapturedShell: computeAllowCapturedShell(autoTier),
    trustDepth,
    at: 0,
  };

  function effectiveTier(): QualityTier {
    return forcedTier !== null ? forcedTier : autoTier;
  }

  function applyDecision(reasons: DegradeReason[], at: Millis): QualityDecision {
    const tier = effectiveTier();
    const next: QualityDecision = {
      tier,
      reasons,
      allowCapturedShell: computeAllowCapturedShell(tier),
      trustDepth,
      at,
    };
    const previous = decision;
    if (previous.tier !== next.tier) {
      historyLog.push({ at, from: previous.tier, to: next.tier, reasons });
    }
    decision = next;
    if (!decisionsEqual(previous, next)) {
      for (const listener of listeners) listener(next, previous);
    }
    return next;
  }

  return {
    get decision(): QualityDecision {
      return decision;
    },

    observe(sample: FrameSample): QualityDecision {
      lastAt = sample.t;

      frameWindow.push(sample.frameMs);
      if (frameWindow.length > windowSize) frameWindow.shift();
      const sortedWindow = [...frameWindow].sort((a, b) => a - b);
      const p95 = nearestRankP95(sortedWindow);

      thermalCount = sample.thermalThrottled ? thermalCount + 1 : 0;
      depthStaleCount = sample.depthAgeMs > DEPTH_STALE_MS ? depthStaleCount + 1 : 0;
      trackingLostCount = sample.trackingOk ? 0 : trackingLostCount + 1;
      lowHandCount = sample.handConfidence < HAND_CONFIDENCE_THRESHOLD ? lowHandCount + 1 : 0;

      trustDepth = depthStaleCount < DEPTH_STALE_STREAK;
      handBlocked = lowHandCount >= HAND_CONFIDENCE_STREAK;
      lastRegistrationOk = sample.registrationErrorM < REGISTRATION_ERROR_LIMIT;

      const reasons: DegradeReason[] = [];
      let shouldDegrade = false;

      const frameTimeBad = p95 > targetFrameMs;
      if (frameTimeBad) {
        reasons.push('frame_time');
        if (!frameTimeTripped) shouldDegrade = true;
      }
      frameTimeTripped = frameTimeBad;

      const thermalBad = thermalCount >= thermalFrames;
      if (thermalBad) {
        reasons.push('thermal');
        if (!thermalTripped) shouldDegrade = true;
      }
      thermalTripped = thermalBad;

      const memoryBad = sample.memoryPressure;
      if (memoryBad) {
        reasons.push('memory');
        if (!memoryTripped) shouldDegrade = true;
      }
      memoryTripped = memoryBad;

      const droppedBad = sample.droppedFrames >= DROPPED_FRAMES_BURST;
      if (droppedBad) {
        reasons.push('dropped_frames');
        if (!droppedTripped) shouldDegrade = true;
      }
      droppedTripped = droppedBad;

      if (!trustDepth) {
        reasons.push('depth_age');
      }
      if (handBlocked) {
        reasons.push('hand_confidence');
      }

      let forceZero = false;
      if (trackingLostCount >= TRACKING_LOST_STREAK) {
        reasons.push('tracking');
        forceZero = true;
      }

      if (forceZero) {
        autoTier = 0;
      } else if (shouldDegrade) {
        autoTier = Math.max(0, autoTier - 1) as QualityTier;
      }
      autoTier = Math.min(autoTier, maxTier) as QualityTier;

      const healthy = reasons.length === 0;
      if (healthy) {
        consecutiveHealthy += 1;
      } else {
        consecutiveHealthy = 0;
      }

      if (healthy && !shouldDegrade && !forceZero && autoTier < maxTier && consecutiveHealthy >= recoverSamples) {
        autoTier = (autoTier + 1) as QualityTier;
        consecutiveHealthy = 0;
      }

      return applyDecision(reasons, sample.t);
    },

    force(tier: QualityTier | null, reason?: DegradeReason): QualityDecision {
      forcedTier = tier;
      forcedReason = tier === null ? undefined : reason ?? 'manual';
      return applyDecision(forcedTier === null ? [] : [forcedReason as DegradeReason], lastAt);
    },

    subscribe(listener: (decision: QualityDecision, previous: QualityDecision) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    get history() {
      return historyLog;
    },
  };
}

export default createQualityManager;
