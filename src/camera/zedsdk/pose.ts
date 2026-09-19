/**
 * PoseSource from the ZED SDK's positional tracking (bridge header.pose).
 *
 * Frames: the SDK runs in RIGHT_HANDED_Y_UP / METER, the same axes as the app
 * world (x right, y up, camera looks along -z), so the matrix is used as-is.
 * The floor: the bridge puts the tracking origin on the SDK-detected floor
 * (`set_floor_as_origin`), so header.floorY is 0 and the camera's y is its
 * true height. When the floor is unknown (floorY null, or the origin visibly
 * sits at the camera because the SDK found no floor) the initial camera
 * height from tuning is used instead: an offset makes the first tracked pose
 * sit at y = cameraHeightM.
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

/** A tracking origin within this distance of the first pose's y means the SDK did not put the origin on the floor. */
const FLOOR_ORIGIN_MIN_HEIGHT_M = 0.1;

export class ZedSdkPoseSource implements PoseSource {
  pose: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
  readonly quality: PoseQuality = { mode: 'tracked', confidence: 0, trackingOk: false, driftM: 0, sampleAgeMs: Infinity };
  /** Last tracking state string from the bridge ('OK', 'SEARCHING', 'OFF', ...). */
  trackingState = 'OFF';
  /** Vertical offset added to the SDK pose so the floor is at y = 0. */
  floorOffsetM = 0;
  /** How the floor was established: 'sdk' (floor-as-origin / floor plane) or 'tuning' (assumed height). */
  floorMode: 'unknown' | 'sdk' | 'tuning' = 'unknown';
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
      if (header.floorY !== null && (header.floorY !== 0 || raw.position.y > FLOOR_ORIGIN_MIN_HEIGHT_M)) {
        this.floorMode = 'sdk';
        this.floorOffsetM = -header.floorY;
      } else {
        this.floorMode = 'tuning';
        this.floorOffsetM = this.cameraHeightM - raw.position.y;
      }
    } else if (this.floorMode === 'sdk' && header.floorY !== null) {
      this.floorOffsetM = -header.floorY;
    }
    this.pose = { position: { x: raw.position.x, y: raw.position.y + this.floorOffsetM, z: raw.position.z }, rotation: raw.rotation };
  };

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
