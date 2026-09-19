/**
 * `PoseSource` backed by a ZED 2's IMU over WebHID: rotation comes from
 * `ZedImuAttitude`, position stays pinned at the configured height (no
 * translation estimate, same limitation as OrientationPoseSource/
 * StaticPoseSource - see src/camera/contract.ts). Also exports
 * `installZedImu`, a small DOM helper that adds a "Connect ZED IMU" button
 * (WebHID device selection requires a user gesture) and silently reconnects
 * to a previously-granted device on reload.
 *
 * See docs/general-camera/zed-imu.md for the two lines app.ts needs to wire
 * this in.
 */
import type { Millis, Pose } from '@/core/types';
import type { PoseSource, PoseQuality } from '@/camera/contract';
import { quatFromAxisAngle, quatMultiply, quatNormalize } from '@/core/math';
import { ZedImu } from './zed-imu';
import { ZedImuAttitude, type ZedImuAttitudeOptions } from './zed-imu-attitude';

export interface ZedImuPoseSourceOptions {
  /** Camera height above the floor, metres. */
  cameraHeightM: number;
  /** Forwarded to the internal `ZedImuAttitude` (axis map, filter tau, bump/stationary thresholds). */
  attitude?: ZedImuAttitudeOptions;
  /** How long (ms) `trackingOk` stays false after a bump (gyro norm > the attitude filter's `bumpGyroRadS`, default 0.3 rad/s). Default 300. */
  bumpRecoveryMs?: number;
  /** Injectable for tests; defaults to a fresh `ZedImu`. */
  imu?: ZedImu;
}

function computePose(heightM: number, pitchRad: number, rollRad: number, yawRad: number): Pose {
  // Matches StaticPoseSource's convention: pose = Ry(yaw) * Rx(pitch) * Rz(roll).
  const yawQuat = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, yawRad);
  const pitchQuat = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitchRad);
  const rollQuat = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, rollRad);
  return {
    position: { x: 0, y: heightM, z: 0 },
    rotation: quatNormalize(quatMultiply(yawQuat, quatMultiply(pitchQuat, rollQuat))),
  };
}

/**
 * Rotation-only pose from a ZED 2's IMU. Until a device is connected (via
 * `connect()` from a user gesture, or a silent `start()`-time reconnect to a
 * previously-granted device), `trackingOk` stays false and `confidence` 0 -
 * unlike `OrientationPoseSource`'s "no data yet, treat like static" default,
 * there's no reasonable default orientation for an external, unconnected
 * sensor to assume.
 */
export class ZedImuPoseSource implements PoseSource {
  private heightM: number;
  private readonly bumpRecoveryMs: number;
  readonly imu: ZedImu;
  private readonly attitudeFilter: ZedImuAttitude;
  private unsubscribe: (() => void) | null = null;
  private lastBumpAt: Millis | null = null;

  pose: Pose;
  readonly quality: PoseQuality = {
    mode: 'orientation',
    confidence: 0,
    trackingOk: false,
    driftM: 0,
    sampleAgeMs: Infinity,
  };

  constructor(opts: ZedImuPoseSourceOptions) {
    this.heightM = opts.cameraHeightM;
    this.bumpRecoveryMs = opts.bumpRecoveryMs ?? 300;
    this.imu = opts.imu ?? new ZedImu();
    this.attitudeFilter = new ZedImuAttitude(opts.attitude);
    this.pose = computePose(this.heightM, 0, 0, 0);
  }

  setHeight(h: number): void {
    this.heightM = h;
  }

  /** Wires the sample subscription and attempts a silent (no-gesture) reconnect to a previously-granted device. Never throws - a failed reconnect just leaves `trackingOk` false. */
  async start(): Promise<void> {
    this.unsubscribe ??= this.imu.onSample((s) => this.attitudeFilter.update(s));
    try {
      await this.imu.connectToGrantedDevice();
    } catch {
      // No previously-granted device, or WebHID unavailable: fine, `connect()`
      // (from a user gesture) is still available via installZedImu's button.
    }
  }

