/**
 * DepthEstimator that publishes the ZED SDK's depth as received from the
 * bridge: metres along the camera forward axis, holes (and pixels under the
 * confidence threshold) as 0, with the per-pixel confidence map attached.
 * Nothing is estimated here - `submit` ignores the app's frames - so
 * `source` is 'zed-sdk' and the map confidence is a fixed 0.95 (sensor
 * grade; tier A allowed by src/camera/tier-cap.ts) scaled by the valid
 * fraction when the frame is mostly holes.
 */
import type { Pose } from '@/core/types';
import type { DepthEstimator, DepthMap, DepthSample, DepthStatus } from '../contract';
import { resampleDepth } from '../depth/fit';
import type { ZedBridgeClient, DecodedBridgeFrame } from './bridge-client';
import { depthMillimetresToMetres, fovYFromIntrinsics } from './protocol';

export const ZED_SDK_DEPTH_CONFIDENCE = 0.95;
/** Bridge confidence (0..255) a pixel needs to count as measured; the SDK's 0..100 scale maps 100 -> 255. */
const DEFAULT_MIN_CONFIDENCE = 128;
/** Per-frame depth agreement tolerance for the capture pipeline: 2 cm + 1.5 % of the depth. */
function toleranceForMeasuredDepth(depthM: number): number {
  return 0.02 + 0.015 * depthM;
}

export interface ZedSdkDepthEstimatorOptions {
  /** Pose provider so the published map carries the pose of its frame. */
  getPose: () => Pose;
  minConfidence?: number;
  /** Text for diagnostics (depth mode reported by the bridge, e.g. 'NEURAL'). */
  label?: string;
}

export class ZedSdkDepthEstimator implements DepthEstimator {
  readonly status: DepthStatus;
  latest: DepthMap | undefined = undefined;
  /** Fraction of pixels of the newest map with a measured (non-hole, confident) depth. */
  validFraction = 0;
  private readonly minConfidence: number;
  private unsubscribe: (() => void) | null = null;
  private metric: Float32Array | null = null;

  constructor(private readonly client: ZedBridgeClient, private readonly options: ZedSdkDepthEstimatorOptions) {
    this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const stats = client.stats;
    const label = options.label ?? 'zed-sdk';
    this.status = {
      state: 'loading',
      backend: 'bridge',
      get modelId() {
        return `${label} ${stats.fps.toFixed(0)} fps, transport ${stats.transportMs.toFixed(0)} ms, decode ${stats.decodeMs.toFixed(0)} ms${stats.dropped ? `, dropped ${stats.dropped}` : ''}`;
      },
      lastInferenceMs: 0,
      error: null,
      frames: 0,
      lastPublishedAt: -Infinity,
      fitMode: 'measured',
    };
  }

  async start(): Promise<void> {
    this.unsubscribe = this.client.onFrame(this.onFrame);
    this.status.state = this.client.stats.connected ? 'ready' : 'loading';
  }

  private onFrame = (frame: DecodedBridgeFrame): void => {
    const { header, depthMm, confidence } = frame;
    const n = header.depthWidth * header.depthHeight;
    if (depthMm.length < n) return;
    if (!this.metric || this.metric.length !== n) this.metric = new Float32Array(n);
    const t0 = performance.now();
    this.validFraction = depthMillimetresToMetres(depthMm, confidence, this.metric, this.minConfidence);
    const conf = ZED_SDK_DEPTH_CONFIDENCE * (this.validFraction >= 0.5 ? 1 : this.validFraction / 0.5);
    const pose = this.options.getPose();
    this.latest = {
      width: header.depthWidth,
      height: header.depthHeight,
      metric: this.metric,
      confidence: conf,
      source: 'zed-sdk',
      pose: { position: { ...pose.position }, rotation: { ...pose.rotation } },
      fovY: fovYFromIntrinsics(header.fy, header.height),
      aspect: header.width / header.height,
      timestamp: frame.receivedAt,
      confidenceMap: confidence,
    };
    this.status.state = 'ready';
    this.status.frames += 1;
    this.status.lastPublishedAt = frame.receivedAt;
    this.status.lastInferenceMs = performance.now() - t0;
    this.status.error = this.client.stats.error;
  };

  /** Frames are pushed by the bridge; the app's grabbed frames are not used. */
  submit(): boolean {
    return false;
  }

  sample(width: number, height: number, _pose: Pose, _fovY: number, _aspect: number): DepthSample | null {
    const map = this.latest;
    if (!map) return null;
    const metric = resampleDepth(map.metric, map.width, map.height, width, height);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < metric.length; i++) {
      const d = metric[i] as number;
      if (d > 0) {
        sum += d;
        n += 1;
      }
    }
    return { metric, source: 'zed-sdk', confidence: map.confidence, toleranceM: toleranceForMeasuredDepth(n > 0 ? sum / n : 2) };
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.latest = undefined;
    this.status.state = 'idle';
  }
}
