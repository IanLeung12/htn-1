/**
 * Gate E-adjacent: dynamic reality must win over a pretty captured shell - a verified
 * obstruction or a tracking/quality drop must force a visible, intentional fallback
 * rather than silently showing a stale capture - see
 * reality-editor-research-ledger.md "Go / no-go gates" > Gate D and Gate A, and
 * reality-editor-canonical-architecture.md's region state machine.
 *
 * NOTE: `src/app/main.ts` currently never populates `store.current.regions` (it
 * constructs `createRegionStateMachine()` but the result is unused - `void
 * regionMachine;`), so there is no region id to target with `setRegionState` yet. This
 * spec exercises the region-level assertion when a region exists (future-proofing once
 * that wiring lands) and unconditionally exercises the quality-manager fallback path,
 * which *is* wired end to end (`quality.subscribe` -> `applyModeFromQuality` in
 * src/app/main.ts).
 */
import { test, expect } from './fixtures';

test('mode can enter captured-shell when quality allows it', async ({ evalApp }) => {
  await evalApp(() => window.__realityEditor!.quality.force(2));
  const result = await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'setMode', mode: 'captured-shell' }, 'test'));
  expect(result.ok).toBe(true);
  const mode = await evalApp(() => window.__realityEditor!.store.current.mode);
  expect(mode).toBe('captured-shell');
});

test('a region-level obstruction forces LIVE/FALLBACK when a region exists', async ({ evalApp }) => {
  const regionIds = await evalApp(() => Object.keys(window.__realityEditor!.store.current.regions));
  test.skip(regionIds.length === 0, 'No region has been registered yet (src/app/main.ts does not wire up regionMachine output into the store) - nothing to target with setRegionState.');

  const regionId = regionIds[0]!;
  const result = await evalApp(
    (rid) => window.__testHelpers!.dispatchIntent({ kind: 'setRegionState', regionId: rid, state: 'FALLBACK', reason: 'dynamic_obstruction' }, 'test'),
    regionId,
  );
  expect(result.ok).toBe(true);
  const state = await evalApp((rid) => window.__realityEditor!.store.current.regions[rid]?.state, regionId);
  expect(state).toBe('FALLBACK');
});

test('quality manager forces tier 0 and mode falls back to live-overlay when tracking is lost', async ({ evalApp }) => {
  await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'setMode', mode: 'captured-shell' }, 'test'));

  // TRACKING_LOST_STREAK is 10 consecutive trackingOk=false samples (src/core/quality.ts).
  const decision = await evalApp(() => {
    let d = window.__realityEditor!.quality.decision;
    for (let i = 0; i < 12; i++) {
      d = window.__realityEditor!.quality.observe({
        t: performance.now(),
        frameMs: 12,
        depthAgeMs: 0,
        trackingOk: false,
        droppedFrames: 0,
        thermalThrottled: false,
        memoryPressure: false,
        handConfidence: 1,
        registrationErrorM: 0,
      });
    }
    return d;
  });
  expect(decision.tier).toBe(0);
  expect(decision.allowCapturedShell).toBe(false);

  await expect.poll(async () => evalApp(() => window.__realityEditor!.store.current.mode)).toBe('live-overlay');
});
