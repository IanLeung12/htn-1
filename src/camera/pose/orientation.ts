/**
 * Phone-orientation pose source: `deviceorientation` events drive the
 * camera's rotation, position stays pinned at the configured height. See
 * src/camera/contract.ts (PoseSource) and docs/general-camera/architecture.md
 * ("Truthfulness contract" point 4 - staleness/loss drive `trackingOk`).
 */
import type { Millis, Pose, Quat } from '@/core/types';
import type { PoseSource, PoseQuality } from '@/camera/contract';
import { quatFromDeviceOrientation, removeYaw, yawOf } from './orientation-math';

export interface OrientationPoseSourceOptions {
  cameraHeightM: number;
  /** Age (ms) past which confidence starts falling. Default 1000. */
  staleAfterMs?: number;
  /** Age (ms) past which tracking is considered lost. Default 3000. */
  lostAfterMs?: number;
}

interface DeviceOrientationEventWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

function currentScreenOrientationDeg(): number {
  // Feature-detected: modern browsers expose screen.orientation.angle; some
  // older mobile browsers only have the legacy window.orientation. Neither
  // exists under vitest node, so both accesses are guarded.
  const w = globalThis as unknown as { screen?: { orientation?: { angle?: number } }; orientation?: number };
  return w.screen?.orientation?.angle ?? w.orientation ?? 0;
}

/**
 * Rotation-only pose from the device's orientation sensors. Position is held
 * at the configured height (no translation estimate). Before the first
 * sample ever arrives (e.g. running on a desktop that never fires
 * `deviceorientation`) `trackingOk` stays true with confidence 0.5, so the
 * app is still usable in a "no orientation data, treat like static" sense
 * rather than being permanently blocked - see architecture.md's
 * truthfulness contract, which only requires `trackingOk = false` once a
 * sample stream has gone stale, not when it never started.
 */
export class OrientationPoseSource implements PoseSource {
  private heightM: number;
  private readonly staleAfterMs: number;
  private readonly lostAfterMs: number;

  private lastAlphaDeg: number | undefined;
  private lastBetaDeg: number | undefined;
  private lastGammaDeg: number | undefined;
  private lastSampleAt: Millis | undefined;
  private yawOffsetRad: number | undefined;

  private readonly listener = (ev: DeviceOrientationEvent): void => {
    if (ev.alpha === null || ev.alpha === undefined) return;
    this.lastAlphaDeg = ev.alpha;
    this.lastBetaDeg = ev.beta ?? 0;
    this.lastGammaDeg = ev.gamma ?? 0;
    this.lastSampleAt = nowMs();
  };

  pose: Pose;
  readonly quality: PoseQuality = {
    mode: 'orientation',
    confidence: 0.5,
    trackingOk: true,
    driftM: 0,
    sampleAgeMs: Infinity,
  };

  constructor(opts: OrientationPoseSourceOptions) {
    this.heightM = opts.cameraHeightM;
    this.staleAfterMs = opts.staleAfterMs ?? 1000;
    this.lostAfterMs = opts.lostAfterMs ?? 3000;
    this.pose = { position: { x: 0, y: this.heightM, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
  }

  async start(): Promise<void> {
    const DOE = (globalThis as unknown as { DeviceOrientationEvent?: DeviceOrientationEventWithPermission })
      .DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      const result = await DOE.requestPermission();
      if (result !== 'granted') {
        throw new Error('Device orientation permission was not granted');
      }
    }
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('deviceorientation', this.listener);
    }
  }

  setHeight(h: number): void {
    this.heightM = h;
  }

  update(now: Millis): void {
    if (this.lastAlphaDeg === undefined || this.lastSampleAt === undefined) {
      // No sample yet: keep the pinned-down, low-confidence default pose.
      this.quality.sampleAgeMs = Infinity;
      this.quality.confidence = 0.5;
      this.quality.trackingOk = true;
      return;
    }

    const screenOrientationDeg = currentScreenOrientationDeg();
    let rotation: Quat = quatFromDeviceOrientation(
      this.lastAlphaDeg,
      this.lastBetaDeg ?? 0,
      this.lastGammaDeg ?? 0,
      screenOrientationDeg,
    );

    if (this.yawOffsetRad === undefined) {
      this.yawOffsetRad = yawOf(rotation);
    }
    rotation = removeYaw(rotation, this.yawOffsetRad);

    const position = { x: 0, y: this.heightM, z: 0 };
    if (
      this.pose.rotation.x !== rotation.x ||
      this.pose.rotation.y !== rotation.y ||
      this.pose.rotation.z !== rotation.z ||
      this.pose.rotation.w !== rotation.w ||
      this.pose.position.y !== position.y
    ) {
      this.pose = { position, rotation };
    }

    const age = now - this.lastSampleAt;
    this.quality.sampleAgeMs = age;
    this.quality.trackingOk = age < this.lostAfterMs;
    if (age <= this.staleAfterMs) {
      this.quality.confidence = 1;
    } else if (age >= this.lostAfterMs) {
      this.quality.confidence = 0;
    } else {
      this.quality.confidence = 1 - (age - this.staleAfterMs) / (this.lostAfterMs - this.staleAfterMs);
    }
  }

  dispose(): void {
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('deviceorientation', this.listener);
    }
  }
}

function nowMs(): Millis {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
