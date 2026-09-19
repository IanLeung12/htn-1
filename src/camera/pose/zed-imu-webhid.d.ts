/**
 * Minimal WebHID ambient types. TypeScript's bundled `lib.dom.d.ts` does not
 * include the WebHID API, so `zed-imu.ts` / `zed-imu-pose-source.ts` need
 * this stub for `navigator.hid`. Only the surface those files actually use
 * is declared (see https://wicg.github.io/webhid/ for the full API).
 */

interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

interface HIDDeviceRequestOptions {
  filters: HIDDeviceFilter[];
}

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

interface HIDDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  oninputreport: ((this: HIDDevice, ev: HIDInputReportEvent) => unknown) | null;
}

interface HID extends EventTarget {
  requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
  getDevices(): Promise<HIDDevice[]>;
}

interface Navigator {
  readonly hid?: HID;
}
