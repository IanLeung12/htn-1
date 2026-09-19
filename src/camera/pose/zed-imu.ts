/**
 * ZED 2 IMU over WebHID: talks the same HID report protocol Stereolabs'
 * open-source `zed-open-capture` uses (see docs/general-camera/zed-imu.md
 * for citations and the exact byte layout). The ZED 2's sensors (IMU,
 * magnetometer, barometer) show up as a *separate* USB HID interface from
 * its UVC video interface:
 *
 *   VID 0x2B03 (Stereolabs), PID 0xF781 ("USB Input Device", vendor-defined
 *   HID usage) - the sensor MCU. The UVC camera itself is PID 0xF780 and is
 *   never touched here.
 *
 * No DOM assumptions beyond `navigator.hid` (WebHID); this is the sensor
 * driver only. `zed-imu-attitude.ts` fuses these samples into an
 * orientation and `zed-imu-pose-source.ts` wraps that into a `PoseSource`.
 */
import type { Millis, Vec3 } from '@/core/types';

/** Stereolabs USB vendor id (all ZED cameras). */
export const ZED_VENDOR_ID = 0x2b03;
/** ZED 2's sensor-MCU HID interface (distinct from the 0xF780 UVC video interface). */
export const ZED2_SENSOR_PRODUCT_ID = 0xf781;

// ---------------------------------------------------------------------------
// Protocol constants, mirrored from zed-open-capture's
// include/sensorcapture_def.hpp (usb::CUSTOMHID_REPORT_ID /
// CUSTOMHID_REQUEST_ID) and the scale factors next to them.
// ---------------------------------------------------------------------------

/** Input report: `usb::RawData` (sensor sample). */
export const REP_ID_SENSOR_DATA = 0x01;
/** Feature report: `RQ_CMD_PING` etc. under `REP_ID_REQUEST_SET`. */
export const REP_ID_REQUEST_SET = 0x21;
/** Feature report: enable/disable the sensor data stream, and read its status. */
export const REP_ID_SENSOR_STREAM_STATUS = 0x32;
/** Feature-report command byte under `REP_ID_REQUEST_SET`: keep-alive ping. */
export const RQ_CMD_PING = 0xf2;

const DEFAULT_GRAVITY = 9.8189; // m/s^2, matches sensorcapture_def.hpp
/** Accelerometer raw->m/s^2: +-8g full range over an int16. */
export const ACC_SCALE = DEFAULT_GRAVITY * (8.0 / 32768.0);
/** Gyroscope raw->deg/s: +-1000 dps full range over an int16. */
export const GYRO_SCALE = 1000.0 / 32768.0;
/** IMU temperature raw->degC. */
export const TEMP_SCALE = 0.01;
const DEG2RAD = Math.PI / 180;

/**
 * `zed-open-capture` sends sensor data at a fixed 400 Hz from the MCU
 * (`sensorcapture.cpp`'s grab loop pings roughly once per 400 reads to keep
 * the stream alive), so that's the nominal rate an idle consumer should
 * expect; `ZedImu.stats.rateHz` measures the actual observed rate rather
 * than assuming it.
 */
export const NOMINAL_SAMPLE_RATE_HZ = 400;

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Raw fields of `usb::RawData` (sensorcapture_def.hpp), decoded straight
 * from the wire (no unit conversion).
 *
 * IMPORTANT byte-offset note: the C struct's first byte (`struct_id`, which
 * duplicates the HID report id) is **not** present in the `DataView` WebHID
 * hands to `oninputreport` - the browser already strips the report id and
 * exposes it separately as `event.reportId`. Every offset below is the C
 * struct's offset minus 1 for that reason; `parseSensorReport`'s tests build
 * buffers that include the `struct_id` byte (to mirror the header 1:1) and
 * then slice it off, exactly as the browser would have.
 */
export interface RawZedSensorData {
  imuNotValid: number;
  timestampRaw: bigint;
  gX: number;
  gY: number;
  gZ: number;
  aX: number;
  aY: number;
  aZ: number;
  frameSync: number;
  syncCapabilities: number;
  frameSyncCount: number;
  imuTempRaw: number;
  magValid: number;
  mX: number;
  mY: number;
  mZ: number;
}

