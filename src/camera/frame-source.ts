/**
 * `FrameSource` implementations (see docs/general-camera/architecture.md and
 * `src/camera/contract.ts`): a live webcam via `getUserMedia`
 * (`MediaStreamFrameSource`) and a recorded video via URL or `File`
 * (`VideoFileFrameSource`). Both share a base that owns the `<video>` element,
 * an offscreen 2D canvas for `grab()`, and the "has a real frame" bookkeeping.
 */
import type { CameraAppConfig, CameraIntrinsics, FrameSource, FrameSourceKind, GrabbedFrame } from './contract';

const DEFAULT_ASPECT = 4 / 3;
const READY_TIMEOUT_MS = 10_000;

function makeVideoElement(): HTMLVideoElement {
  const video = document.createElement('video');
  video.style.position = 'absolute';
  video.style.inset = '0';
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'cover';
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  return video;
}

function makeCanvasContext(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('FrameSource: 2D canvas context unavailable');
  return { canvas, ctx };
}

/** Base shared by both frame sources: video element, grab canvas, readiness wait. */
abstract class BaseVideoFrameSource {
  abstract readonly kind: FrameSourceKind;
  readonly video: HTMLVideoElement;
  protected readonly canvas: HTMLCanvasElement;
  protected readonly ctx: CanvasRenderingContext2D;
  protected fovY: number;
  private _lastFrameAt = 0;
  private frameCallbackHandle: number | null = null;

  constructor(fovY: number) {
    this.fovY = fovY;
    this.video = makeVideoElement();
    const { canvas, ctx } = makeCanvasContext();
    this.canvas = canvas;
    this.ctx = ctx;
  }

  get ready(): boolean {
    return this.video.videoWidth > 0 && this.video.readyState >= 2 && !this.video.paused;
  }

  get lastFrameAt(): number {
    return this._lastFrameAt;
  }

  get intrinsics(): CameraIntrinsics {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    const aspect = width > 0 && height > 0 ? width / height : DEFAULT_ASPECT;
    return { fovY: this.fovY, aspect, width, height };
  }

  setFovY(fovY: number): void {
    this.fovY = fovY;
  }

  /** Track frame arrivals via `requestVideoFrameCallback` when available, else `timeupdate`. */
  protected trackFrameArrivals(): void {
    const videoWithRvfc = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (typeof videoWithRvfc.requestVideoFrameCallback === 'function') {
      const step = (): void => {
        this._lastFrameAt = performance.now();
        this.frameCallbackHandle = videoWithRvfc.requestVideoFrameCallback?.(step) ?? null;
      };
      this.frameCallbackHandle = videoWithRvfc.requestVideoFrameCallback(step);
    } else {
      this.video.addEventListener('timeupdate', this.onTimeUpdate);
    }
  }

  private onTimeUpdate = (): void => {
    this._lastFrameAt = performance.now();
  };

  protected stopTrackingFrameArrivals(): void {
    const videoWithRvfc = this.video as HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (this.frameCallbackHandle !== null && typeof videoWithRvfc.cancelVideoFrameCallback === 'function') {
      videoWithRvfc.cancelVideoFrameCallback(this.frameCallbackHandle);
    }
    this.frameCallbackHandle = null;
    this.video.removeEventListener('timeupdate', this.onTimeUpdate);
  }

  /** Wait until the video has real dimensions and has started playing, or reject after a timeout. */
  protected async waitUntilReady(): Promise<void> {
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
        reject(new Error('FrameSource: timed out waiting for video to become ready'));
      }, READY_TIMEOUT_MS);
      this.video.addEventListener('loadedmetadata', onReady);
      this.video.addEventListener('playing', onReady);
    });
  }

  grab(maxWidth: number): GrabbedFrame | null {
    if (!this.ready) return null;
    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;
    if (videoWidth <= 0 || videoHeight <= 0) return null;

    const width = Math.max(1, Math.round(Math.min(maxWidth, videoWidth)));
    const height = Math.max(1, Math.round((width * videoHeight) / videoWidth));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(this.video, 0, 0, width, height);
    const imageData = this.ctx.getImageData(0, 0, width, height);
    return {
      width,
      height,
      rgba: new Uint8ClampedArray(imageData.data),
      timestamp: performance.now(),
    };
  }

  protected detachVideoElement(): void {
    this.video.parentNode?.removeChild(this.video);
  }
}