  /**
   * Request device access - **must** be called from a user-gesture handler
   * (see `ZedImu.connect()`). Exposed separately from `start()` because
   * `PoseSource.start()` is called automatically during app setup, long
   * before any click has happened.
   */
  async connect(): Promise<void> {
    this.unsubscribe ??= this.imu.onSample((s) => this.attitudeFilter.update(s));
    await this.imu.connect();
  }

  update(now: Millis): void {
    const { pitchRad, rollRad, yawRad, confidence } = this.attitudeFilter.attitude;
    this.pose = computePose(this.heightM, pitchRad, rollRad, yawRad);

    const bumping = this.attitudeFilter.motionMagnitudeRadS > this.attitudeFilter.bumpGyroRadS;
    if (bumping) this.lastBumpAt = now;
    const recentBump = this.lastBumpAt !== null && now - this.lastBumpAt < this.bumpRecoveryMs;

    const lastSampleAt = this.imu.stats.lastSampleAt;
    const sampleAgeMs = Number.isFinite(lastSampleAt) ? now - lastSampleAt : Infinity;

    this.quality.trackingOk = this.imu.connected && !recentBump && Number.isFinite(sampleAgeMs);
    this.quality.confidence = this.imu.connected ? confidence : 0;
    this.quality.sampleAgeMs = sampleAgeMs;
    // No translation estimate at all (position is pinned), so there's no
    // registration-drift number to report beyond what confidence already covers.
    this.quality.driftM = 0;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.imu.disconnect();
  }
}

// ---------------------------------------------------------------------------
// DOM wiring: "Connect ZED IMU" button
// ---------------------------------------------------------------------------

/**
 * Adds a "Connect ZED IMU" button (plus a small status label) to
 * `landingCard`. WebHID's `requestDevice` must run inside the click handler
 * itself (a user gesture), so this is the only place `poseSource.connect()`
 * is called from; `poseSource.start()` (called by whatever assembles the
 * active `PoseSource`, per the pose-source contract) separately attempts a
 * silent reconnect via `navigator.hid.getDevices()` on page load, which
 * this button's status label also reflects once that resolves.
 *
 * Returns a cleanup function that removes the button/label and their
 * listener.
 *
 * Elements are created via `landingCard.ownerDocument` (always the real
 * `document` for an actual `HTMLElement`) rather than the `document` global
 * directly, so tests can exercise this against a lightweight DOM stand-in
 * without pulling in jsdom (see tests/unit/zed-imu-pose-source.test.ts).
 */
export function installZedImu(landingCard: HTMLElement, poseSource: ZedImuPoseSource): () => void {
  const doc = landingCard.ownerDocument;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'zed-imu-connect-button';
  button.textContent = 'Connect ZED IMU';

  const status = doc.createElement('span');
  status.className = 'zed-imu-status';
  status.setAttribute('aria-live', 'polite');

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  const onClick = (): void => {
    button.disabled = true;
    setStatus('Requesting device...');
    poseSource
      .connect()
      .then(() => {
        button.textContent = 'Reconnect ZED IMU';
        setStatus(`Connected${poseSource.imu.deviceLabel ? ` to ${poseSource.imu.deviceLabel}` : ''}`);
      })
      .catch((err: unknown) => {
        setStatus(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        button.disabled = false;
      });
  };
  button.addEventListener('click', onClick);

  landingCard.appendChild(button);
  landingCard.appendChild(status);

  // Reflect a silent reconnect (triggered by poseSource.start(), which the
  // wiring code calls separately) once/if it lands.
  const reflectReconnect = (): void => {
    if (poseSource.imu.connected) {
      button.textContent = 'Reconnect ZED IMU';
      setStatus(`Reconnected${poseSource.imu.deviceLabel ? ` to ${poseSource.imu.deviceLabel}` : ''}`);
    }
  };
  const pollId = setInterval(reflectReconnect, 250);
  reflectReconnect();

  return () => {
    clearInterval(pollId);
    button.removeEventListener('click', onClick);
    button.remove();
    status.remove();
  };
}