/** Minimum byte length of the input report body (after the report id byte is stripped). */
export const SENSOR_REPORT_MIN_LENGTH = 36;

/**
 * Decode a `REP_ID_SENSOR_DATA` input report body per `usb::RawData` (see
 * the module doc for the offset-by-one note). Little-endian throughout
 * (`#pragma pack(1)`, x86/ARM host, matches `DataView`'s `littleEndian: true`).
 */
export function parseSensorReport(data: DataView): RawZedSensorData {
  if (data.byteLength < SENSOR_REPORT_MIN_LENGTH) {
    throw new Error(`ZED sensor report too short: ${data.byteLength} bytes`);
  }
  return {
    imuNotValid: data.getUint8(0),
    timestampRaw: data.getBigUint64(1, true),
    gX: data.getInt16(9, true),
    gY: data.getInt16(11, true),
    gZ: data.getInt16(13, true),
    aX: data.getInt16(15, true),
    aY: data.getInt16(17, true),
    aZ: data.getInt16(19, true),
    frameSync: data.getUint8(21),
    syncCapabilities: data.getUint8(22),
    frameSyncCount: data.getUint32(23, true),
    imuTempRaw: data.getInt16(27, true),
    magValid: data.getUint8(29),
    mX: data.getInt16(30, true),
    mY: data.getInt16(32, true),
    mZ: data.getInt16(34, true),
  };
}

export interface ZedImuSample {
  /** Host clock (performance.now()-style) when this sample was received. */
  t: Millis;
  /** Accelerometer, m/s^2, raw IMU axes (see docs/general-camera/zed-imu.md for the axis convention). */
  accel: Vec3;
  /** Gyroscope, rad/s, raw IMU axes. */
  gyro: Vec3;
  temperatureC?: number;
  /** False when the MCU reports `imu_not_valid` (e.g. right after stream enable, before the IMU has settled). */
  valid: boolean;
}

/** Apply the wire scale factors and convert to the units `ZedImuSample` promises (m/s^2, rad/s, degC). */
export function rawToSample(raw: RawZedSensorData, t: Millis): ZedImuSample {
  return {
    t,
    accel: { x: raw.aX * ACC_SCALE, y: raw.aY * ACC_SCALE, z: raw.aZ * ACC_SCALE },
    gyro: {
      x: raw.gX * GYRO_SCALE * DEG2RAD,
      y: raw.gY * GYRO_SCALE * DEG2RAD,
      z: raw.gZ * GYRO_SCALE * DEG2RAD,
    },
    temperatureC: raw.imuTempRaw * TEMP_SCALE,
    valid: raw.imuNotValid !== 1,
  };
}

export interface ZedImuStats {
  /** Total samples received (valid + invalid) since `connect()`. */
  sampleCount: number;
  /** Samples with `imu_not_valid` set, dropped from `sample`/`onSample` but counted here. */
  invalidCount: number;
  /** Observed sample rate (Hz), smoothed over the last ~1s of inter-sample gaps. */
  rateHz: number;
  /** Host time of the newest sample; -Infinity before the first one. */
  lastSampleAt: Millis;
}

export type ZedImuUnsubscribe = () => void;

