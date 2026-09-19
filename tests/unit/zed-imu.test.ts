import { describe, expect, it } from 'vitest';
import {
  ACC_SCALE,
  GYRO_SCALE,
  REP_ID_SENSOR_DATA,
  SENSOR_REPORT_MIN_LENGTH,
  TEMP_SCALE,
  ZED2_SENSOR_PRODUCT_ID,
  ZED_VENDOR_ID,
  ZedImu,
  parseSensorReport,
  rawToSample,
} from '@/camera/pose/zed-imu';

const DEG2RAD = Math.PI / 180;

/**
 * Builds a full `usb::RawData` struct (sensorcapture_def.hpp) byte-for-byte,
 * *including* the leading `struct_id` byte the C header documents, then
 * strips it before handing the buffer to `parseSensorReport` - exactly what
 * WebHID does for us before `oninputreport` fires (the report id is pulled
 * out into `event.reportId` and never appears in `event.data`).
 *
 * Layout (little-endian, `#pragma pack(1)`):
 *   u8  struct_id
 *   u8  imu_not_valid
 *   u64 timestamp
 *   i16 gX, gY, gZ
 *   i16 aX, aY, aZ
 *   u8  frame_sync
 *   u8  sync_capabilities
 *   u32 frame_sync_count
 *   i16 imu_temp
 *   u8  mag_valid
 *   i16 mX, mY, mZ
 *   ... (camera_moving / env fields follow; not needed for IMU parsing)
 */
