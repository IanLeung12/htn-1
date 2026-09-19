import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ZED2_AXIS_MAP,
  ZedImuAttitude,
  applyAxisMap,
} from '@/camera/pose/zed-imu-attitude';
import type { ZedImuSample } from '@/camera/pose/zed-imu';

const G = 9.8189;
const DEG2RAD = Math.PI / 180;

function sampleAt(t: number, accel: { x: number; y: number; z: number }, gyro: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): ZedImuSample {
  return { t, accel, gyro, temperatureC: 25, valid: true };
}

/** Feeds `n` samples `dtMs` apart, all with the same accel/gyro, starting at `startT`. Returns the ending time. */
function feed(filter: ZedImuAttitude, startT: number, dtMs: number, n: number, accel: { x: number; y: number; z: number }, gyro?: { x: number; y: number; z: number }): number {
  let t = startT;
  for (let i = 0; i < n; i++) {
    filter.update(sampleAt(t, accel, gyro));
    t += dtMs;
  }
  return t;
}

describe('applyAxisMap', () => {
  it('identity map (DEFAULT_ZED2_AXIS_MAP) passes vectors through unchanged', () => {
    const v = { x: 1, y: 2, z: 3 };
    expect(applyAxisMap(v, DEFAULT_ZED2_AXIS_MAP)).toEqual(v);
  });

  it('supports axis permutation and sign flips', () => {
    const v = { x: 1, y: 2, z: 3 };
    const map = { x: { axis: 'y' as const, sign: -1 as const }, y: { axis: 'z' as const, sign: 1 as const }, z: { axis: 'x' as const, sign: -1 as const } };
    expect(applyAxisMap(v, map)).toEqual({ x: -2, y: 3, z: -1 });
  });
});

describe('ZedImuAttitude: at rest, level', () => {
  it('gravity read as +g on camera Y (up), 0 on X/Z gives pitch=0, roll=0', () => {
    const filter = new ZedImuAttitude();
    feed(filter, 0, 10, 60, { x: 0, y: G, z: 0 }); // 600ms of level, stationary samples

    expect(filter.attitude.pitchRad).toBeCloseTo(0, 2);
    expect(filter.attitude.rollRad).toBeCloseTo(0, 2);
  });

  it('sets `stationary` true once gyro+accel have been quiet for the 500ms window', () => {
    const filter = new ZedImuAttitude();
    // Just under the window: still not stationary.
    let t = feed(filter, 0, 10, 40, { x: 0, y: G, z: 0 }); // 400ms
    expect(filter.stationary).toBe(false);

    // Cross the 500ms threshold.
    feed(filter, t, 10, 20, { x: 0, y: G, z: 0 }); // +200ms = 600ms total quiet
    expect(filter.stationary).toBe(true);
  });

  it('a gyro above the stationary threshold keeps `stationary` false even with perfectly still accel', () => {
    const filter = new ZedImuAttitude();
    feed(filter, 0, 10, 100, { x: 0, y: G, z: 0 }, { x: 0.1, y: 0, z: 0 }); // well above 0.02 rad/s
    expect(filter.stationary).toBe(false);
  });
});

describe('ZedImuAttitude: tilt convergence', () => {
  it('a 20deg pitch tilt converges to 20deg within 0.5deg after 1s of samples', () => {
    const filter = new ZedImuAttitude();
    // Establish a level baseline first (pitch/roll ~ 0).
    let t = feed(filter, 0, 10, 10, { x: 0, y: G, z: 0 });
    expect(filter.attitude.pitchRad).toBeCloseTo(0, 2);

    // Then hold the camera tilted 20deg (accel derived from this module's
    // own pitchRollFromAccel inverse: accel = (0, g*cos(pitch), -g*sin(pitch))).
    const pitch20 = 20 * DEG2RAD;
    const tiltedAccel = { x: 0, y: G * Math.cos(pitch20), z: -G * Math.sin(pitch20) };
    feed(filter, t, 10, 100, tiltedAccel); // 1s at 100Hz

    expect(filter.attitude.pitchRad * (180 / Math.PI)).toBeCloseTo(20, 0);
    expect(Math.abs(filter.attitude.pitchRad - pitch20) * (180 / Math.PI)).toBeLessThan(0.5);
  });

  it('a 20deg roll tilt converges to 20deg within 0.5deg after 1s of samples', () => {
    const filter = new ZedImuAttitude();
    let t = feed(filter, 0, 10, 10, { x: 0, y: G, z: 0 });

    const roll20 = 20 * DEG2RAD;
    const tiltedAccel = { x: G * Math.sin(roll20), y: G * Math.cos(roll20), z: 0 };
    feed(filter, t, 10, 100, tiltedAccel);

    expect(Math.abs(filter.attitude.rollRad - roll20) * (180 / Math.PI)).toBeLessThan(0.5);
  });
});

