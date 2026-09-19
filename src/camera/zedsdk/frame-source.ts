/**
 * FrameSource fed by the ZED SDK bridge: the bridge's left-eye JPEG is drawn
 * onto `display` (the canvas the app places under its overlay, like the
 * stereo source's left-eye canvas). Intrinsics come from the SDK's
 * calibration (fovY from fy), not from the tuning panel.
 */
import type { CameraIntrinsics, FrameSource, GrabbedFrame } from '../contract';
import type { ZedBridgeClient, DecodedBridgeFrame } from './bridge-client';
import { fovYFromIntrinsics } from './protocol';

const READY_TIMEOUT_MS = 15_000;

export class ZedSdkFrameSource implements FrameSource {
  readonly kind = 'zed-sdk' as const;
  /** Required by the contract; never plays. The app shows `display` instead. */
  readonly video: HTMLVideoElement;
  /** The passthrough: newest left image. */
  readonly display: HTMLCanvasElement;
  private readonly displayCtx: CanvasRenderingContext2D;
  private readonly grabCanvas: HTMLCanvasElement;
  private readonly grabCtx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private fovY: number;
  private measuredFovY: number | null = null;
  private _lastFrameAt = 0;
  private _fps = 0;
  private fpsWindowStart = 0;
  private fpsWindowFrames = 0;
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(private readonly client: ZedBridgeClient, opts: { fovY: number }) {
    this.fovY = opts.fovY;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.display = document.createElement('canvas');
    this.display.id = 'zed-sdk-passthrough';
    const dctx = this.display.getContext('2d');
    if (!dctx) throw new Error('ZedSdkFrameSource: 2D context unavailable');
    this.displayCtx = dctx;
    this.grabCanvas = document.createElement('canvas');
    const gctx = this.grabCanvas.getContext('2d', { willReadFrequently: true });
    if (!gctx) throw new Error('ZedSdkFrameSource: 2D context unavailable');
    this.grabCtx = gctx;
  }

  get ready(): boolean {
    return this.started && this.width > 0;
  }

  get lastFrameAt(): number {
    return this._lastFrameAt;
  }

  /** Decoded frames per second (bridge -> canvas). */
  get fps(): number {
    return this._fps;
  }

  get intrinsics(): CameraIntrinsics {
    const aspect = this.width > 0 && this.height > 0 ? this.width / this.height : 16 / 9;
    return { fovY: this.measuredFovY ?? this.fovY, aspect, width: this.width, height: this.height };
  }

  /** The SDK calibration wins; the tuning value is only used before the first frame. */
  setFovY(fovY: number): void {
    this.fovY = fovY;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.unsubscribe = this.client.onFrame(this.onFrame);
    await this.client.connect();
    this.started = true;
    if (this.width > 0) return;
    await new Promise<void>((resolve, reject) => {
      const t0 = performance.now();
      const tick = (): void => {
        if (this.width > 0) return resolve();
        if (performance.now() - t0 > READY_TIMEOUT_MS) return reject(new Error(`ZedSdkFrameSource: no frame from ${this.client.url} within ${READY_TIMEOUT_MS / 1000} s`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    this.client.close();
  }

  private onFrame = (frame: DecodedBridgeFrame): void => {
    const { header, image } = frame;
    if (this.display.width !== header.width || this.display.height !== header.height) {
      this.display.width = header.width;
      this.display.height = header.height;
    }
    this.displayCtx.drawImage(image, 0, 0, header.width, header.height);
    image.close();
    this.width = header.width;
    this.height = header.height;
    this.measuredFovY = fovYFromIntrinsics(header.fy, header.height);
    const now = performance.now();
    this._lastFrameAt = now;
    if (this.fpsWindowStart === 0) this.fpsWindowStart = now;
    this.fpsWindowFrames += 1;
    if (now - this.fpsWindowStart >= 1000) {
      this._fps = (this.fpsWindowFrames * 1000) / (now - this.fpsWindowStart);
      this.fpsWindowStart = now;
      this.fpsWindowFrames = 0;
    }
  };

  grab(maxWidth: number): GrabbedFrame | null {
    if (!this.ready) return null;
    const width = Math.max(1, Math.round(Math.min(maxWidth, this.width)));
    const height = Math.max(1, Math.round((width * this.height) / this.width));
    if (this.grabCanvas.width !== width || this.grabCanvas.height !== height) {
      this.grabCanvas.width = width;
      this.grabCanvas.height = height;
    }
    this.grabCtx.drawImage(this.display, 0, 0, width, height);
    const data = this.grabCtx.getImageData(0, 0, width, height);
    return { width, height, rgba: data.data, timestamp: this._lastFrameAt };
  }
}