function nowMs(): Millis {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * WebHID driver for the ZED 2's sensor MCU. `connect()` must run inside a
 * user-gesture handler (a click) - `navigator.hid.requestDevice` throws a
 * `SecurityError` otherwise, which this wraps in a clearer message; a page
 * that already holds a permission grant from a previous session should call
 * `connectToGrantedDevice()` instead (safe outside a gesture, since it does
 * not prompt).
 */
export class ZedImu {
  private device: HIDDevice | null = null;
  private readonly listeners = new Set<(sample: ZedImuSample) => void>();
  private readonly recentIntervalsMs: number[] = [];

  sample: ZedImuSample = {
    t: -Infinity,
    accel: { x: 0, y: 0, z: 0 },
    gyro: { x: 0, y: 0, z: 0 },
    temperatureC: undefined,
    valid: false,
  };

  readonly stats: ZedImuStats = {
    sampleCount: 0,
    invalidCount: 0,
    rateHz: 0,
    lastSampleAt: -Infinity,
  };

  get connected(): boolean {
    return this.device !== null && this.device.opened;
  }

  /** Request device access (needs a user gesture) and start the sensor stream. */
  async connect(): Promise<void> {
    const hid = typeof navigator !== 'undefined' ? navigator.hid : undefined;
    if (!hid) {
      throw new Error('WebHID is not available in this browser (navigator.hid is undefined)');
    }
    let devices: HIDDevice[];
    try {
      devices = await hid.requestDevice({
        filters: [{ vendorId: ZED_VENDOR_ID, productId: ZED2_SENSOR_PRODUCT_ID }],
      });
    } catch (err) {
      throw new Error(
        'ZedImu.connect() must be called from a user gesture (e.g. a button click handler); ' +
          `navigator.hid.requestDevice rejected: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
    const device = devices[0];
    if (!device) {
      throw new Error('No ZED 2 sensor device selected (VID 0x2B03 / PID 0xF781)');
    }
    await this.openAndStart(device);
  }

  /**
   * Reconnect to a device the user already granted permission for in a
   * previous page load, via `navigator.hid.getDevices()`. Does not prompt,
   * so it's safe to call on page load without a user gesture; resolves to
   * `false` (and does nothing else) if no previously-granted ZED 2 sensor
   * device is found.
   */
  async connectToGrantedDevice(): Promise<boolean> {
    const hid = typeof navigator !== 'undefined' ? navigator.hid : undefined;
    if (!hid) return false;
    const devices = await hid.getDevices();
    const device = devices.find(
      (d) => d.vendorId === ZED_VENDOR_ID && d.productId === ZED2_SENSOR_PRODUCT_ID,
    );
    if (!device) return false;
    await this.openAndStart(device);
    return true;
  }

  private async openAndStart(device: HIDDevice): Promise<void> {
    if (!device.opened) {
      await device.open();
    }
    device.oninputreport = this.handleInputReport;
    // `enableDataStream(true)` in sensorcapture.cpp: a 1-byte feature report
    // under REP_ID_SENSOR_STREAM_STATUS turns the sample stream on.
    await device.sendFeatureReport(REP_ID_SENSOR_STREAM_STATUS, Uint8Array.of(1));
    this.device = device;
  }

  private readonly handleInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== REP_ID_SENSOR_DATA) return;
    let raw: RawZedSensorData;
    try {
      raw = parseSensorReport(event.data);
    } catch {
      return; // short/corrupt report; drop it rather than throw from an event handler.
    }
    const t = nowMs();
    this.stats.sampleCount++;
    if (Number.isFinite(this.stats.lastSampleAt) && this.stats.lastSampleAt >= 0) {
      const dt = t - this.stats.lastSampleAt;
      if (dt > 0) {
        this.recentIntervalsMs.push(dt);
        if (this.recentIntervalsMs.length > 50) this.recentIntervalsMs.shift();
        const meanDt = this.recentIntervalsMs.reduce((a, b) => a + b, 0) / this.recentIntervalsMs.length;
        this.stats.rateHz = meanDt > 0 ? 1000 / meanDt : 0;
      }
    }
    this.stats.lastSampleAt = t;

    const sample = rawToSample(raw, t);
    if (!sample.valid) {
      this.stats.invalidCount++;
      return;
    }
    this.sample = sample;
    for (const cb of this.listeners) cb(sample);
  };

  /** Subscribe to every valid sample; returns an unsubscribe function. */
  onSample(cb: (sample: ZedImuSample) => void): ZedImuUnsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Stop the stream and close the device (permission grant survives, per WebHID). */
  async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    if (!device) return;
    device.oninputreport = null;
    try {
      if (device.opened) {
        await device.sendFeatureReport(REP_ID_SENSOR_STREAM_STATUS, Uint8Array.of(0));
        await device.close();
      }
    } catch {
      // best-effort: the device may already be gone (unplugged).
    }
  }
}
