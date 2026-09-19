/**
 * PoseSource from the ZED SDK's positional tracking (bridge header.pose).
 *
 * Frames: the SDK runs in RIGHT_HANDED_Y_UP / METER, the same axes as the app
 * world (x right, y up, camera looks along -z), so the matrix is used as-is.
 * The floor: the bridge puts the tracking origin on the SDK-detected floor
 * (`set_floor_as_origin`), so header.floorY is 0 and the camera's y is its
 * height above it. That fit lands on a desk or a wall when the camera does
 * not see real floor, so the SDK floor is trusted only when the resulting
 * camera height agrees with the tuning height (mode 'sdk'). Otherwise the
 * tuning height is applied as an offset (mode 'tuning') until the surface
 * estimator reports the dominant horizontal plane seen in the depth, which
 * then becomes y = 0 (mode 'plane', `applyGroundPlane`).
 *
 * trackingOk follows the SDK's state ('OK') and drops when the bridge goes
 * quiet for `staleMs`.
 */
import type { Millis, Pose } from '@/core/types';
import type { PoseQuality, PoseSource } from '../contract';
import type { ZedBridgeClient, DecodedBridgeFrame } from './bridge-client';
import { poseFromColumnMajor } from './protocol';

export interface ZedSdkPoseSourceOptions {
  /** Assumed camera height (m) used only while the SDK has no floor. */
  cameraHeightM: number;
  /** Frames older than this (ms) drop trackingOk. Default 500. */
  staleMs?: number;
}

/** The SDK floor is believed when the camera height it implies is within this of the tuning height. */
const SDK_FLOOR_TOLERANCE_M = 0.35;
/** A depth-fitted ground plane needs at least this confidence / inlier count / extent before it moves the floor. */
const PLANE_MIN_CONFIDENCE = 0.5;
const PLANE_MIN_INLIERS = 500;
const PLANE_MIN_EXTENT_M = 0.5;
/** Ground-plane updates smaller than this are ignored (no per-run jitter of the whole world). */
const PLANE_MIN_CHANGE_M = 0.03;

export class ZedSdkPoseSource implements PoseSource {
  pose: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
  readonly quality: PoseQuality = { mode: 'tracked', confidence: 0, trackingOk: false, driftM: 0, sampleAgeMs: Infinity };
  /** Last tracking state string from the bridge ('OK', 'SEARCHING', 'OFF', ...). */
  trackingState = 'OFF';
  /** Vertical offset added to the SDK pose so the floor is at y = 0. */
  floorOffsetM = 0;
  /** How the floor was established: 'sdk' (SDK floor origin, plausible), 'tuning' (assumed height), 'plane' (dominant depth plane). */
  floorMode: 'unknown' | 'sdk' | 'tuning' | 'plane' = 'unknown';
  private cameraHeightM: number;
  private readonly staleMs: number;
  private lastFrameAt = -Infinity;
  private rawPose: Pose | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly client: ZedBridgeClient, opts: ZedSdkPoseSourceOptions) {
    this.cameraHeightM = opts.cameraHeightM;
    this.staleMs = opts.staleMs ?? 500;
    this.pose.position.y = opts.cameraHeightM;
  }

  /** The tuning height: only matters while the SDK has not established the floor. */
  setHeight(h: number): void {
    this.cameraHeightM = h;
    if (this.floorMode === 'tuning' && this.rawPose) this.floorOffsetM = h - this.rawPose.position.y;
  }

  /** Reset the SDK's tracking origin to the current camera pose. */
  reset(): void {
    this.client.resetTracking();
    this.floorMode = 'unknown';
    this.floorOffsetM = 0;
  }

  async start(): Promise<void> {
    this.unsubscribe = this.client.onFrame(this.onFrame);
  }

  private onFrame = (frame: DecodedBridgeFrame): void => {
    const { header } = frame;
    this.trackingState = header.trackingState;
    this.lastFrameAt = frame.receivedAt;
    if (header.trackingState !== 'OK') return;
    const raw = poseFromColumnMajor(header.pose);
    this.rawPose = raw;
    if (this.floorMode === 'unknown') {
      const sdkHeight = header.floorY === null ? null : raw.position.y - header.floorY;
      if (sdkHeight !== null && Math.abs(sdkHeight - this.cameraHeightM) <= SDK_FLOOR_TOLERANCE_M) {
        this.floorMode = 'sdk';
        this.floorOffsetM = -header.floorY!;
      } else {
        this.floorMode = 'tuning';
        this.floorOffsetM = this.cameraHeightM - raw.position.y;
      }
    } else if (this.floorMode === 'sdk' && header.floorY !== null) {
      this.floorOffsetM = -header.floorY;
    }
    this.pose = { position: { x: raw.position.x, y: raw.position.y + this.floorOffsetM, z: raw.position.z }, rotation: raw.rotation };
  };

  /**
   * The surface estimator's dominant horizontal plane, at world y `groundY` (in the frame this
   * source currently publishes). Unless the SDK floor was plausible, that plane becomes y = 0 when
   * it can be the floor (camera height above it within the tolerance of the tuning height); a desk
   * right under the camera is left to the estimator as a table instead.
   */
  applyGroundPlane(groundY: number, confidence: number, inliers: number, extentM: number): void {
    if (this.floorMode === 'sdk' || this.floorMode === 'unknown' || !this.rawPose) return;
    if (!(confidence >= PLANE_MIN_CONFIDENCE) || inliers < PLANE_MIN_INLIERS || extentM < PLANE_MIN_EXTENT_M) return;
    const heightAbovePlane = this.rawPose.position.y + this.floorOffsetM - groundY;
    if (Math.abs(heightAbovePlane - this.cameraHeightM) > SDK_FLOOR_TOLERANCE_M) return;
    const rawPlaneY = groundY - this.floorOffsetM;
    const target = -rawPlaneY;
    if (this.floorMode === 'plane' && Math.abs(target - this.floorOffsetM) < PLANE_MIN_CHANGE_M) return;
    this.floorOffsetM = this.floorMode === 'plane' ? this.floorOffsetM + 0.5 * (target - this.floorOffsetM) : target;
    this.floorMode = 'plane';
    if (this.rawPose) this.pose = { position: { x: this.rawPose.position.x, y: this.rawPose.position.y + this.floorOffsetM, z: this.rawPose.position.z }, rotation: this.rawPose.rotation };
  }

  update(now: Millis): void {
    const age = now - this.lastFrameAt;
    this.quality.sampleAgeMs = age;
    const fresh = age <= this.staleMs;
    const ok = fresh && this.trackingState === 'OK';
    this.quality.trackingOk = ok;
    this.quality.confidence = ok ? 0.95 : this.trackingState === 'SEARCHING' ? 0.3 : 0;
    this.quality.driftM = ok ? 0.01 : 0.1;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