function buildRawDataStruct(fields: {
  imuNotValid?: number;
  timestamp?: bigint;
  gX?: number;
  gY?: number;
  gZ?: number;
  aX?: number;
  aY?: number;
  aZ?: number;
  frameSync?: number;
  syncCapabilities?: number;
  frameSyncCount?: number;
  imuTemp?: number;
  magValid?: number;
  mX?: number;
  mY?: number;
  mZ?: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(37); // through mZ, plenty for our purposes
  const view = new DataView(buf);
  let o = 0;
  view.setUint8(o, REP_ID_SENSOR_DATA); o += 1; // struct_id
  view.setUint8(o, fields.imuNotValid ?? 0); o += 1;
  view.setBigUint64(o, fields.timestamp ?? 0n, true); o += 8;
  view.setInt16(o, fields.gX ?? 0, true); o += 2;
  view.setInt16(o, fields.gY ?? 0, true); o += 2;
  view.setInt16(o, fields.gZ ?? 0, true); o += 2;
  view.setInt16(o, fields.aX ?? 0, true); o += 2;
  view.setInt16(o, fields.aY ?? 0, true); o += 2;
  view.setInt16(o, fields.aZ ?? 0, true); o += 2;
  view.setUint8(o, fields.frameSync ?? 0); o += 1;
  view.setUint8(o, fields.syncCapabilities ?? 0); o += 1;
  view.setUint32(o, fields.frameSyncCount ?? 0, true); o += 4;
  view.setInt16(o, fields.imuTemp ?? 0, true); o += 2;
  view.setUint8(o, fields.magValid ?? 0); o += 1;
  view.setInt16(o, fields.mX ?? 0, true); o += 2;
  view.setInt16(o, fields.mY ?? 0, true); o += 2;
  view.setInt16(o, fields.mZ ?? 0, true); o += 2;
  return buf;
}

/** Strip the leading struct_id byte, as WebHID's `event.data` already has. */
function toHidReportBody(structBuf: ArrayBuffer): DataView {
  return new DataView(structBuf.slice(1));
}

describe('ZED 2 protocol constants (mirrors zed-open-capture)', () => {
  it('vendor/product ids match the owner-verified hardware (UVC PID 0xF780, sensor PID 0xF781)', () => {
    expect(ZED_VENDOR_ID).toBe(0x2b03);
    expect(ZED2_SENSOR_PRODUCT_ID).toBe(0xf781);
  });

  it('scale factors match sensorcapture_def.hpp', () => {
    // ACC_SCALE = DEFAULT_GRAVITY * (8.0/32768.0), DEFAULT_GRAVITY = 9.8189
    expect(ACC_SCALE).toBeCloseTo(9.8189 * (8 / 32768), 9);
    // GYRO_SCALE = 1000.0/32768.0 (deg/s per LSB, +-1000dps range)
    expect(GYRO_SCALE).toBeCloseTo(1000 / 32768, 9);
    expect(TEMP_SCALE).toBe(0.01);
  });
});

describe('parseSensorReport', () => {
  it('rejects a report shorter than the struct requires', () => {
    expect(() => parseSensorReport(new DataView(new ArrayBuffer(SENSOR_REPORT_MIN_LENGTH - 1)))).toThrow();
  });

  it('decodes every field at its documented (report-id-stripped) offset', () => {
    const struct = buildRawDataStruct({
      imuNotValid: 0,
      timestamp: 123456789n,
      gX: 100, gY: -200, gZ: 300,
      aX: -1000, aY: 2000, aZ: -3000,
      frameSync: 1,
      syncCapabilities: 1,
      frameSyncCount: 42,
      imuTemp: 2500, // 25.00 degC
      magValid: 1,
      mX: 10, mY: -20, mZ: 30,
    });
    const raw = parseSensorReport(toHidReportBody(struct));

    expect(raw.imuNotValid).toBe(0);
    expect(raw.timestampRaw).toBe(123456789n);
    expect(raw.gX).toBe(100);
    expect(raw.gY).toBe(-200);
    expect(raw.gZ).toBe(300);
    expect(raw.aX).toBe(-1000);
    expect(raw.aY).toBe(2000);
    expect(raw.aZ).toBe(-3000);
    expect(raw.frameSync).toBe(1);
    expect(raw.syncCapabilities).toBe(1);
    expect(raw.frameSyncCount).toBe(42);
    expect(raw.imuTempRaw).toBe(2500);
    expect(raw.magValid).toBe(1);
    expect(raw.mX).toBe(10);
    expect(raw.mY).toBe(-20);
    expect(raw.mZ).toBe(30);
  });
});

describe('rawToSample (unit conversion)', () => {
  it('scales accel to m/s^2 and gyro to rad/s, temperature to degC', () => {
    const struct = buildRawDataStruct({ aX: 4096, aY: 0, aZ: 0, gX: 0, gY: 3277, gZ: 0, imuTemp: 3000 });
    const raw = parseSensorReport(toHidReportBody(struct));
    const sample = rawToSample(raw, 1000);

    expect(sample.t).toBe(1000);
    // 4096 raw at +-8g/32768 counts ~= 1g = 9.8189 m/s^2
    expect(sample.accel.x).toBeCloseTo(9.8189, 3);
    expect(sample.accel.y).toBeCloseTo(0, 6);
    expect(sample.accel.z).toBeCloseTo(0, 6);
    // 3277 raw at 1000dps/32768 counts ~= 100 deg/s == 100*pi/180 rad/s
    expect(sample.gyro.y).toBeCloseTo(100 * DEG2RAD, 2);
    expect(sample.temperatureC).toBeCloseTo(30, 6);
  });

  it('marks a sample invalid when imu_not_valid is set (dropped by ZedImu, kept here for callers who want it)', () => {
    const struct = buildRawDataStruct({ imuNotValid: 1 });
    const raw = parseSensorReport(toHidReportBody(struct));
    const sample = rawToSample(raw, 0);
    expect(sample.valid).toBe(false);
  });

  it('a stationary camera reads ~1g on one axis and ~0 on the others', () => {
    // aZ = -32768/8 * ... i.e. -1g on Z (camera lying with Z-axis vertical).
    const oneG = Math.round(9.8189 / ACC_SCALE);
    const struct = buildRawDataStruct({ aZ: -oneG });
    const raw = parseSensorReport(toHidReportBody(struct));
    const sample = rawToSample(raw, 0);
    expect(sample.accel.z).toBeCloseTo(-9.8189, 2);
    expect(Math.abs(sample.accel.x)).toBeLessThan(0.01);
    expect(Math.abs(sample.accel.y)).toBeLessThan(0.01);
  });
});

describe('ZedImu.connect() without WebHID', () => {
  it('throws a clear error when navigator.hid is unavailable (vitest node env, or a browser without WebHID)', async () => {
    const imu = new ZedImu();
    await expect(imu.connect()).rejects.toThrow(/WebHID/);
  });

  it('connectToGrantedDevice() resolves false rather than throwing when navigator.hid is unavailable', async () => {
    const imu = new ZedImu();
    await expect(imu.connectToGrantedDevice()).resolves.toBe(false);
  });
});

/**
 * `navigator` in vitest's node environment has only a getter (no setter),
 * so a plain assignment throws; redefine the property for the duration of
 * one test and put the original back afterwards.
 */
let originalNavigatorDescriptor: PropertyDescriptor | undefined;
function stubNavigatorHid(hid: Pick<HID, 'getDevices' | 'requestDevice'>): void {
  originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { hid },
    configurable: true,
  });
}
function restoreNavigatorHid(): void {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
}