/** A live camera via `getUserMedia`. */
export class MediaStreamFrameSource extends BaseVideoFrameSource implements FrameSource {
  readonly kind: FrameSourceKind = 'camera';
  private readonly facing: 'environment' | 'user';
  private readonly idealWidth: number;
  private readonly idealHeight: number;
  private stream: MediaStream | null = null;

  constructor(opts: { fovY: number; facing: 'environment' | 'user'; idealWidth?: number; idealHeight?: number }) {
    super(opts.fovY);
    this.facing = opts.facing;
    this.idealWidth = opts.idealWidth ?? 640;
    this.idealHeight = opts.idealHeight ?? 480;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('MediaStreamFrameSource: navigator.mediaDevices.getUserMedia is unavailable (insecure context?)');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: this.facing },
        width: { ideal: this.idealWidth },
        height: { ideal: this.idealHeight },
      },
      audio: false,
    });
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
    this.detachVideoElement();
  }
}

/** A recorded video, from a URL or a local `File`, looped by default. */
export class VideoFileFrameSource extends BaseVideoFrameSource implements FrameSource {
  kind: FrameSourceKind;
  private url: string | undefined;
  private file: File | undefined;
  private readonly loop: boolean;
  private objectUrl: string | null = null;

  constructor(opts: { fovY: number; url?: string; file?: File; loop?: boolean }) {
    super(opts.fovY);
    this.url = opts.url;
    this.file = opts.file;
    this.loop = opts.loop ?? true;
    this.kind = this.file !== undefined ? 'file' : 'url';
    this.video.crossOrigin = 'anonymous';
    this.video.loop = this.loop;
  }

  /** Set (or replace) the source file before calling `start()`. */
  setFile(file: File): void {
    this.file = file;
    this.kind = 'file';
  }

  async start(): Promise<void> {
    let src: string;
    if (this.file !== undefined) {
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = URL.createObjectURL(this.file);
      src = this.objectUrl;
    } else if (this.url !== undefined) {
      src = this.url;
    } else {
      throw new Error('VideoFileFrameSource: no url or file provided');
    }

    this.video.src = src;
    this.video.loop = this.loop;
    this.trackFrameArrivals();
    await this.video.play();
    await this.waitUntilReady();
  }

  stop(): void {
    this.stopTrackingFrameArrivals();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.detachVideoElement();
  }
}

export function createFrameSource(config: Pick<CameraAppConfig, 'source' | 'url' | 'fovY' | 'facing'>): FrameSource {
  switch (config.source) {
    case 'camera':
      return new MediaStreamFrameSource({ fovY: config.fovY, facing: config.facing });
    case 'url':
      if (!config.url) throw new Error('createFrameSource: source "url" requires config.url');
      return new VideoFileFrameSource({ fovY: config.fovY, url: config.url });
    case 'file':
      return new VideoFileFrameSource({ fovY: config.fovY });
    case 'stereo':
      // Constructed by src/camera/app.ts through src/camera/stereo/zed-frame-source.ts (needs device/mode/calibration).
      throw new Error('createFrameSource: stereo sources are created by the app (ZedStereoFrameSource)');
    case 'zed-sdk':
      // Constructed by src/camera/app.ts through src/camera/zedsdk (needs the bridge client).
      throw new Error('createFrameSource: zed-sdk sources are created by the app (ZedSdkFrameSource)');
    default: {
      const exhaustive: never = config.source;
      throw new Error(`createFrameSource: unknown source kind ${String(exhaustive)}`);
    }
  }
}
