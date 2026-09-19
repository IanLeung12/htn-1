/**
 * InjectableDepthEstimator: a test seam (`?depth=injected`). Tests push a
 * synthetic DepthMap through `inject()` and the app treats it exactly like a
 * model result (surface estimation, capture frames, tier caps). It never
 * produces depth on its own, so nothing about it can leak into a real run
 * unless the page was opened with the flag.
 */
import type { Pose } from '@/core/types';
import type { DepthEstimator, DepthMap, DepthSample, DepthStatus } from '../contract';
import { resampleDepth } from './fit';
import { toleranceForEstimatedDepth } from './prior';

export class InjectableDepthEstimator implements DepthEstimator {
  readonly status: DepthStatus = { state: 'ready', backend: 'analytic', modelId: 'injected', lastInferenceMs: 0, error: null };
  latest: DepthMap | undefined = undefined;

  async start(): Promise<void> {
    this.status.state = 'ready';
  }

  /** Make `map` the newest depth; `timestamp` defaults to now so age checks pass. */
  inject(map: Omit<DepthMap, 'timestamp'> & { timestamp?: number }): void {
    this.latest = { ...map, timestamp: map.timestamp ?? performance.now() };
  }

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
    return { metric, source: map.source, confidence: map.confidence, toleranceM: toleranceForEstimatedDepth(n > 0 ? sum / n : 2) };
  }

  dispose(): void {
    this.latest = undefined;
  }
}
