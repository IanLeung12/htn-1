/**
 * Complementary-filter attitude (pitch/roll/yaw) from `ZedImu` samples, plus
 * motion-magnitude ("camera bump") and stationary detection. See
 * docs/general-camera/zed-imu.md for the coordinate-frame derivation and the
 * IMU-axis-to-camera-frame calibration procedure.
 *
 * Camera-frame convention (matches src/camera/pose/static.ts and
 * orientation-math.ts): X right, Y up, Z backward (forward is -Z); pitch is
 * rotation about +X (negative pitch looks down, per StaticPoseSource), roll
 * about +Z, yaw about +Y.
 */
import type { Millis, Vec3 } from '@/core/types';
import type { ZedImuSample } from './zed-imu';

// ---------------------------------------------------------------------------
// IMU raw axes -> camera frame
// ---------------------------------------------------------------------------

type Axis = 'x' | 'y' | 'z';

interface AxisSource {
  axis: Axis;
  sign: 1 | -1;
}

/**
 * Maps each camera-frame axis to a (signed) raw IMU axis. This is a pure
 * permutation-with-signs (the IMU package is screwed to the camera body on
 * one of the 24 axis-aligned orientations), never a general rotation.
 */
export interface ImuAxisMap {
  x: AxisSource;
  y: AxisSource;
  z: AxisSource;
}

/**
 * **Best-effort default, not confirmed against real hardware.**
 * `zed-open-capture`'s README documents that raw IMU/magnetometer axes are
 * given in a "RAW coordinate system" shown in `images/imu_axis.jpg`
 * (https://github.com/stereolabs/zed-open-capture/blob/master/images/imu_axis.jpg)
 * - a diagram, not text, so it could not be transcribed here without a
 * device to cross-check against. Absent that confirmation this defaults to
 * the identity mapping (raw IMU X/Y/Z assumed aligned with camera X-right /
 * Y-up / Z-back) and the axis map is a constructor option specifically so
 * the wiring code can override it once someone has calibrated a real ZED 2
 * (see docs/general-camera/zed-imu.md, "Axis calibration procedure").
 */
export const DEFAULT_ZED2_AXIS_MAP: ImuAxisMap = {
  x: { axis: 'x', sign: 1 },
  y: { axis: 'y', sign: 1 },
  z: { axis: 'z', sign: 1 },
};

export function applyAxisMap(raw: Vec3, map: ImuAxisMap): Vec3 {
  const pick = (s: AxisSource): number => raw[s.axis] * s.sign;
  return { x: pick(map.x), y: pick(map.y), z: pick(map.z) };
}

// ---------------------------------------------------------------------------
// Attitude
// ---------------------------------------------------------------------------

export interface Attitude {
  /** Rotation about +X (camera frame); negative looks down (matches StaticPoseSource). */
  pitchRad: number;
  /** Rotation about +Z (camera frame). */
  rollRad: number;
  /** Rotation about +Y (camera frame); gyro-integrated only, so it drifts without bound. */
  yawRad: number;
  /** 0..1: how much to trust `pitchRad`/`rollRad` right now (yaw is never corrected, so it isn't reflected here beyond staleness). */
  confidence: number;
}

export interface ZedImuAttitudeOptions {
  /** Raw-IMU-axes -> camera-frame mapping; see `DEFAULT_ZED2_AXIS_MAP`. */
  axisMap?: ImuAxisMap;
  /**
   * Complementary-filter time constant (seconds) for the accel correction of
   * pitch/roll: `alpha = tau / (tau + dt)` blends `tau` seconds of gyro
   * integration against instantaneous accel-derived pitch/roll each sample.
   * Smaller = trusts accel more (converges faster, noisier under vibration);
   * larger = trusts the gyro integral more (smoother, drifts longer before
   * accel pulls it back). Default 0.2s.
   */
  tauS?: number;
  /** Expected gravity magnitude (m/s^2) for the "close enough to at-rest" gate below. Default 9.8189 (matches zed-imu.ts's ACC_SCALE). */
  gravityMps2?: number;
  /** |gyro| (rad/s) below which the camera counts as at-rest, gated by `stationaryWindowMs`. Default 0.02. */
  stationaryGyroRadS?: number;
  /** Peak-to-peak |accel| jitter (m/s^2) over the window below which the camera counts as at-rest. Default 0.05. */
  stationaryAccelJitterMps2?: number;
  /** Both gates above must hold for this long (ms) before `stationary` goes true. Default 500. */
  stationaryWindowMs?: number;
  /** |gyro| (rad/s) above which a sample counts as a "camera bump" (used by zed-imu-pose-source.ts). Default 0.3. */
  bumpGyroRadS?: number;
}

const DEFAULT_GRAVITY_MPS2 = 9.8189;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Pitch/roll from a specific-force reading, assuming the sensor is not
 * otherwise accelerating (so the reading is just the reaction to gravity).
 * See docs/general-camera/zed-imu.md for the derivation: with the
 * pose = Ry(yaw)*Rx(pitch)*Rz(roll) convention used throughout this camera
 * backend, at-rest accel = (g*cos(pitch)*sin(roll), g*cos(pitch)*cos(roll),
 * -g*sin(pitch)), independent of yaw (gravity doesn't care which way you're
 * facing).
 */
function pitchRollFromAccel(accel: Vec3): { pitchRad: number; rollRad: number } {
  const pitchRad = Math.atan2(-accel.z, Math.hypot(accel.x, accel.y));
  const rollRad = Math.atan2(accel.x, accel.y);
  return { pitchRad, rollRad };
}

