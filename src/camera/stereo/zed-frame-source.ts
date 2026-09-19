/**
 * `FrameSource` for a ZED 2 stereo camera exposed by Chrome as a plain UVC
 * webcam (label like "ZED 2 (2b03:f780)"), delivering side-by-side stereo
 * frames (left half = left eye) that are NOT rectified on-device.
 *
 * This class owns capture only: it hands back the raw side-by-side `video`
 * element (kept hidden by the app) plus a `display` canvas already cropped
 * to the left eye (which the app appends instead, so the visible frame isn't
 * squashed to 2x width). Rectification maps are computed here (from the
 * factory calibration, see zed-calib.ts) and handed to the depth estimator
 * as data (`rectifyMaps`); this class does not resample pixels on the CPU
 * per frame, so `stereo.rectified` is always false.
 *
 * See src/camera/frame-source.ts (BaseVideoFrameSource) for the patterns
 * copied here: video element setup, offscreen-canvas grabs, and the
 * requestVideoFrameCallback-based readiness/frame-arrival tracking. That
 * class isn't exported, so this one duplicates the relevant bits rather than
 * subclassing it.
 */
import type { CameraIntrinsics, FrameSource, FrameSourceKind, GrabbedFrame, StereoParams } from '../contract';
import {
  buildRectifyMap,
  nominalStereo,
  rodrigues,
  stereoRectify,
  type ZedCalibration,
  type ZedResolution,
} from './zed-calib';

const READY_TIMEOUT_MS = 10_000;

export type ZedStereoMode = 'vga' | 'hd720' | 'hd1080';

