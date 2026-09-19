/**
 * Application entry contract. `src/app/main.ts` implements `startApp`.
 * The production page (index.html) and the simulator page (sim.html) both call it;
 * the simulator installs the IWER runtime *before* calling it.
 */
import type { PerfTracker, QualityManager, SceneStore, FreshnessBus } from '@/core/api';
import type { Pose, QualityDecision, SceneSnapshot } from '@/core/types';

export interface XRFeatureReport {
  supported: boolean;
  /** Feature descriptors the session actually enabled. */
  enabled: string[];
  /** Feature descriptors requested but unavailable. */
  missing: string[];
  /** Blend mode reported by the session (alpha-blend means passthrough is live). */
  blendMode: XREnvironmentBlendMode | 'unknown';
  depthUsage?: 'cpu-optimized' | 'gpu-optimized';
  depthFormat?: string;
}

export interface AppOptions {
  /** Canvas container; defaults to document.body. */
  container?: HTMLElement;
  /** Skip the DOM enter button (tests call enterAR() directly). */
  headless?: boolean;
  /** Persist scene to storage under this key; undefined disables persistence. */
  persistKey?: string;
  /** Called every rendered XR frame with the head pose (world space). */
  onFrame?: (info: { time: number; headPose: Pose; snapshot: SceneSnapshot; decision: QualityDecision }) => void;
}

export interface AppHandle {
  store: SceneStore;
  perf: PerfTracker;
  quality: QualityManager;
  freshness: FreshnessBus;
  /** Request an immersive-ar session. Resolves after the first frame renders. */
  enterAR(): Promise<XRFeatureReport>;
  exitAR(): Promise<void>;
  readonly inSession: boolean;
  readonly features: XRFeatureReport | null;
  /**
   * Run the capture workflow on the surfaces/objects currently known from
   * plane/mesh detection. Returns ids of objects registered as candidates.
   */
  runCandidateDiscovery(): Promise<string[]>;
  /**
   * Guided clean-plate capture for one approved object. In the simulator this
   * produces an observed plate; on device without camera access it records
   * a scene_volume with Tier E and returns the tier.
   */
  captureCleanPlate(objectId: string): Promise<{ tier: string; coverage: number }>;
  /** Grab an object by id with the given hand (test/voice path; same resolver). */
  grab(objectId: string, hand: 'left' | 'right'): boolean;
  release(hand: 'left' | 'right'): void;
  dispose(): void;
  /**
   * Voice command layer (src/app/voice.ts), wired up by src/app/voice-install.ts.
   * Optional: undefined until main.ts wires it in, so tests/simulator can
   * feature-detect it (see tests/e2e/voice.spec.ts).
   */
  voice?: { submitText(text: string): void; listening: boolean };
}

export type StartApp = (options?: AppOptions) => Promise<AppHandle>;

declare global {
  interface Window {
    /** Set by src/app/main.ts so tests and the simulator can reach the app. */
    __realityEditor?: AppHandle;
  }
}
