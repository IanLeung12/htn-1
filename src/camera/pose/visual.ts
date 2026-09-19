/**
 * PoseSource decorator: layers sparse optical-flow motion detection (and,
 * optionally, rotation integration) on top of a base pose source. See
 * src/camera/contract.ts (PoseSource, PoseQuality) and
 * docs/general-camera/architecture.md ("Abstractions" - VisualPoseRefiner,
 * "Truthfulness contract" item 4 - motion the orientation source didn't
 * report should drop `trackingOk`).
 */
import type { Millis, Pose, Quat } from '@/core/types';
import type { CameraIntrinsics, GrabbedFrame, PoseMode, PoseQuality, PoseSource } from '@/camera/contract';
import { quatFromAxisAngle, quatMultiply, quatNormalize } from '@/core/math';
import { FlowTracker, type FlowSummary } from './flow';

export interface VisualPoseSourceOptions {
  /**
   * When true, coherent flow accumulates a yaw/pitch offset composed onto
   * the base pose (use this to *refine* a sensor-less or drifting base).
   * When false, the tracker is used purely to detect motion the base
   * source didn't report (use this on a supposedly-static/orientation base
   * so `trackingOk` still drops if the camera gets bumped).
   */
  integrateRotation: boolean;
  /** Median flow magnitude (px) above which the camera is moving too much to trust the pose. Default 6. */
  motionLostPx?: number;
  /** Median flow magnitude (px) at/under which motion counts as settled. Default 1.5. */
  motionSettlePx?: number;
  /** Time (ms) motion must stay settled before `trackingOk` recovers. Default 500. */
  settleMs?: number;
  /** Clamp on |accumulated yaw| and |accumulated pitch| (rad). Default 1.2. */
  maxIntegratedRad?: number;
}

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Decorates a base `PoseSource` with a `FlowTracker`. The app calls
 * `pushFrame` whenever it grabs a video frame (5-10 Hz, independent of
 * `update`, which runs once per rendered frame). `update` reads whatever
 * `pushFrame` last computed; it never runs the tracker itself.
 */
export class VisualPoseSource implements PoseSource {
  /** The wrapped sensor/static source (so the app can adjust pitch/roll/height on it). */
  readonly base: PoseSource & { setHeight?(h: number): void };
  private readonly tracker = new FlowTracker();

  private readonly integrateRotation: boolean;
  private readonly motionLostPx: number;
  private readonly motionSettlePx: number;
  private readonly settleMs: number;
  private readonly maxIntegratedRad: number;

  private accumYaw = 0;
  private accumPitch = 0;
  private offsetQuat: Quat = IDENTITY_QUAT;
  private lastMotionLostAt: Millis | null = null;

  private _motionPx = 0;
  private _lastFlow: FlowSummary | null = null;

  pose: Pose;
  readonly quality: PoseQuality;

  constructor(base: PoseSource & { setHeight?(h: number): void }, opts: VisualPoseSourceOptions) {
    this.base = base;
    this.integrateRotation = opts.integrateRotation;
    this.motionLostPx = opts.motionLostPx ?? 6;
    this.motionSettlePx = opts.motionSettlePx ?? 1.5;
    this.settleMs = opts.settleMs ?? 500;
    this.maxIntegratedRad = opts.maxIntegratedRad ?? 1.2;

    this.pose = base.pose;
    this.quality = {
      mode: this.modeFor(base.quality.mode),
      confidence: base.quality.confidence,
      trackingOk: base.quality.trackingOk,
      driftM: base.quality.driftM,
      sampleAgeMs: base.quality.sampleAgeMs,
    };
  }

  get motionPx(): number {
    return this._motionPx;
  }

  get lastFlow(): FlowSummary | null {
    return this._lastFlow;
  }

  private modeFor(baseMode: PoseMode): PoseMode {
    return this.integrateRotation ? 'visual' : baseMode;
  }

  /** Feed the newest grabbed frame; the tracker runs synchronously (it's cheap - <=150 corners at <=160px wide). */
  pushFrame(frame: GrabbedFrame, intrinsics: CameraIntrinsics, now: Millis): void {
    const summary = this.tracker.push(frame, intrinsics);
    if (!summary) return;

    this._lastFlow = summary;
    this._motionPx = summary.medianMagnitudePx;

    if (this._motionPx > this.motionLostPx) {
      this.lastMotionLostAt = now;
    }

    if (this.integrateRotation) {
      const coherent = summary.coherence >= 0.6 && summary.tracked >= 20;
      if (coherent) {
        const rotation = this.tracker.lastRotation;
        if (rotation) {
          this.accumYaw = clamp(this.accumYaw + rotation.yawRad, -this.maxIntegratedRad, this.maxIntegratedRad);
          this.accumPitch = clamp(this.accumPitch + rotation.pitchRad, -this.maxIntegratedRad, this.maxIntegratedRad);
          this.offsetQuat = quatNormalize(
            quatMultiply(
              quatFromAxisAngle({ x: 0, y: 1, z: 0 }, this.accumYaw),
              quatFromAxisAngle({ x: 1, y: 0, z: 0 }, this.accumPitch),
            ),
          );
        }
      }
      // Incoherent flow (a bump, a moving subject filling the frame, etc.):
      // freeze the integrated offset rather than trusting the estimate.
    }
  }

  update(now: Millis): void {
    this.base.update(now);
    const basePose = this.base.pose;
    const rotation = this.integrateRotation
      ? quatNormalize(quatMultiply(this.offsetQuat, basePose.rotation))
      : basePose.rotation;

    if (
      this.pose.position !== basePose.position ||
      this.pose.rotation.x !== rotation.x ||
      this.pose.rotation.y !== rotation.y ||
      this.pose.rotation.z !== rotation.z ||
      this.pose.rotation.w !== rotation.w
    ) {
      this.pose = { position: basePose.position, rotation };
    }

    const motionLostRecently = this.lastMotionLostAt !== null && now - this.lastMotionLostAt < this.settleMs;
    const accumulatedRotationRad = Math.sqrt(this.accumYaw * this.accumYaw + this.accumPitch * this.accumPitch);

    this.quality.mode = this.modeFor(this.base.quality.mode);
    this.quality.trackingOk = this.base.quality.trackingOk && !motionLostRecently;
    this.quality.confidence =
      this.base.quality.confidence *
      (1 - Math.min(1, accumulatedRotationRad / this.maxIntegratedRad) * 0.5) *
      (motionLostRecently ? 0.3 : 1);
    // 1 m lever-arm heuristic: a small unmodeled rotation offset projects to
    // roughly that many metres of registration error at ~1 m from the
    // camera, which is the typical distance to an edited object.
    this.quality.driftM = accumulatedRotationRad * 1.0;
    this.quality.sampleAgeMs = this.base.quality.sampleAgeMs;
  }

  setHeight(h: number): void {
    this.base.setHeight?.(h);
  }

  resetIntegration(): void {
    this.accumYaw = 0;
    this.accumPitch = 0;
    this.offsetQuat = IDENTITY_QUAT;
  }

  async start(): Promise<void> {
    await this.base.start();
  }

  dispose(): void {
    this.base.dispose();
  }
}
