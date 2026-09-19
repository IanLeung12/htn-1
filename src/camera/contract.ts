/**
 * General-camera backend contract (see docs/general-camera/architecture.md).
 *
 * A phone/laptop webcam, a USB camera, or a recorded video has none of the
 * signals WebXR gives us for free (tracked pose, planes, depth), so each one
 * is an *estimate* produced off the frame loop and published with a
 * confidence. Everything here is plain data + small interfaces; the
 * implementations live next to this file, and `src/camera/app.ts` wires them
 * into the same store/resolver/renderers the WebXR path uses.
 */
import type { Millis, Pose, Surface } from '@/core/types';
import type { DetectedVolume } from '@/capture/contract';

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** Pinhole intrinsics of the video. `fovY` is a user/device setting, not measured. */
export interface CameraIntrinsics {
  /** Vertical field of view in radians. */
  fovY: number;
  /** width / height of the video frames. */
  aspect: number;
  width: number;
  height: number;
}

/** A downscaled RGBA grab of the newest video frame. */
export interface GrabbedFrame {
  width: number;
  height: number;
  /** RGBA8, row-major, top row first (same convention as capture/contract.ts). */
  rgba: Uint8ClampedArray;
  timestamp: Millis;
}

export type FrameSourceKind = 'camera' | 'file' | 'url';

export interface FrameSource {
  readonly kind: FrameSourceKind;
  /** The element that shows the live video; the render backend places it under the canvas. */
  readonly video: HTMLVideoElement;
  /** True once the video has dimensions and is playing. */
  readonly ready: boolean;
  readonly intrinsics: CameraIntrinsics;
  /** Timestamp of the newest frame `grab` could return (video.currentTime based). */
  readonly lastFrameAt: Millis;
  start(): Promise<void>;
  stop(): void;
  /**
   * Copy the newest video frame into an RGBA buffer no wider than `maxWidth`
   * (aspect preserved). Returns null before `ready`. Synchronous and cheap
   * (one drawImage + getImageData on a small canvas); callers throttle.
   */
  grab(maxWidth: number): GrabbedFrame | null;
  /** Update the assumed vertical field of view (radians); intrinsics reflect it immediately. */
  setFovY(fovY: number): void;
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

export type DepthBackend = 'webgpu' | 'wasm' | 'analytic' | 'none';
export type DepthSource = 'sensor' | 'monocular' | 'plane-prior';

/**
 * Relative inverse depth from a monocular model plus the affine fit that maps
 * it to metres: metric = 1 / (scale * inverse + shift). Analytic (plane-prior)
 * maps store metres directly in `metric` and leave `inverse` empty.
 */
export interface DepthMap {
  width: number;
  height: number;
  /** Per-pixel metric depth (metres along the camera forward axis), row-major, top row first. */
  metric: Float32Array;
  /** 0..1: how much to trust `metric` (model + fit quality); 0 for a bare plane prior far from the floor. */
  confidence: number;
  source: DepthSource;
  /** Pose the frame that produced this map was taken from. */
  pose: Pose;
  /** Intrinsics of the frame that produced this map. */
  fovY: number;
  aspect: number;
  timestamp: Millis;
}

export interface DepthStatus {
  state: 'idle' | 'loading' | 'ready' | 'unavailable';
  backend: DepthBackend;
  modelId: string | null;
  /** Wall-clock ms of the last inference; 0 if none yet. */
  lastInferenceMs: number;
  /** Why the estimator is unavailable, if it is. */
  error: string | null;
  /** Number of depth maps published so far. */
  frames: number;
  /** performance.now() of the newest published map; -Infinity if none. */
  lastPublishedAt: number;
  /** How the newest map was scaled to metres ('floor', 'temporal', 'last-fit', 'band', 'analytic', 'injected', 'none'). */
  fitMode: string;
}

export interface DepthEstimator {
  readonly status: DepthStatus;
  readonly latest: DepthMap | undefined;
  start(): Promise<void>;
  /**
   * Offer a frame (with the pose it was taken from). Returns false and drops
   * the frame when an inference is already in flight - the frame loop never
   * waits on this.
   */
  submit(frame: GrabbedFrame, pose: Pose, intrinsics: CameraIntrinsics): boolean;
  /**
   * Depth for a capture frame of `width x height` taken from `pose` right
   * now: the newest map resampled to that grid (model), or the analytic
   * floor-plane depth (prior). Null when nothing usable exists. Synchronous;
   * allocates one Float32Array per call (capture-time only, never per frame).
   */
  sample(width: number, height: number, pose: Pose, fovY: number, aspect: number): DepthSample | null;
  dispose(): void;
}

export interface DepthSample {
  metric: Float32Array;
  source: DepthSource;
  confidence: number;
  /** Per-frame depth agreement tolerance for the capture pipeline (CameraFrame.depthToleranceM). */
  toleranceM: number;
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

export type PoseMode = 'static' | 'orientation' | 'visual';

export interface PoseQuality {
  mode: PoseMode;
  /** 0..1 overall confidence in `pose` (orientation and position combined). */
  confidence: number;
  /** Feeds RuntimeConditions.trackingOk: false pauses every edit. */
  trackingOk: boolean;
  /** Estimated registration drift in metres (FrameSample.registrationErrorM). */
  driftM: number;
  /** Age of the newest sensor/visual sample in ms; Infinity if none. */
  sampleAgeMs: number;
}

export interface PoseSource {
  readonly pose: Pose;
  readonly quality: PoseQuality;
  /** Call once per rendered frame. */
  update(now: Millis): void;
  start(): Promise<void>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export interface EstimatedSurface {
  surface: Surface;
  /** 0..1 confidence in the plane fit (1 for a user-configured prior that nothing contradicts). */
  confidence: number;
  origin: 'prior' | 'ransac';
}

export interface SurfaceEstimator {
  readonly surfaces: readonly EstimatedSurface[];
  readonly volumes: readonly DetectedVolume[];
  /** Height of the camera above the floor (metres) as currently believed. */
  readonly cameraHeightM: number;
  /** Call once per rendered frame with the newest depth map (if any). */
  update(depth: DepthMap | undefined, pose: Pose, now: Millis): void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CameraAppConfig {
  source: FrameSourceKind;
  /** Video URL for kind 'url'. */
  url?: string;
  /** Camera height above the floor in metres. */
  cameraHeightM: number;
  /** Camera pitch in radians (negative looks down) for the static pose source. */
  pitchRad: number;
  /** Vertical field of view in radians. */
  fovY: number;
  /**
   * Pose source selection; 'auto' picks orientation on devices that report
   * it, else static. 'visual' additionally integrates a sparse
   * optical-flow rotation estimate onto whichever of those two the device
   * would otherwise get (see src/camera/pose/visual.ts). Every mode is
   * wrapped in a `VisualPoseSource` regardless (see createPoseSource); only
   * 'visual' turns on rotation integration, the rest use it purely to
   * detect motion the base source didn't report.
   */
  pose: 'auto' | 'static' | 'orientation' | 'visual';
  /** Depth estimator selection; 'auto' loads the model and falls back to the plane prior; 'injected' is a test seam. */
  depth: 'auto' | 'model' | 'prior' | 'none' | 'injected';
  /** Requested facing mode for getUserMedia. */
  facing: 'environment' | 'user';
}

export const DEFAULT_CAMERA_CONFIG: Readonly<CameraAppConfig> = {
  source: 'camera',
  cameraHeightM: 1.1,
  pitchRad: -0.35,
  fovY: (50 * Math.PI) / 180,
  pose: 'auto',
  depth: 'auto',
  facing: 'environment',
};
