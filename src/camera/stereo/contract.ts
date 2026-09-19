/**
 * Stereo depth contract (ZED 2 and any side-by-side stereo source).
 *
 * Ownership split: the camera branch owns the frame source
 * (src/camera/stereo/zed-frame-source.ts: device/mode selection, left-eye
 * display, both eyes as RGBA grabs, calibration parsing/rectification maps in
 * zed-calib.ts) and the app wiring; the `zed-stereo-depth` branch owns the GPU
 * matcher and provides `createStereoDepthEstimator` matching this contract.
 * The matcher registers itself with `registerStereoDepth` (or the app imports
 * its module directly once merged); until then the app falls back to the
 * monocular estimator and diagnostics say "stereo matcher not available".
 *
 * INPUT per frame: `DepthEstimator.submit(frame, pose, intrinsics)` where
 * `frame` is a `GrabbedFrame` whose `rgba` is the LEFT eye and `right` the
 * RIGHT eye, both `width x height` (already downscaled to the work size by
 * the source; the source does NOT rectify - the matcher applies the maps from
 * `StereoCalibrationInput.rectifyMaps` on the GPU, scaling the lookup from
 * full-eye resolution to the frame size). Frames are top-row-first RGBA8.
 * `pose`, `intrinsics.fovY` are what the app believes about the camera at
 * grab time and are copied into the output map for unprojection.
 *
 * OUTPUT: `latest` is a DepthMap in METRES along the camera forward axis
 * (Z = fx * B / d), `source: 'stereo'`, `confidence` = fraction of pixels
 * that passed the left-right consistency check (holes carry metric 0);
 * `stats` feeds the diagnostics line
 * "stereo 336x188 d0..64 valid 83% 9 ms rectified SN25491304".
 * Tier policy (src/camera/tier-cap.ts): a stereo frame with confidence >= 0.8
 * counts as measured (tier A allowed), below that like monocular (cap B).
 */
import type { DepthEstimator, DepthMap } from '../contract';
import type { Pose } from '@/core/types';
import type { ZedCalibration, ZedResolution } from './zed-calib';

export type { DepthMap };

/** Rectification lookup maps at full eye resolution: 2 floats (sx, sy) per rectified pixel, per eye. */
export interface RectifyMaps {
  left: Float32Array;
  right: Float32Array;
  width: number;
  height: number;
  /** Rectified focal length / principal point (px at width x height). */
  fxRect: number;
  cxRect: number;
  cyRect: number;
}

export interface StereoCalibrationInput {
  /** Baseline in metres (ZED 2: 0.120). */
  baselineM: number;
  /** Focal length in px at the FULL eye size (rectified when maps exist, else nominal). */
  fxPx: number;
  /** Full eye size the fx/maps refer to. */
  eyeWidth: number;
  eyeHeight: number;
  /** Null = unrectified input: the matcher should search +-2 rows and report `rectified: false`. */
  rectifyMaps: RectifyMaps | null;
  /** Factory calibration this was derived from, for diagnostics; null for nominal values. */
  calibration: ZedCalibration | null;
  mode: ZedResolution;
  /** Serial / id for diagnostics. */
  calibrationId: string | null;
}

export interface StereoDepthStats {
  workWidth: number;
  workHeight: number;
  maxDisparity: number;
  /** Fraction of pixels that passed the left-right check on the newest map. */
  validFraction: number;
  /** Wall-clock ms for the newest map (passes + readback). */
  lastMs: number;
  rectified: boolean;
  /** 'webgl2' | 'cpu' | 'none' */
  backend: string;
}

export interface StereoDepthEstimator extends DepthEstimator {
  readonly stats: StereoDepthStats;
  /** Newest map (same as `latest`) plus the raw disparity if the implementation keeps it. */
  readonly latestDisparity?: { data: Float32Array; width: number; height: number } | undefined;
}

export interface CreateStereoDepthOptions {
  /** Shared WebGL2 context to use; the estimator creates its own offscreen one when absent. */
  gl?: WebGL2RenderingContext;
  /** Calibration for the CURRENT mode; re-read on every submit so mode switches take effect. */
  getCalibration: () => StereoCalibrationInput | undefined;
  /** Work width per eye (frames are grabbed at this width). Default 336 (half VGA). */
  workWidth?: number;
  /** Disparity range at the work width. Default 64 at 336 px, scaled with workWidth. */
  maxDisparity?: number;
  /** Tuning multiplier on fx (single-point distance calibration). Default () => 1. */
  fxScale?: () => number;
  /** Estimator to answer with while stereo is unavailable (monocular model / plane prior). */
  fallback?: DepthEstimator | null;
}

export type CreateStereoDepthEstimator = (opts: CreateStereoDepthOptions) => StereoDepthEstimator;

let factory: CreateStereoDepthEstimator | null = null;

/** Called by the stereo matcher module at import time (or by tests) to make itself available. */
export function registerStereoDepth(create: CreateStereoDepthEstimator): void {
  factory = create;
}

export function getStereoDepthFactory(): CreateStereoDepthEstimator | null {
  return factory;
}

/** Helper for implementations: the DepthMap fields the app expects filled from a submit call. */
export function stereoMapMeta(pose: Pose, fovY: number, width: number, height: number, timestamp: number): Pick<DepthMap, 'pose' | 'fovY' | 'aspect' | 'width' | 'height' | 'timestamp' | 'source'> {
  return { pose, fovY, aspect: width / height, width, height, timestamp, source: 'stereo' };
}