/** Side-by-side capture size (both eyes) for each supported mode. */
const CAPTURE_SIZE: Record<ZedStereoMode, { width: number; height: number; eyeWidth: number; eyeHeight: number }> = {
  vga: { width: 1344, height: 376, eyeWidth: 672, eyeHeight: 376 },
  hd720: { width: 2560, height: 720, eyeWidth: 1280, eyeHeight: 720 },
  hd1080: { width: 3840, height: 1080, eyeWidth: 1920, eyeHeight: 1080 },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeVideoElement(): HTMLVideoElement {
  const video = document.createElement('video');
  video.style.position = 'absolute';
  video.style.inset = '0';
  // The app keeps this element hidden and appends `display` instead.
  video.style.display = 'none';
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  return video;
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('ZedStereoFrameSource: 2D canvas context unavailable');
  return { canvas, ctx };
}

export interface RectifyMapsResult {
  left: Float32Array;
  right: Float32Array;
  width: number;
  height: number;
  fxRect: number;
  cxRect: number;
  cyRect: number;
}

export class ZedStereoFrameSource implements FrameSource {
  readonly kind: FrameSourceKind = 'stereo';
  readonly video: HTMLVideoElement;
  /** Left-eye-only canvas the app should append and show (video stays hidden, raw side-by-side). */
  readonly display: HTMLCanvasElement;
  readonly calibration: ZedCalibration | null;

  private readonly deviceLabelPattern: RegExp;
  private readonly mode: ZedStereoMode;
  private fovY: number;
  private stream: MediaStream | null = null;
  private _lastFrameAt = 0;
  private frameCallbackHandle: number | null = null;

  private readonly displayCtx: CanvasRenderingContext2D;
  private readonly leftGrabCanvas: HTMLCanvasElement;
  private readonly leftGrabCtx: CanvasRenderingContext2D;
  private readonly rightGrabCanvas: HTMLCanvasElement;
  private readonly rightGrabCtx: CanvasRenderingContext2D;

  private readonly rectifyMapCache = new Map<ZedResolution, RectifyMapsResult | null>();

  /** Side-by-side recording to play instead of a device (e.g. /zed/zed2-sbs-hd720-8s.webm); loops. */
  private readonly url: string | null;

  constructor(opts: { fovY: number; deviceLabel?: string; mode?: ZedStereoMode; calibration?: ZedCalibration | null; url?: string }) {
    this.url = opts.url ?? null;
    this.fovY = opts.fovY;
    this.deviceLabelPattern = new RegExp(escapeRegExp(opts.deviceLabel ?? 'zed'), 'i');
    this.mode = opts.mode ?? 'vga';
    this.calibration = opts.calibration ?? null;

    this.video = makeVideoElement();

    const { eyeWidth, eyeHeight } = CAPTURE_SIZE[this.mode];
    const display = makeCanvas(eyeWidth, eyeHeight);
    this.display = display.canvas;
    this.displayCtx = display.ctx;

    const leftGrab = makeCanvas(1, 1);
    this.leftGrabCanvas = leftGrab.canvas;
    this.leftGrabCtx = leftGrab.ctx;
    const rightGrab = makeCanvas(1, 1);
    this.rightGrabCanvas = rightGrab.canvas;
    this.rightGrabCtx = rightGrab.ctx;

    // Refine fovY from calibration/nominal fx immediately; start() will not
    // change it further since the eye size is fixed by `mode`.
    this.fovY = this.computeFovY();
  }

  private computeFovY(): number {
    const { eyeHeight } = CAPTURE_SIZE[this.mode];
    const maps = this.rectifyMaps(this.mode);
    const fy = maps ? maps.fxRect : nominalStereo(this.mode).fxPx;
    return 2 * Math.atan(eyeHeight / (2 * fy));
  }

  get ready(): boolean {
    return this.video.videoWidth > 0 && this.video.readyState >= 2 && !this.video.paused;
  }

  get lastFrameAt(): number {
    return this._lastFrameAt;
  }

  get intrinsics(): CameraIntrinsics {
    const { eyeWidth, eyeHeight } = CAPTURE_SIZE[this.mode];
    return { fovY: this.fovY, aspect: eyeWidth / eyeHeight, width: eyeWidth, height: eyeHeight };
  }

  get stereo(): StereoParams {
    const { eyeWidth, eyeHeight } = CAPTURE_SIZE[this.mode];
    const maps = this.rectifyMaps(this.mode);
    const nominal = nominalStereo(this.mode);
    return {
      baselineM: this.calibration?.baselineM ?? nominal.baselineM,
      eyeWidth,
      eyeHeight,
      fxPx: maps ? maps.fxRect : nominal.fxPx,
      // The GPU depth estimator applies rectifyMaps() itself; frames handed
      // out by grab()/grabStereo() are the raw (unrectified) eyes.
      rectified: false,
      calibrationId: this.calibration?.serial ?? null,
    };
  }

  /** Rectification maps for `res` (memoised), or null when no calibration covers that mode. */
  rectifyMaps(res: ZedResolution): RectifyMapsResult | null {
    const cached = this.rectifyMapCache.get(res);
    if (cached !== undefined) return cached;

    const calib = this.calibration;
    const modeCalib = calib?.modes[res];
    if (!calib || !modeCalib) {
      this.rectifyMapCache.set(res, null);
      return null;
    }

    const R = rodrigues(modeCalib.rx, modeCalib.cv, modeCalib.rz);
    const T: [number, number, number] = [-calib.baselineM, calib.ty, calib.tz];
    const { R1, R2, P1, P2, fxRect, cxRect, cyRect } = stereoRectify(
      modeCalib.left,
      modeCalib.right,
      R,
      T,
      modeCalib.width,
      modeCalib.height,
    );
    const left = buildRectifyMap(modeCalib.left, R1, P1, modeCalib.width, modeCalib.height);
    const right = buildRectifyMap(modeCalib.right, R2, P2, modeCalib.width, modeCalib.height);
    const result: RectifyMapsResult = { left, right, width: modeCalib.width, height: modeCalib.height, fxRect, cxRect, cyRect };
    this.rectifyMapCache.set(res, result);
    return result;
  }

  /** No-op: the ZED's field of view comes from calibration/nominal fx, not a user setting. */
  setFovY(_fovY: number): void {
    // Intentionally ignored; see class doc.
  }

  async start(): Promise<void> {
    if (this.url) {
      // Recorded side-by-side clip: same pipeline (left-eye display, both halves grabbed) without a device.
      this.video.crossOrigin = 'anonymous';
      this.video.loop = true;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.src = this.url;
      this.trackFrameArrivals();
      await this.video.play();
      await this.waitUntilReady();
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('ZedStereoFrameSource: navigator.mediaDevices.getUserMedia is unavailable (insecure context?)');
    }

    let devices = await navigator.mediaDevices.enumerateDevices();
    let videoInputs = devices.filter((d) => d.kind === 'videoinput');
    if (videoInputs.every((d) => d.label === '')) {
      // Labels are blank until permission is granted; prime with a throwaway
      // getUserMedia call, then re-enumerate.
      const primer = await navigator.mediaDevices.getUserMedia({ video: true });
      primer.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      videoInputs = devices.filter((d) => d.kind === 'videoinput');
    }

    const match = videoInputs.find((d) => this.deviceLabelPattern.test(d.label));
    if (!match) {
      const labels = videoInputs.map((d) => d.label || '(no label)').join(', ') || '(none)';
      throw new Error(`ZedStereoFrameSource: no video input matches /${this.deviceLabelPattern.source}/i. Devices seen: ${labels}`);
    }

    const { width, height } = CAPTURE_SIZE[this.mode];
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: match.deviceId },
          width: { exact: width },
          height: { exact: height },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: match.deviceId },
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    }

    this.stream = stream;
    this.video.srcObject = stream;
    this.trackFrameArrivals();
    await this.video.play();
    await this.waitUntilReady();
  }

  stop(): void {
    this.stopTrackingFrameArrivals();
    this.video.pause();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    if (this.url) this.video.removeAttribute('src');
    this.video.parentNode?.removeChild(this.video);
    this.display.parentNode?.removeChild(this.display);
  }

  private trackFrameArrivals(): void {
    const videoWithRvfc = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const step = (): void => {
      this._lastFrameAt = performance.now();
      this.updateDisplay();
      if (typeof videoWithRvfc.requestVideoFrameCallback === 'function') {
        this.frameCallbackHandle = videoWithRvfc.requestVideoFrameCallback(step);
      } else {
        this.frameCallbackHandle = requestAnimationFrame(step);
      }
    };
    if (typeof videoWithRvfc.requestVideoFrameCallback === 'function') {
      this.frameCallbackHandle = videoWithRvfc.requestVideoFrameCallback(step);
    } else {
      this.frameCallbackHandle = requestAnimationFrame(step);
    }
  }

  private stopTrackingFrameArrivals(): void {
    const videoWithRvfc = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void };
    if (this.frameCallbackHandle !== null) {
      if (typeof videoWithRvfc.cancelVideoFrameCallback === 'function') {
        videoWithRvfc.cancelVideoFrameCallback(this.frameCallbackHandle);
      } else {
        cancelAnimationFrame(this.frameCallbackHandle);
      }
    }
    this.frameCallbackHandle = null;
  }

  private updateDisplay(): void {
    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;
    if (videoWidth <= 0 || videoHeight <= 0) return;
    const eyeWidth = videoWidth / 2;
    if (this.display.width !== eyeWidth || this.display.height !== videoHeight) {
      this.display.width = eyeWidth;
      this.display.height = videoHeight;
    }
    this.displayCtx.drawImage(this.video, 0, 0, eyeWidth, videoHeight, 0, 0, eyeWidth, videoHeight);
  }

  private async waitUntilReady(): Promise<void> {
    if (this.video.videoWidth > 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.video.removeEventListener('loadedmetadata', onReady);
        this.video.removeEventListener('playing', onReady);
        clearTimeout(timer);
      };
      const onReady = (): void => {
        if (settled || this.video.videoWidth <= 0) return;
        settled = true;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('ZedStereoFrameSource: timed out waiting for video to become ready'));
      }, READY_TIMEOUT_MS);
      this.video.addEventListener('loadedmetadata', onReady);
      this.video.addEventListener('playing', onReady);
    });
  }

  private grabEye(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    sx: number,
    sourceEyeWidth: number,
    sourceEyeHeight: number,
    maxWidth: number,
  ): { width: number; height: number; rgba: Uint8ClampedArray } | null {
    const width = Math.max(1, Math.round(Math.min(maxWidth, sourceEyeWidth)));
    const height = Math.max(1, Math.round((width * sourceEyeHeight) / sourceEyeWidth));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.drawImage(this.video, sx, 0, sourceEyeWidth, sourceEyeHeight, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { width, height, rgba: new Uint8ClampedArray(imageData.data) };
  }

  grab(maxWidth: number): GrabbedFrame | null {
    if (!this.ready) return null;
    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;
    if (videoWidth <= 0 || videoHeight <= 0) return null;
    const eyeWidth = videoWidth / 2;
    const left = this.grabEye(this.leftGrabCanvas, this.leftGrabCtx, 0, eyeWidth, videoHeight, maxWidth);
    if (!left) return null;
    return { width: left.width, height: left.height, rgba: left.rgba, timestamp: performance.now() };
  }

  grabStereo(maxEyeWidth: number): GrabbedFrame | null {
    if (!this.ready) return null;
    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;
    if (videoWidth <= 0 || videoHeight <= 0) return null;
    const eyeWidth = videoWidth / 2;
    const left = this.grabEye(this.leftGrabCanvas, this.leftGrabCtx, 0, eyeWidth, videoHeight, maxEyeWidth);
    const right = this.grabEye(this.rightGrabCanvas, this.rightGrabCtx, eyeWidth, eyeWidth, videoHeight, maxEyeWidth);
    if (!left || !right) return null;
    return { width: left.width, height: left.height, rgba: left.rgba, right: right.rgba, timestamp: performance.now() };
  }
}
