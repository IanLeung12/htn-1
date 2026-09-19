import { describe, expect, it } from 'vitest';
import { createFreshnessBus } from '@/core/freshness';

describe('createFreshnessBus', () => {
  it('returns undefined and Infinity age before any publish', () => {
    const bus = createFreshnessBus();
    expect(bus.latest('handPose')).toBeUndefined();
    expect(bus.age('handPose', 1000)).toBe(Infinity);
    expect(bus.isFresh('handPose', 1000, 100)).toBe(false);
  });

  it('publishes and reads back the latest value', () => {
    const bus = createFreshnessBus();
    bus.publish('handPose', { value: 42, timestamp: 100, sceneVersion: 1, confidence: 0.9 });
    const latest = bus.latest<number>('handPose');
    expect(latest?.value).toBe(42);
    expect(bus.age('handPose', 150)).toBe(50);
  });

  it('ignores an out-of-order (older) publish', () => {
    const bus = createFreshnessBus();
    bus.publish('environmentDepth', { value: 'new', timestamp: 200, sceneVersion: 1, confidence: 1 });
    bus.publish('environmentDepth', { value: 'old', timestamp: 100, sceneVersion: 1, confidence: 1 });
    expect(bus.latest<string>('environmentDepth')?.value).toBe('new');
  });

  it('isFresh respects maxAgeMs and minVersion', () => {
    const bus = createFreshnessBus();
    bus.publish('environmentDepth', { value: 1, timestamp: 1000, sceneVersion: 5, confidence: 1 });
    expect(bus.isFresh('environmentDepth', 1050, 100)).toBe(true);
    expect(bus.isFresh('environmentDepth', 1200, 100)).toBe(false); // too old
    expect(bus.isFresh('environmentDepth', 1050, 100, 5)).toBe(true);
    expect(bus.isFresh('environmentDepth', 1050, 100, 6)).toBe(false); // stale scene version
  });
});
