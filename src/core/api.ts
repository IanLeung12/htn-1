/**
 * Core API surface. Implemented in src/core, consumed by src/render, src/xr,
 * src/capture, src/sim. Pure TS - no DOM, no three.js.
 */
import type {
  DegradeReason,
  EditableObject,
  FrameSample,
  IntentEnvelope,
  Millis,
  PerfStats,
  QualityDecision,
  QualityTier,
  Region,
  RegionState,
  FallbackReason,
  ResolveResult,
  RuntimeConditions,
  SceneSnapshot,
  Stamped,
  Subsystem,
} from './types';

export type Unsubscribe = () => void;

/**
 * Versioned scene store. Snapshots are immutable; every commit produces a new
 * snapshot with version+1. Renderers read `current` once per frame and never
 * mix objects from two versions.
 */
export interface SceneStore {
  readonly current: SceneSnapshot;
  /** Apply an intent through the resolver and, on success, commit. */
  dispatch(envelope: IntentEnvelope, conditions: RuntimeConditions): ResolveResult;
  subscribe(listener: (snapshot: SceneSnapshot, applied: IntentEnvelope | null) => void): Unsubscribe;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Serialize the committed snapshot plus undo history for persistence. */
  serialize(): string;
  /** Replace state from a serialized blob. Returns false if it was rejected. */
  hydrate(blob: string): boolean;
}

/** Pure function: decide whether an intent may be applied and produce the next snapshot. */
export interface TransactionResolver {
  resolve(snapshot: SceneSnapshot, envelope: IntentEnvelope, conditions: RuntimeConditions): ResolveResult;
}

/**
 * Per-region state machine. Dynamic reality always wins: a verified obstruction
 * forces LIVE/FALLBACK regardless of how pretty the shell is.
 */
export interface RegionStateMachine {
  /** Ask for a transition; returns the state actually entered. */
  request(region: Region, target: RegionState, reason: FallbackReason, now: Millis): Region;
  /** Evidence that a person/hand/pet is inside the region right now. */
  reportObstruction(region: Region, now: Millis): Region;
  /** Called every frame; expires evidence and stale transitions. */
  tick(region: Region, now: Millis, depthAgeMs: number, trackingOk: boolean): Region;
}

/** Ring-buffer percentile tracker for frame timing etc. */
export interface PerfTracker {
  push(sample: FrameSample): void;
  stats(field: keyof Pick<FrameSample, 'frameMs' | 'depthAgeMs' | 'registrationErrorM'>): PerfStats;
  /** Number of samples currently held. */
  readonly size: number;
  /** Samples in insertion order (oldest first). */
  samples(): readonly FrameSample[];
  reset(): void;
}

/**
 * Watchdog + quality tier manager. Degrades from the bottom of the budget
 * hierarchy upward with hysteresis so the tier does not flap.
 */
export interface QualityManager {
  readonly decision: QualityDecision;
  /** Feed a frame sample; may change the decision. Returns the new decision. */
  observe(sample: FrameSample): QualityDecision;
  /** Force a tier (e.g. user or test). */
  force(tier: QualityTier | null, reason?: DegradeReason): QualityDecision;
  subscribe(listener: (decision: QualityDecision, previous: QualityDecision) => void): Unsubscribe;
  /** Log of every degradation/upgrade with its reason, newest last. */
  readonly history: readonly { at: Millis; from: QualityTier; to: QualityTier; reasons: DegradeReason[] }[];
}

/** Latest-coherent-value bus for asynchronous subsystems. */
export interface FreshnessBus {
  publish<T>(subsystem: Subsystem, stamped: Stamped<T>): void;
  /** Newest value for the subsystem; undefined if never published. */
  latest<T>(subsystem: Subsystem): Stamped<T> | undefined;
  /** Age in ms of the newest value, Infinity if none. */
  age(subsystem: Subsystem, now: Millis): number;
  /** True if newest value is newer than maxAgeMs and not from a scene version older than minVersion. */
  isFresh(subsystem: Subsystem, now: Millis, maxAgeMs: number, minVersion?: number): boolean;
}

export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Helper for resolver and UI: can this object do this action right now, and if not, why. */
export interface CapabilityCheck {
  allowed: boolean;
  reason?: string;
}

export interface ObjectQuery {
  /** Objects visible in the snapshot sorted by distance from a point. */
  nearest(snapshot: SceneSnapshot, point: { x: number; y: number; z: number }, maxDistance: number): EditableObject[];
}
