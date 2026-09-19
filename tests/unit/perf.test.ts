import { describe, expect, it } from 'vitest';
import { createPerfTracker } from '@/core/perf';
import type { FrameSample } from '@/core/types';

function sample(frameMs: number, t = 0): FrameSample {
  return {
    t,
    frameMs,
    depthAgeMs: 0,
    trackingOk: true,
    droppedFrames: 0,
    thermalThrottled: false,
    memoryPressure: false,
    handConfidence: 1,
    registrationErrorM: 0,
  };
}

describe('createPerfTracker', () => {
  it('computes percentiles on known data via nearest-rank', () => {
    const tracker = createPerfTracker(1000);
    // 1..100 ms, nearest-rank p50=50, p95=95, p99=99, max=100.
    for (let i = 1; i <= 100; i++) tracker.push(sample(i, i));
    const stats = tracker.stats('frameMs');
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.p99).toBe(99);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBeCloseTo(50.5);
  });

  it('is order-independent of insertion (sorts internally)', () => {
    const tracker = createPerfTracker(10);
    [5, 1, 4, 2, 3].forEach((v) => tracker.push(sample(v)));
    const stats = tracker.stats('frameMs');
    expect(stats.max).toBe(5);
    expect(stats.p50).toBe(3);
  });

  it('wraps around the ring buffer once at capacity', () => {
    const tracker = createPerfTracker(3);
    tracker.push(sample(1, 1));
    tracker.push(sample(2, 2));
    tracker.push(sample(3, 3));
    tracker.push(sample(4, 4)); // evicts the first sample (t=1)
    expect(tracker.size).toBe(3);
    const samples = tracker.samples();
    expect(samples.map((s) => s.t)).toEqual([2, 3, 4]);
  });

  it('reset clears the buffer', () => {
    const tracker = createPerfTracker(5);
    tracker.push(sample(10));
    tracker.reset();
    expect(tracker.size).toBe(0);
    expect(tracker.stats('frameMs').count).toBe(0);
  });

  it('empty tracker returns zeroed stats', () => {
    const tracker = createPerfTracker();
    const stats = tracker.stats('frameMs');
    expect(stats).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
  });
});
