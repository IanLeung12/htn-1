import { describe, expect, it } from 'vitest';
import { createQualityManager } from '@/core/quality';
import type { FrameSample } from '@/core/types';

function goodSample(t: number): FrameSample {
  return {
    t,
    frameMs: 10,
    depthAgeMs: 10,
    trackingOk: true,
    droppedFrames: 0,
    thermalThrottled: false,
    memoryPressure: false,
    handConfidence: 1,
    registrationErrorM: 0.01,
  };
}

describe('createQualityManager', () => {
  it('starts at maxTier (default 2) when healthy', () => {
    const qm = createQualityManager();
    expect(qm.decision.tier).toBe(2);
  });

  it('degrades one tier immediately when frame-time p95 exceeds target', () => {
    const qm = createQualityManager({ windowSize: 10, targetFrameMs: 14.2 });
    // Fill the window with slow frames so p95 > target.
    let decision;
    for (let i = 0; i < 10; i++) {
      decision = qm.observe({ ...goodSample(i), frameMs: 30 });
    }
    expect(decision!.tier).toBe(1);
    expect(decision!.reasons).toContain('frame_time');
  });

  it('degrades to tier 0 immediately once tracking is lost for the streak length', () => {
    const qm = createQualityManager();
    let decision;
    for (let i = 0; i < 10; i++) {
      decision = qm.observe({ ...goodSample(i), trackingOk: false });
    }
    expect(decision!.tier).toBe(0);
    expect(decision!.reasons).toContain('tracking');
    expect(decision!.allowCapturedShell).toBe(false);
  });

  it('sets trustDepth=false after depthAgeMs > 200 for 30 consecutive samples without changing tier', () => {
    const qm = createQualityManager();
    let decision;
    for (let i = 0; i < 30; i++) {
      decision = qm.observe({ ...goodSample(i), depthAgeMs: 250 });
    }
    expect(decision!.trustDepth).toBe(false);
    expect(decision!.tier).toBe(2); // unchanged
  });

  it('sets allowCapturedShell=false after low hand confidence for 15 consecutive samples', () => {
    const qm = createQualityManager();
    let decision;
    for (let i = 0; i < 15; i++) {
      decision = qm.observe({ ...goodSample(i), handConfidence: 0.1 });
    }
    expect(decision!.allowCapturedShell).toBe(false);
  });

  it('degrades one tier on memoryPressure and on a dropped-frames burst', () => {
    const qm1 = createQualityManager();
    const d1 = qm1.observe({ ...goodSample(0), memoryPressure: true });
    expect(d1.tier).toBe(1);

    const qm2 = createQualityManager();
    const d2 = qm2.observe({ ...goodSample(0), droppedFrames: 3 });
    expect(d2.tier).toBe(1);
  });

  it('recovers only after recoverSamples consecutive healthy samples (hysteresis: fast down, slow up)', () => {
    const qm = createQualityManager({ recoverSamples: 5, windowSize: 5 });
    // Degrade via a dropped-frame burst.
    let decision = qm.observe({ ...goodSample(0), droppedFrames: 5 });
    expect(decision.tier).toBe(1);

    // A few healthy samples: not enough to recover yet.
    for (let i = 1; i < 5; i++) {
      decision = qm.observe(goodSample(i));
    }
    expect(decision.tier).toBe(1);

    // One more healthy sample reaches recoverSamples consecutive -> upgrade.
    decision = qm.observe(goodSample(5));
    expect(decision.tier).toBe(2);
  });

  it('never exceeds maxTier automatically; force() can go to tier 3 and force(null) releases it', () => {
    const qm = createQualityManager({ maxTier: 2 });
    for (let i = 0; i < 1000; i++) qm.observe(goodSample(i));
    expect(qm.decision.tier).toBeLessThanOrEqual(2);

    const forced = qm.force(3, 'manual');
    expect(forced.tier).toBe(3);

    const released = qm.force(null);
    expect(released.tier).toBeLessThanOrEqual(2);
  });

  it('records history entries on every tier change', () => {
    const qm = createQualityManager();
    qm.observe({ ...goodSample(0), droppedFrames: 5 });
    expect(qm.history.length).toBeGreaterThan(0);
    const entry = qm.history[qm.history.length - 1]!;
    expect(entry.from).toBe(2);
    expect(entry.to).toBe(1);
  });

  it('subscribe is notified on decision change', () => {
    const qm = createQualityManager();
    const seen: number[] = [];
    const unsub = qm.subscribe((decision) => seen.push(decision.tier));
    qm.observe({ ...goodSample(0), droppedFrames: 5 });
    expect(seen).toContain(1);
    unsub();
    qm.observe({ ...goodSample(1), droppedFrames: 5 });
    // no further growth beyond whatever unsub prevented; just check unsub worked by count staying same tier push
    expect(seen.filter((t) => t === 0).length).toBe(0);
  });
});
