import { describe, expect, it, vi } from 'vitest';
import { quatRotateVec3 } from '@/core/math';
import { REP_ID_SENSOR_DATA, ZED2_SENSOR_PRODUCT_ID, ZED_VENDOR_ID, ZedImu } from '@/camera/pose/zed-imu';
import { ZedImuPoseSource, installZedImu } from '@/camera/pose/zed-imu-pose-source';

const G = 9.8189;

/** A fake HIDDevice good enough to drive ZedImu without a browser (mirrors tests/unit/zed-imu.test.ts). */
function makeFakeDevice(productName = 'ZED 2') {
  const device = {
    opened: false,
    vendorId: ZED_VENDOR_ID,
    productId: ZED2_SENSOR_PRODUCT_ID,
    productName,
    oninputreport: null as ((ev: unknown) => void) | null,
    async open() {
      device.opened = true;
    },
    async close() {
      device.opened = false;
    },
    async sendReport() {},
    async sendFeatureReport() {},
    async receiveFeatureReport() {
      return new DataView(new ArrayBuffer(2));
    },
  };
  return device;
}

/** Builds a `REP_ID_SENSOR_DATA` HID input-report body (report id already stripped, as WebHID delivers it). */
function makeSensorReportBody(fields: { aX?: number; aY?: number; aZ?: number; gX?: number; gY?: number; gZ?: number }): DataView {
  const buf = new ArrayBuffer(36);
  const view = new DataView(buf);
  view.setUint8(0, 0); // imu_not_valid
  view.setBigUint64(1, 0n, true); // timestamp
  view.setInt16(9, fields.gX ?? 0, true);
  view.setInt16(11, fields.gY ?? 0, true);
  view.setInt16(13, fields.gZ ?? 0, true);
  view.setInt16(15, fields.aX ?? 0, true);
  view.setInt16(17, fields.aY ?? 0, true);
  view.setInt16(19, fields.aZ ?? 0, true);
  return view;
}

function accelToRaw(mps2: number): number {
  const ACC_SCALE = 9.8189 * (8 / 32768);
  return Math.round(mps2 / ACC_SCALE);
}
function gyroToRaw(radS: number): number {
  const GYRO_SCALE = (1000 / 32768) * (Math.PI / 180);
  return Math.round(radS / GYRO_SCALE);
}

function feedSample(device: ReturnType<typeof makeFakeDevice>, fields: Parameters<typeof makeSensorReportBody>[0]): void {
  device.oninputreport?.({ reportId: REP_ID_SENSOR_DATA, data: makeSensorReportBody(fields), device });
}

let originalNavigatorDescriptor: PropertyDescriptor | undefined;
function stubNavigatorHid(device: ReturnType<typeof makeFakeDevice> | null): void {
  originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      hid: {
        async getDevices() {
          return device ? [device] : [];
        },
        async requestDevice() {
          return device ? [device] : [];
        },
      },
    },
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

describe('ZedImuPoseSource: no device connected', () => {
  it('start() never throws even with no WebHID/no granted device, and leaves trackingOk false', async () => {
    const src = new ZedImuPoseSource({ cameraHeightM: 1.2 });
    await expect(src.start()).resolves.toBeUndefined();
    src.update(0);
    expect(src.quality.trackingOk).toBe(false);
    expect(src.quality.confidence).toBe(0);
  });
});

describe('ZedImuPoseSource: connected, level', () => {
  it('reports the configured height and a level rotation once samples arrive', async () => {
    const device = makeFakeDevice();
    stubNavigatorHid(device);
    try {
      const imu = new ZedImu();
      const src = new ZedImuPoseSource({ cameraHeightM: 1.3, imu });
      await src.start(); // silent reconnect finds our fake device

      let t = 0;
      for (let i = 0; i < 60; i++) {
        feedSample(device, { aY: accelToRaw(G) });
        t += 10;
      }
      src.update(t);

      expect(src.pose.position).toEqual({ x: 0, y: 1.3, z: 0 });
      const forward = quatRotateVec3(src.pose.rotation, { x: 0, y: 0, z: -1 });
      expect(forward.x).toBeCloseTo(0, 1);
      expect(forward.z).toBeCloseTo(-1, 1);
      expect(src.quality.trackingOk).toBe(true);
      expect(src.quality.confidence).toBeGreaterThan(0.8);
    } finally {
      restoreNavigatorHid();
    }
  });

  it('setHeight updates future poses', async () => {
    const device = makeFakeDevice();
    stubNavigatorHid(device);
    try {
      const imu = new ZedImu();
      const src = new ZedImuPoseSource({ cameraHeightM: 1.0, imu });
      await src.start();
      feedSample(device, { aY: accelToRaw(G) });
      src.setHeight(1.7);
      src.update(10);
      expect(src.pose.position.y).toBeCloseTo(1.7, 6);
    } finally {
      restoreNavigatorHid();
    }
  });
});