describe('ZedImuAttitude: gyro integration and yaw drift', () => {
  it('pure gyro rotation (no accel correction needed - level accel throughout) integrates pitch over time', () => {
    const filter = new ZedImuAttitude();
    // 0.5 rad/s about camera X for 200ms -> ~0.1 rad, with level-looking accel
    // magnitude (this is a synthetic/non-physical accel; it isolates the
    // gyro-integration term without engaging the accel correction target).
    feed(filter, 0, 10, 20, { x: 0, y: G, z: 0 }, { x: 0.5, y: 0, z: 0 });
    // Complementary filter blends toward the (here, still-level) accel target,
    // so this checks the sign/direction of integration rather than an exact value.
    expect(filter.attitude.pitchRad).toBeGreaterThan(0);
  });

  it('yaw integrates from gyro.y only and is never corrected by accel (drifts)', () => {
    const filter = new ZedImuAttitude();
    feed(filter, 0, 10, 100, { x: 0, y: G, z: 0 }, { x: 0, y: 0.05, z: 0 }); // 1s @ 0.05 rad/s about Y
    expect(filter.attitude.yawRad).toBeCloseTo(0.05 * 1, 2); // integral of a constant rate
  });

  it('motionMagnitudeRadS is the gyro norm', () => {
    const filter = new ZedImuAttitude();
    filter.update(sampleAt(0, { x: 0, y: G, z: 0 }, { x: 3, y: 4, z: 0 }));
    expect(filter.motionMagnitudeRadS).toBeCloseTo(5, 6);
  });
});

describe('ZedImuAttitude: confidence drops on a bump', () => {
  it('confidence is high near rest and drops when gyro exceeds bumpGyroRadS', () => {
    const filter = new ZedImuAttitude();
    feed(filter, 0, 10, 20, { x: 0, y: G, z: 0 }); // settle
    const restConfidence = filter.attitude.confidence;
    expect(restConfidence).toBeGreaterThan(0.8);

    filter.update(sampleAt(210, { x: 0, y: G, z: 0 }, { x: 1.0, y: 0, z: 0 })); // > default bumpGyroRadS (0.3)
    expect(filter.attitude.confidence).toBeLessThan(restConfidence);
    expect(filter.attitude.confidence).toBeLessThan(0.3);
  });

  it('confidence drops when |accel| deviates far from 1g (the camera is accelerating, not just tilted)', () => {
    const filter = new ZedImuAttitude();
    feed(filter, 0, 10, 20, { x: 0, y: G, z: 0 });
    const restConfidence = filter.attitude.confidence;

    filter.update(sampleAt(210, { x: 0, y: G * 3, z: 0 })); // 3g: real linear acceleration, not just gravity
    expect(filter.attitude.confidence).toBeLessThan(restConfidence);
  });
});

describe('ZedImuAttitude: invalid samples are ignored', () => {
  it('does not update attitude or timers for an invalid sample', () => {
    const filter = new ZedImuAttitude();
    feed(filter, 0, 10, 20, { x: 0, y: G, z: 0 });
    const before = { ...filter.attitude };
    filter.update({ t: 1000000, accel: { x: 99, y: 99, z: 99 }, gyro: { x: 99, y: 99, z: 99 }, valid: false });
    expect(filter.attitude).toEqual(before);
  });
});
