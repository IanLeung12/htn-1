/**
 * Capture pipeline contract. Implemented in src/capture, wired by src/app/main.ts.
 * Pure TS except for ImageData/canvas-free pixel buffers so it is unit-testable.
 */
import type { BackgroundPlate, EditableObject, Pose, SceneSnapshot, Surface, Vec3 } from '@/core/types';

/** A frame from whatever camera source exists. On device without camera access: none. */
export interface CameraFrame {
  width: number;
  height: number;
  /** RGBA8 pixels, row-major, top row first. */
  rgba: Uint8ClampedArray;
  /** Optional per-pixel depth in meters (same resolution), for clean-plate verification. */
  depth?: Float32Array;
  /** Camera pose in world space at capture time. */
  pose: Pose;
  /** Vertical field of view (rad) and aspect for projection. */
  fovY: number;
  aspect: number;
  timestamp: number;
  /**
   * Additive, optional (general-camera backend, docs/general-camera/architecture.md):
   * where `depth` came from. Absent means a measured sensor/simulator depth.
   */
  depthSource?: 'sensor' | 'monocular' | 'plane-prior' | 'stereo' | 'zed-sdk';
  /** 0..1 confidence in `depth` (absent = 1). */
  depthConfidence?: number;
  /** 0..1 confidence in `pose` (absent = 1). */
  poseConfidence?: number;
  /**
   * Per-frame tolerance (m) for treating a sampled depth as agreeing with a
   * projected point; absent = the pipeline default (0.05 m). Estimated depth
   * sets this wider so coverage is honest instead of silently zero.
   */
  depthToleranceM?: number;
  /**
   * Additive, optional (general-camera backend): true when `rgba` was NOT
   * observed as-is but fabricated, e.g. an object's silhouette inpainted
   * from the surrounding pixels (`src/camera/edit/inpaint.ts`). Absent means
   * an observed frame.
   */
  synthetic?: boolean;
}

export interface CameraFrameSource {
  readonly available: boolean;
  /**
   * Grab the newest frame; null if unavailable or not yet ready.
   * `viewpoint` is the pose the pipeline would like the frame taken from. A real
   * device can only capture from where the head is (the guide asks the user to move
   * there); the simulator renders from the requested pose directly.
   */
  capture(viewpoint?: Pose): Promise<CameraFrame | null>;
}

/** Raw detected geometry handed to discovery (already converted to plain data). */
export interface DetectedVolume {
  id: string;
  label: string;
  pose: Pose;
  /** Local-space half extents of the bounding box. */
  halfExtents: Vec3;
  /** Optional triangle mesh in local space. */
  vertices?: Float32Array;
  indices?: Uint32Array;
}

export interface CandidateObject {
  object: EditableObject;
  /** Why it was or was not proposed as editable (surface contact, size, label). */
  rationale: string;
  /** Predicted support surface id and exposed region when moved. */
  exposedRegion: BackgroundPlate['region'];
}

export interface CleanPlateRequest {
  object: EditableObject;
  supportSurface: Surface | undefined;
  /** Head poses to sample from; the pipeline will request frames at each. */
  viewpoints: Pose[];
}

export interface CleanPlateResult {
  plate: BackgroundPlate;
  object: EditableObject;
  /** Frames actually used. */
  framesUsed: number;
  /**
   * The captured frames themselves (subset of `CleanPlateRequest.viewpoints`
   * that actually returned a frame), so the renderer can reproject the real
   * background from the nearest one after the object moves/deletes (see
   * `FrameStore` in ./frame-store and `BackgroundHull` in src/render).
   */
  frames: CameraFrame[];
}

export interface CapturePipeline {
  /** Pass 1: propose candidates from detected volumes and known surfaces. */
  discover(volumes: DetectedVolume[], snapshot: SceneSnapshot): CandidateObject[];
  /**
   * Pass 2: acquire a clean plate for one approved object. If no camera source
   * is available the object is returned with tier E and an `unavailable` plate.
   */
  acquireCleanPlate(req: CleanPlateRequest, source: CameraFrameSource): Promise<CleanPlateResult>;
  /** Pass 3: verify from off-path viewpoints and assign the final tier. */
  verify(result: CleanPlateResult, offPathViewpoints: Pose[], source: CameraFrameSource): Promise<EditableObject>;
}

/** Plate textures are stored by ref; this registry maps refs to pixel data for the renderer. */
export interface PlateTextureRegistry {
  put(ref: string, frame: { width: number; height: number; rgba: Uint8ClampedArray }): void;
  get(ref: string): { width: number; height: number; rgba: Uint8ClampedArray } | undefined;
  delete(ref: string): void;
}
