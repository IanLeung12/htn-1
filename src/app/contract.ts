/**
 * Application entry contract. `src/app/main.ts` implements `startApp`.
 * The production page (index.html) and the simulator page (sim.html) both call it;
 * the simulator installs the IWER runtime *before* calling it.
 */
import type { PerfTracker, QualityManager, SceneStore, FreshnessBus } from '@/core/api';
import type { Pose, QualityDecision, SceneSnapshot, Vec3 } from '@/core/types';
import type { CatalogEntry } from './catalog';

/**
 * Guided multi-viewpoint capture UI state (see src/app/guide.ts). Rendered by
 * the HUD as a floor marker + hint text so a user standing in front of the
 * real object knows where to move next. `step`/`total` are 1-based/inclusive
 * while `active`; both are 0 when inactive.
 */
export interface CaptureGuide {
  active: boolean;
  objectId: string | null;
  step: number;
  total: number;
  targetPose: Pose | null;
  hint: string;
}

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
  /**
   * Guided orbit capture of the whole room (8 viewpoints around the centre
   * looking outward at the walls, plus 4 looking down at the floor), stored
   * under `ROOM_SHELL_FRAME_ID` in the shared FrameStore so captured-shell
   * mode can texture surfaces from the nearest real viewpoint instead of a
   * flat color (see src/render/shell.ts). Optional: only meaningful once a
   * camera source and known surfaces exist.
   */
  captureRoomShell?(): Promise<{ framesCaptured: number }>;
  /** Grab an object by id with the given hand (test/voice path; same resolver). */
  grab(objectId: string, hand: 'left' | 'right'): boolean;
  release(hand: 'left' | 'right'): void;
  /**
   * Report dynamic-obstruction evidence ("a person/hand/pet crossed here") at
   * a world-space point, for whichever region(s) contain it. Same evidence
   * path the frame loop feeds automatically from hand/head positions; this
   * is the one-shot version for tests and the voice layer. Optional only for
   * backwards compatibility with older AppHandle consumers/mocks.
   */
  reportObstruction?(point: Vec3): void;
  /** Guided multi-viewpoint clean-plate capture UI state; see src/app/guide.ts. */
  readonly guide?: CaptureGuide;
  dispose(): void;
  /**
   * Voice command layer (src/app/voice.ts), wired up by src/app/voice-install.ts.
   * Optional: undefined until main.ts wires it in, so tests/simulator can
   * feature-detect it (see tests/e2e/voice.spec.ts).
   */
  voice?: { submitText(text: string): void; listening: boolean };
  /**
   * Spawnable 3D asset catalog (src/app/catalog.ts). Optional: undefined
   * until main.ts wires it in, same convention as `voice`/`guide`.
   */
  readonly catalog?: readonly CatalogEntry[];
  /**
   * Spawn a catalog asset by entry id (src/app/spawn.ts's `spawnAsset`), 0.7m
   * in front of the current head pose. Returns the new object's id, or null
   * if the entry id is unrecognized or the resolver rejected the spawn.
   * Optional: undefined until main.ts wires it in (see src/app/spawn.ts).
   */
  spawnAsset?(entryId: string): string | null;
  /**
   * Room anchor status (src/xr/anchors.ts's RoomAnchor), for diagnostics and
   * tests that need to wait for localization before editing an anchored
   * object (spawned/physical objects carry `anchorId: 'room-anchor'`, and the
   * resolver rejects edits to them with `anchor_lost` until this is
   * localized - see src/core/resolver.ts). Optional for backwards
   * compatibility with older AppHandle consumers/mocks.
   */
  readonly anchorStatus?: { localized: boolean; relocalizationMs: number | null; hasPersistentHandle: boolean };
}

export type StartApp = (options?: AppOptions) => Promise<AppHandle>;

declare global {
  interface Window {
    /** Set by src/app/main.ts so tests and the simulator can reach the app. */
    __realityEditor?: AppHandle;
  }
}
