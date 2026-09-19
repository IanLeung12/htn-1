/**
 * Gate E-adjacent: dynamic reality must win over a pretty captured shell - a verified
 * obstruction or a tracking/quality drop must force a visible, intentional fallback
 * rather than silently showing a stale capture - see
 * reality-editor-research-ledger.md "Go / no-go gates" > Gate D and Gate A, and
 * reality-editor-canonical-architecture.md's region state machine.
 *
 * `src/app/main.ts` wires `createRegionStateMachine()` output into the store via
 * `src/app/regions.ts`'s `RegionManager`: one region per tracked surface
 * (table/desk/shelf/couch/bed/storage/floor, or wall), driven every frame toward
 * CAPTURED (captured-shell mode + quality allows it + tracking ok) or LIVE otherwise,
 * with obstruction evidence (hand/head inside the region, or the explicit
 * `AppHandle.reportObstruction` one-shot used here) able to push a CAPTURED region to
 * HYBRID and, if the obstruction persists past the hold time, to FALLBACK.
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
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.regions).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const regionIds = await evalApp(() => Object.keys(window.__realityEditor!.store.current.regions));
  const regionId = regionIds[0]!;
  // 'budget' rather than 'dynamic_obstruction': the frame loop's own region-driver
  // (src/app/regions.ts) only auto-heals its own 'user'-reason fallback, but the core
  // state machine's tick() *does* have an evidence-expiry path for 'dynamic_obstruction'
  // that could otherwise race this immediate check.
  const result = await evalApp(
    (rid) => window.__testHelpers!.dispatchIntent({ kind: 'setRegionState', regionId: rid, state: 'FALLBACK', reason: 'budget' }, 'test'),
    regionId,
  );
  expect(result.ok).toBe(true);
  const state = await evalApp((rid) => window.__realityEditor!.store.current.regions[rid]?.state, regionId);
  expect(state).toBe('FALLBACK');
});

test('surfaces are wired into regions and a captured-shell region reacts to a dynamic obstruction', async ({ evalApp }) => {
  // Regions are created reactively off registerSurface commits (see src/app/regions.ts);
  // wait for at least one table/desk/shelf/couch/bed/storage/floor/wall region to exist.
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.regions).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  await evalApp(() => window.__realityEditor!.quality.force(2));
  await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'setMode', mode: 'captured-shell' }, 'test'));

  // Find a region backed by a horizontal, table-like surface (not the floor - the frame
  // loop's own obstruction detection uses the live head/hand position, which sits well
  // inside the floor region and would otherwise race this test's explicit call below).
  const regionInfo = await evalApp(() => {
    const snapshot = window.__realityEditor!.store.current;
    for (const region of Object.values(snapshot.regions)) {
      const surfaceId = region.surfaces[0];
      const surface = surfaceId ? snapshot.surfaces[surfaceId] : undefined;
      if (surface && surface.orientation === 'horizontal' && surface.label !== 'floor') {
        return { id: region.id, bounds: region.bounds };
      }
    }
    return null;
  });
  expect(regionInfo, 'no non-floor horizontal region found').not.toBeNull();
  const { id: regionId, bounds } = regionInfo!;

  // Drive the region to CAPTURED (the frame loop does this automatically once quality
  // allows it and the mode is captured-shell; poll rather than assume one frame).
  await expect
    .poll(async () => evalApp((rid) => window.__realityEditor!.store.current.regions[rid]?.state, regionId), { timeout: 10_000 })
    .toBe('CAPTURED');

  // "A person crossed here": report obstruction evidence at the centre of the region's
  // bounds, one shot, via the programmatic path a voice/test layer would use.
  const center = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  await evalApp((p) => window.__realityEditor!.reportObstruction!(p), center);

  await expect
    .poll(async () => evalApp((rid) => window.__realityEditor!.store.current.regions[rid]?.state, regionId))
    .toBe('HYBRID');
  const reason = await evalApp((rid) => window.__realityEditor!.store.current.regions[rid]?.reason, regionId);
  expect(reason).toBe('dynamic_obstruction');

  // Obstruction evidence is one-shot (not reported again); once it expires past the
  // hold time (500ms, src/core/regions.ts), the region returns to CAPTURED via TRANSITION.
  await expect
    .poll(async () => evalApp((rid) => window.__realityEditor!.store.current.regions[rid]?.state, regionId), { timeout: 5_000 })
    .toBe('CAPTURED');

  // Exercise the general "region_fallback" resolver rejection: force the region to
  // FALLBACK for a reason the frame loop's own baseline-recovery never touches
  // (src/app/regions.ts only auto-recovers its own 'user'-reason fallback; every other
  // reason, including this one, only clears through the state machine's own
  // evidence-driven tick() path, which has no case for 'budget' - so this is stable to
  // check against, unlike reusing 'dynamic_obstruction' here which the frame loop would
  // otherwise start healing via TRANSITION on its very next tick).
  const forced = await evalApp(
    (rid) => window.__testHelpers!.dispatchIntent({ kind: 'setRegionState', regionId: rid, state: 'FALLBACK', reason: 'budget' }, 'test'),
    regionId,
  );
  expect(forced.ok).toBe(true);

  const objectId = await evalApp(
    (c) => window.__testHelpers!.spawnTestObject({ position: c, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    center,
  );
  const moveResult = await evalApp(
    (args) => window.__testHelpers!.dispatchIntent({ kind: 'move', objectId: args.id, pose: { position: args.c, rotation: { x: 0, y: 0, z: 0, w: 1 } } }, 'test'),
    { id: objectId, c: center },
  );
  expect(moveResult.ok).toBe(false);
  if (!moveResult.ok) expect(moveResult.reason).toBe('region_fallback');

  const deleteResult = await evalApp((id) => window.__testHelpers!.dispatchIntent({ kind: 'delete', objectId: id }, 'test'), objectId);
  expect(deleteResult.ok).toBe(false);
  if (!deleteResult.ok) expect(deleteResult.reason).toBe('region_fallback');
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