describe('ZedImuPoseSource: bump handling', () => {
  it('trackingOk goes false during a bump (gyro > 0.3 rad/s) and stays false for bumpRecoveryMs after', async () => {
    const device = makeFakeDevice();
    stubNavigatorHid(device);
    try {
      const imu = new ZedImu();
      const src = new ZedImuPoseSource({ cameraHeightM: 1.2, imu, bumpRecoveryMs: 300 });
      await src.start();

      let t = 0;
      for (let i = 0; i < 20; i++) {
        feedSample(device, { aY: accelToRaw(G) });
        t += 10;
      }
      src.update(t);
      expect(src.quality.trackingOk).toBe(true);

      // A bump: gyro well above 0.3 rad/s.
      feedSample(device, { aY: accelToRaw(G), gX: gyroToRaw(1.0) });
      t += 10;
      src.update(t);
      expect(src.quality.trackingOk).toBe(false);

      // 100ms later (< 300ms recovery window), still not ok, even with a quiet sample.
      feedSample(device, { aY: accelToRaw(G) });
      t += 100;
      src.update(t);
      expect(src.quality.trackingOk).toBe(false);

      // 300ms after the bump, recovered.
      feedSample(device, { aY: accelToRaw(G) });
      t += 250;
      src.update(t);
      expect(src.quality.trackingOk).toBe(true);
    } finally {
      restoreNavigatorHid();
    }
  });
});

describe('ZedImuPoseSource: dispose', () => {
  it('unsubscribes and disconnects the device', async () => {
    const device = makeFakeDevice();
    stubNavigatorHid(device);
    try {
      const imu = new ZedImu();
      const src = new ZedImuPoseSource({ cameraHeightM: 1.2, imu });
      await src.start();
      expect(imu.connected).toBe(true);
      src.dispose();
      // disconnect() is async/fire-and-forget from dispose(); give it a tick.
      await Promise.resolve();
      await Promise.resolve();
      expect(device.opened).toBe(false);
    } finally {
      restoreNavigatorHid();
    }
  });
});

/**
 * Minimal DOM stand-in: no jsdom in this repo (see tests/unit/camera-pointer.test.ts's
 * `fakeElement`), so `installZedImu`'s createElement/appendChild/querySelector/
 * addEventListener/remove surface is faked directly.
 */
function fakeDom() {
  interface FakeEl {
    tagName: string;
    className: string;
    textContent: string;
    disabled: boolean;
    children: FakeEl[];
    listeners: Map<string, (() => void)[]>;
    ownerDocument: { createElement: (tag: string) => FakeEl };
    appendChild(child: FakeEl): void;
    querySelector(tag: string): FakeEl | null;
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
    setAttribute(): void;
    remove(): void;
    click(): void;
  }

  const doc = {
    createElement(tag: string): FakeEl {
      const el: FakeEl = {
        tagName: tag,
        className: '',
        textContent: '',
        disabled: false,
        children: [],
        listeners: new Map(),
        ownerDocument: doc,
        appendChild(child) {
          el.children.push(child);
        },
        querySelector(t) {
          return el.children.find((c) => c.tagName === t) ?? null;
        },
        addEventListener(type, fn) {
          el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]);
        },
        removeEventListener(type, fn) {
          el.listeners.set(type, (el.listeners.get(type) ?? []).filter((f) => f !== fn));
        },
        setAttribute() {
          /* noop */
        },
        remove() {
          const parentChildren = doc.root.children;
          const i = parentChildren.indexOf(el);
          if (i >= 0) parentChildren.splice(i, 1);
        },
        click() {
          for (const fn of el.listeners.get('click') ?? []) fn();
        },
      };
      return el;
    },
    root: null as unknown as FakeEl,
  };
  doc.root = doc.createElement('div');
  return doc;
}

describe('installZedImu', () => {
  it('adds a Connect ZED IMU button and status label to the landing card, and clicking it calls connect()', async () => {
    const doc = fakeDom();
    const landingCard = doc.root as unknown as HTMLElement;
    const imu = new ZedImu();
    const src = new ZedImuPoseSource({ cameraHeightM: 1.2, imu });
    const connectSpy = vi.spyOn(src, 'connect').mockResolvedValue(undefined);

    const cleanup = installZedImu(landingCard, src);
    const button = doc.root.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('Connect ZED IMU');

    button?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(connectSpy).toHaveBeenCalledTimes(1);

    cleanup();
    expect(doc.root.querySelector('button')).toBeNull();
  });
});
