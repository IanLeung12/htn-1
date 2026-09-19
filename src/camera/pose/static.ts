/**
 * Fixed pose source: tripod/laptop camera at a known height and pitch. No
 * sensors, no DOM - pure data, so this runs identically under vitest node
 * and in the browser. See src/camera/contract.ts (PoseSource) and
 * docs/general-camera/architecture.md ("Abstractions", "Coordinate frame").
 */
import type { Pose, Millis } from '@/core/types';
import type { PoseSource, PoseQuality } from '@/camera/contract';
import { quatFromAxisAngle, quatMultiply, quatNormalize } from '@/core/math';

export interface StaticPoseSourceOptions {
  /** Camera height above the floor, metres. */
  cameraHeightM: number;
  /** Pitch in radians; negative looks down (see coordinate-frame doc). */
  pitchRad: number;
  /** Yaw in radians about +Y; defaults to 0 (looks along -Z). */
  yawRad?: number;
}

function computePose(heightM: number, pitchRad: number, yawRad: number): Pose {
  const yawQuat = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, yawRad);
  const pitchQuat = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitchRad);
  return {
    position: { x: 0, y: heightM, z: 0 },
    rotation: quatNormalize(quatMultiply(yawQuat, pitchQuat)),
  };
}

/**
 * A camera that never moves: fixed height, fixed pitch/yaw. Full confidence
 * in orientation (it's a setting, not measured) and `update` is a no-op -
 * the pose only changes via the explicit setters.
 */
export class StaticPoseSource implements PoseSource {
  private heightM: number;
  private pitchRad: number;
  private yawRad: number;

  pose: Pose;
  readonly quality: PoseQuality = {
    mode: 'static',
    confidence: 1,
    trackingOk: true,
    driftM: 0,
    sampleAgeMs: 0,
  };

  constructor(opts: StaticPoseSourceOptions) {
    this.heightM = opts.cameraHeightM;
    this.pitchRad = opts.pitchRad;
    this.yawRad = opts.yawRad ?? 0;
    this.pose = computePose(this.heightM, this.pitchRad, this.yawRad);
  }

  setHeight(h: number): void {
    if (h === this.heightM) return;
    this.heightM = h;
    this.pose = computePose(this.heightM, this.pitchRad, this.yawRad);
  }

  setPitch(rad: number): void {
    if (rad === this.pitchRad) return;
    this.pitchRad = rad;
    this.pose = computePose(this.heightM, this.pitchRad, this.yawRad);
  }

  setYaw(rad: number): void {
    if (rad === this.yawRad) return;
    this.yawRad = rad;
    this.pose = computePose(this.heightM, this.pitchRad, this.yawRad);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_now: Millis): void {
    // Nothing to do: pose only changes through the setters above.
  }

  async start(): Promise<void> {
    // No sensors/streams to acquire.
  }

  dispose(): void {
    // Nothing held.
  }
}
