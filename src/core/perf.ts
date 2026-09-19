/**
 * Ring-buffer percentile tracker for frame timing and related metrics.
 */
import type { FrameSample, PerfStats } from './types';
import type { PerfTracker } from './api';

function nearestRank(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return sorted[idx] as number;
}

export function createPerfTracker(capacity = 600): PerfTracker {
  const buffer: FrameSample[] = new Array(capacity);
  let head = 0; // next write index
  let count = 0;

  function ordered(): FrameSample[] {
    if (count < capacity) {
      return buffer.slice(0, count);
    }
    // buffer is full; oldest is at `head`
    return [...buffer.slice(head), ...buffer.slice(0, head)];
  }

  return {
    push(sample: FrameSample): void {
      buffer[head] = sample;
      head = (head + 1) % capacity;
      count = Math.min(count + 1, capacity);
    },

    stats(field: keyof Pick<FrameSample, 'frameMs' | 'depthAgeMs' | 'registrationErrorM'>): PerfStats {
      const values = ordered()
        .map((s) => s[field])
        .filter((v): v is number => Number.isFinite(v))
        .sort((a, b) => a - b);

      if (values.length === 0) {
        return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
      }

      const sum = values.reduce((acc, v) => acc + v, 0);
      return {
        count: values.length,
        p50: nearestRank(values, 50),
        p95: nearestRank(values, 95),
        p99: nearestRank(values, 99),
        max: values[values.length - 1] as number,
        mean: sum / values.length,
      };
    },

    get size(): number {
      return count;
    },

    samples(): readonly FrameSample[] {
      return ordered();
    },

    reset(): void {
      head = 0;
      count = 0;
      buffer.length = 0;
      buffer.length = capacity;
    },
  };
}

export default createPerfTracker;