describe('ZedImu sample stream (simulated HID device)', () => {
  /** A fake HIDDevice good enough to drive ZedImu's connect/parse/stats path without a browser. */
  function makeFakeDevice() {
    const sentFeatureReports: { reportId: number; data: Uint8Array }[] = [];
    const device = {
      opened: false,
      vendorId: ZED_VENDOR_ID,
      productId: ZED2_SENSOR_PRODUCT_ID,
      productName: 'ZED 2',
      oninputreport: null as ((ev: unknown) => void) | null,
      async open() {
        device.opened = true;
      },
      async close() {
        device.opened = false;
      },
      async sendReport() {},
      async sendFeatureReport(reportId: number, data: BufferSource) {
        sentFeatureReports.push({ reportId, data: new Uint8Array(data as ArrayBuffer) });
      },
      async receiveFeatureReport() {
        return new DataView(new ArrayBuffer(2));
      },
    };
    return { device, sentFeatureReports };
  }

  it('enables the stream on connect and disables it on disconnect', async () => {
    const { device, sentFeatureReports } = makeFakeDevice();
    const imu = new ZedImu();
    // Reach past connect()'s requestDevice (no fake navigator.hid wired here)
    // by exercising the private open path indirectly via connectToGrantedDevice.
    stubNavigatorHid({
      async getDevices() {
        return [device as unknown as HIDDevice];
      },
      async requestDevice() {
        return [device as unknown as HIDDevice];
      },
    });

    try {
      const ok = await imu.connectToGrantedDevice();
      expect(ok).toBe(true);
      expect(sentFeatureReports).toEqual([{ reportId: 0x32, data: Uint8Array.of(1) }]);

      // Feed one valid sample through the device's input-report path.
      const struct = buildRawDataStruct({ aZ: -1, gX: 0 });
      const body = toHidReportBody(struct);
      let received: unknown = null;
      imu.onSample((s) => {
        received = s;
      });
      device.oninputreport?.({ reportId: REP_ID_SENSOR_DATA, data: body, device });
      expect(received).not.toBeNull();
      expect(imu.stats.sampleCount).toBe(1);
      expect(imu.stats.invalidCount).toBe(0);

      await imu.disconnect();
      expect(sentFeatureReports.at(-1)).toEqual({ reportId: 0x32, data: Uint8Array.of(0) });
    } finally {
      restoreNavigatorHid();
    }
  });

  it('drops invalid samples from onSample/sample but still counts them in stats', async () => {
    const { device } = makeFakeDevice();
    const imu = new ZedImu();
    stubNavigatorHid({
      async getDevices() {
        return [device as unknown as HIDDevice];
      },
      async requestDevice() {
        return [];
      },
    });

    try {
      await imu.connectToGrantedDevice();
      let calls = 0;
      imu.onSample(() => calls++);
      const struct = buildRawDataStruct({ imuNotValid: 1 });
      device.oninputreport?.({ reportId: REP_ID_SENSOR_DATA, data: toHidReportBody(struct), device });
      expect(calls).toBe(0);
      expect(imu.stats.sampleCount).toBe(1);
      expect(imu.stats.invalidCount).toBe(1);
      expect(imu.sample.valid).toBe(false); // still the constructor default; never overwritten by invalid data
    } finally {
      restoreNavigatorHid();
    }
  });
});