/**
 * Complementary filter fusing gyro (integrated, drifts) and accel (levels,
 * but only valid at rest) into `attitude`. Also exposes `motionMagnitudeRadS`
 * (gyro norm - "camera bump" detection) and a `stationary` flag once both
 * gyro and accel jitter have been quiet for `stationaryWindowMs`.
 */
export class ZedImuAttitude {
  private readonly axisMap: ImuAxisMap;
  private readonly tauS: number;
  private readonly gravityMps2: number;
  private readonly stationaryGyroRadS: number;
  private readonly stationaryAccelJitterMps2: number;
  private readonly stationaryWindowMs: number;
  readonly bumpGyroRadS: number;

  private lastT: Millis | null = null;
  private quietSinceT: Millis | null = null;
  /** Rolling window of |accel| magnitudes, for the jitter gate. */
  private readonly accelMagWindow: { t: Millis; mag: number }[] = [];

  attitude: Attitude = { pitchRad: 0, rollRad: 0, yawRad: 0, confidence: 0 };
  motionMagnitudeRadS = 0;
  stationary = false;

  constructor(opts: ZedImuAttitudeOptions = {}) {
    this.axisMap = opts.axisMap ?? DEFAULT_ZED2_AXIS_MAP;
    this.tauS = opts.tauS ?? 0.2;
    this.gravityMps2 = opts.gravityMps2 ?? DEFAULT_GRAVITY_MPS2;
    this.stationaryGyroRadS = opts.stationaryGyroRadS ?? 0.02;
    this.stationaryAccelJitterMps2 = opts.stationaryAccelJitterMps2 ?? 0.05;
    this.stationaryWindowMs = opts.stationaryWindowMs ?? 500;
    this.bumpGyroRadS = opts.bumpGyroRadS ?? 0.3;
  }

  /** Reset the filter to a known attitude (e.g. once at-rest calibration determines a bias/offset). Yaw defaults to 0 ("forward" at reset time). */
  reset(initial: Partial<Attitude> = {}): void {
    this.attitude = {
      pitchRad: initial.pitchRad ?? 0,
      rollRad: initial.rollRad ?? 0,
      yawRad: initial.yawRad ?? 0,
      confidence: initial.confidence ?? 0,
    };
    this.lastT = null;
    this.quietSinceT = null;
    this.accelMagWindow.length = 0;
    this.motionMagnitudeRadS = 0;
    this.stationary = false;
  }

  update(sample: ZedImuSample): void {
    if (!sample.valid) return;
    const accel = applyAxisMap(sample.accel, this.axisMap);
    const gyro = applyAxisMap(sample.gyro, this.axisMap);
    const t = sample.t;

    this.motionMagnitudeRadS = Math.hypot(gyro.x, gyro.y, gyro.z);

    const dt = this.lastT === null ? 0 : Math.max(0, (t - this.lastT) / 1000);
    this.lastT = t;

    const accelPitchRoll = pitchRollFromAccel(accel);

    if (dt === 0) {
      // First sample: nothing to integrate against yet, so start levelled
      // from the accelerometer rather than at an arbitrary (0,0).
      this.attitude = { pitchRad: accelPitchRoll.pitchRad, rollRad: accelPitchRoll.rollRad, yawRad: this.attitude.yawRad, confidence: 0 };
    } else {
      const alpha = this.tauS / (this.tauS + dt);
      const gyroPitch = this.attitude.pitchRad + gyro.x * dt;
      const gyroRoll = this.attitude.rollRad + gyro.z * dt;
      const yaw = this.attitude.yawRad + gyro.y * dt;

      const pitchRad = alpha * gyroPitch + (1 - alpha) * accelPitchRoll.pitchRad;
      const rollRad = alpha * gyroRoll + (1 - alpha) * accelPitchRoll.rollRad;

      // Confidence: high when nearly stationary (the accel correction is
      // trustworthy - it's actually measuring gravity) and when |accel|
      // is close to 1g (large deviations mean the sensor is accelerating,
      // so the "pitch/roll from accel" derivation's premise doesn't hold).
      const accelMag = Math.hypot(accel.x, accel.y, accel.z);
      const gDeviation = Math.abs(accelMag - this.gravityMps2) / this.gravityMps2;
      const motionPenalty = clamp01(this.motionMagnitudeRadS / this.bumpGyroRadS);
      const confidence = clamp01(1 - motionPenalty) * clamp01(1 - gDeviation);

      this.attitude = { pitchRad, rollRad, yawRad: yaw, confidence };
    }

    this.updateStationary(t, accel);
  }

  private updateStationary(t: Millis, accel: Vec3): void {
    this.accelMagWindow.push({ t, mag: Math.hypot(accel.x, accel.y, accel.z) });
    const cutoff = t - this.stationaryWindowMs;
    while (this.accelMagWindow.length > 0 && this.accelMagWindow[0]!.t < cutoff) {
      this.accelMagWindow.shift();
    }

    const gyroQuiet = this.motionMagnitudeRadS < this.stationaryGyroRadS;
    let accelQuiet = false;
    if (this.accelMagWindow.length >= 2) {
      let min = Infinity;
      let max = -Infinity;
      for (const { mag } of this.accelMagWindow) {
        if (mag < min) min = mag;
        if (mag > max) max = mag;
      }
      accelQuiet = max - min < this.stationaryAccelJitterMps2;
    }

    if (!gyroQuiet || !accelQuiet) {
      this.quietSinceT = null;
      this.stationary = false;
      return;
    }
    if (this.quietSinceT === null) {
      this.quietSinceT = t;
    }
    this.stationary = t - this.quietSinceT >= this.stationaryWindowMs;
  }
}
