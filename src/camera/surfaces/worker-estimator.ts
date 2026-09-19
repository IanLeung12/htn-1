/**
 * WorkerSurfaceEstimator: the same SurfaceEstimator surface as
 * DepthSurfaceEstimator, computed in a Web Worker (surfaces/worker.ts).
 * `update` posts a new depth map when none is in flight and returns
 * immediately; results land on the next message. Without Worker support
 * (vitest/node, exotic browsers) it degrades to the in-process estimator.
 */
import type { Millis, Pose } from '@/core/types';
import type { DepthMap, EstimatedSurface, SurfaceEstimator } from '../contract';
import type { DetectedVolume } from '@/capture/contract';
import { DepthSurfaceEstimator, type DepthSurfaceStats, type FrameCorrection, type SurfaceTuning } from './depth-surfaces';

export interface WorkerSurfaceEstimatorOptions {
  cameraHeightM: number;
  getTuning: () => SurfaceTuning;
  /** Force the in-process estimator (tests). */
  inline?: boolean;
}

interface ResultMessage {
  type: 'result';
  surfaces: EstimatedSurface[];
  volumes: DetectedVolume[];
  correction: FrameCorrection | null;
  cameraHeightM: number;
  lastStats: DepthSurfaceStats;
  lastRunAt: number;
}

export class WorkerSurfaceEstimator implements SurfaceEstimator {
  private readonly inline: DepthSurfaceEstimator | null;
  private worker: Worker | null = null;
  private busy = false;
  private heightM: number;
  private readonly getTuning: () => SurfaceTuning;
  private lastSentTimestamp = -Infinity;
  private lastSentAt = -Infinity;

  surfaces: readonly EstimatedSurface[];
  volumes: readonly DetectedVolume[] = [];
  correction: FrameCorrection | null = null;
  lastStats: DepthSurfaceStats = { points: 0, floorInliers: 0, tables: 0, walls: 0, volumes: 0, runMs: 0 };
  lastRunAt = -Infinity;
  /** Which path is active, for diagnostics. */
  readonly mode: 'worker' | 'inline';

  constructor(opts: WorkerSurfaceEstimatorOptions) {
    this.heightM = opts.cameraHeightM;
    this.getTuning = opts.getTuning;
    const canWorker = !opts.inline && typeof Worker !== 'undefined';
    if (canWorker) {
      try {
        this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (event: MessageEvent<ResultMessage>) => this.onResult(event.data);
        this.worker.onerror = () => {
          // Fall back to inline on a broken worker; the next update() takes the inline path.
          this.worker?.terminate();
          this.worker = null;
          this.busy = false;
        };
      } catch {
        this.worker = null;
      }
    }
    this.inline = this.worker ? null : new DepthSurfaceEstimator({ cameraHeightM: opts.cameraHeightM, getTuning: opts.getTuning });
    this.mode = this.worker ? 'worker' : 'inline';
    this.surfaces = this.inline ? this.inline.surfaces : [];
    if (!this.inline) {
      // Publish the floor prior immediately, like the inline estimator does.
      const prior = new DepthSurfaceEstimator({ cameraHeightM: opts.cameraHeightM, getTuning: opts.getTuning });
      this.surfaces = prior.surfaces;
    }
  }

  get cameraHeightM(): number {
    return this.inline ? this.inline.cameraHeightM : this.heightM;
  }

  setHeight(h: number): void {
    this.heightM = h;
    this.inline?.setHeight(h);
  }

  update(depth: DepthMap | undefined, pose: Pose, now: Millis): void {
    if (this.inline || !this.worker) {
      const est = this.inline ?? this.ensureInline();
      est.update(depth, pose, now);
      this.surfaces = est.surfaces;
      this.volumes = est.volumes;
      this.correction = est.correction;
      this.lastStats = est.lastStats;
      this.lastRunAt = est.lastRunAt;
      return;
    }
    if (!depth || this.busy) return;
    if (depth.confidence < 0.2) return;
    if (!(depth.timestamp > this.lastSentTimestamp)) return;
    if (now - this.lastSentAt < this.getTuning().surfaceIntervalMs) return;
    this.busy = true;
    this.lastSentTimestamp = depth.timestamp;
    this.lastSentAt = now;
    const metric = new Float32Array(depth.metric); // copy: the map stays usable on the main thread
    this.worker.postMessage(
      { type: 'update', map: { ...depth, metric: metric.buffer }, tuning: this.getTuning(), now, cameraHeightM: this.heightM },
      [metric.buffer],
    );
  }

  private inlineFallback: DepthSurfaceEstimator | null = null;
  private ensureInline(): DepthSurfaceEstimator {
    if (!this.inlineFallback) this.inlineFallback = new DepthSurfaceEstimator({ cameraHeightM: this.heightM, getTuning: this.getTuning });
    return this.inlineFallback;
  }

  private onResult(msg: ResultMessage): void {
    this.busy = false;
    if (msg.type !== 'result') return;
    this.surfaces = msg.surfaces;
    this.volumes = msg.volumes;
    this.correction = msg.correction;
    this.heightM = msg.cameraHeightM;
    this.lastStats = msg.lastStats;
    this.lastRunAt = msg.lastRunAt;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
