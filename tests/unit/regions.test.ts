import { describe, expect, it } from 'vitest';
import { createRegionStateMachine } from '@/core/regions';
import type { Region } from '@/core/types';

function makeRegion(partial?: Partial<Region>): Region {
  return {
    id: 'r1',
    bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    state: 'CAPTURED',
    reason: 'none',
    surfaces: [],
    objects: [],
    since: 0,
    ...partial,
  };
}

describe('createRegionStateMachine', () => {
  it('request: LIVE -> CAPTURED requires trackingOk/reason none', () => {
    const sm = createRegionStateMachine();
    const live = makeRegion({ state: 'LIVE', reason: 'none' });
    const captured = sm.request(live, 'CAPTURED', 'none', 100);
    expect(captured.state).toBe('CAPTURED');
    expect(captured.since).toBe(100);

    const liveAgain = makeRegion({ state: 'LIVE', reason: 'none' });
    const rejected = sm.request(liveAgain, 'CAPTURED', 'tracking_lost', 100);
    expect(rejected.state).toBe('LIVE'); // illegal, unchanged
  });

  it('request: anything -> FALLBACK always allowed', () => {
    const sm = createRegionStateMachine();
    for (const state of ['LIVE', 'CAPTURED', 'HYBRID', 'TRANSITION'] as const) {
      const region = makeRegion({ state });
      const next = sm.request(region, 'FALLBACK', 'budget', 50);
      expect(next.state).toBe('FALLBACK');
      expect(next.reason).toBe('budget');
    }
  });

  it('request: FALLBACK -> LIVE always allowed', () => {
    const sm = createRegionStateMachine();
    const fb = makeRegion({ state: 'FALLBACK', reason: 'tracking_lost' });
    const next = sm.request(fb, 'LIVE', 'none', 10);
    expect(next.state).toBe('LIVE');
  });

  it('request: CAPTURED<->HYBRID allowed; TRANSITION -> CAPTURED/HYBRID allowed', () => {
    const sm = createRegionStateMachine();
    const captured = makeRegion({ state: 'CAPTURED' });
    expect(sm.request(captured, 'HYBRID', 'dynamic_obstruction', 5).state).toBe('HYBRID');

    const hybrid = makeRegion({ state: 'HYBRID', reason: 'dynamic_obstruction' });
    expect(sm.request(hybrid, 'CAPTURED', 'none', 5).state).toBe('CAPTURED');

    const transition = makeRegion({ state: 'TRANSITION', reason: 'evidence_expired' });
    expect(sm.request(transition, 'CAPTURED', 'none', 5).state).toBe('CAPTURED');
    expect(sm.request(transition, 'HYBRID', 'dynamic_obstruction', 5).state).toBe('HYBRID');
  });

  it('request: illegal transitions are rejected (region returned unchanged)', () => {
    const sm = createRegionStateMachine();
    const live = makeRegion({ state: 'LIVE' });
    const next = sm.request(live, 'TRANSITION', 'none', 5);
    expect(next).toBe(live);
  });

  it('reportObstruction forces CAPTURED -> HYBRID with dynamic_obstruction', () => {
    const sm = createRegionStateMachine();
    const captured = makeRegion({ state: 'CAPTURED', since: 0 });
    const next = sm.reportObstruction(captured, 100);
    expect(next.state).toBe('HYBRID');
    expect(next.reason).toBe('dynamic_obstruction');
    expect(next.since).toBe(100);
  });

  it('obstruction persisting past obstructionHoldMs escalates HYBRID -> FALLBACK', () => {
    const sm = createRegionStateMachine({ obstructionHoldMs: 500 });
    let region = makeRegion({ state: 'CAPTURED' });
    region = sm.reportObstruction(region, 0); // -> HYBRID at t=0
    expect(region.state).toBe('HYBRID');
    region = sm.reportObstruction(region, 499); // still under hold
    expect(region.state).toBe('HYBRID');
    region = sm.reportObstruction(region, 500); // hold exceeded
    expect(region.state).toBe('FALLBACK');
    expect(region.reason).toBe('dynamic_obstruction');
  });

  it('tick escalates HYBRID -> FALLBACK when depth goes stale beyond depthStaleMs', () => {
    const sm = createRegionStateMachine({ depthStaleMs: 150 });
    let region = makeRegion({ state: 'CAPTURED' });
    region = sm.reportObstruction(region, 0);
    expect(region.state).toBe('HYBRID');
    region = sm.tick(region, 10, 200, true); // depth stale
    expect(region.state).toBe('FALLBACK');
    expect(region.reason).toBe('depth_stale');
  });

  it('tick: tracking lost forces FALLBACK from any state', () => {
    const sm = createRegionStateMachine();
    const hybrid = makeRegion({ state: 'HYBRID', reason: 'dynamic_obstruction' });
    const next = sm.tick(hybrid, 10, 0, false);
    expect(next.state).toBe('FALLBACK');
    expect(next.reason).toBe('tracking_lost');
  });

  it('obstruction evidence expires after obstructionHoldMs and region returns to CAPTURED via TRANSITION', () => {
    const sm = createRegionStateMachine({ obstructionHoldMs: 500 });
    let region = makeRegion({ state: 'CAPTURED' });
    region = sm.reportObstruction(region, 0); // HYBRID at t=0, last obstruction seen at 0
    expect(region.state).toBe('HYBRID');

    // No further obstruction reports; tick as time passes with good tracking/depth.
    region = sm.tick(region, 100, 0, true);
    expect(region.state).toBe('HYBRID'); // evidence not yet expired

    region = sm.tick(region, 600, 0, true); // 600ms since last report >= holdMs
    expect(region.state).toBe('TRANSITION');
    expect(region.reason).toBe('evidence_expired');

    region = sm.tick(region, 601, 0, true); // next tick resolves TRANSITION -> CAPTURED
    expect(region.state).toBe('CAPTURED');
    expect(region.reason).toBe('none');
  });
});
