/**
 * Gate D (truthful delete): deletion must stay plausible - a clean plate has to be
 * observed with enough coverage before an object can move or be deleted, and the
 * resolver must refuse to touch objects that were never captured - see
 * reality-editor-research-ledger.md "Go / no-go gates" > Gate D, and
 * reality-editor-capture-and-editability.md for the tier model.
 *
 * `sim.hideVolume(id)` / `showVolume(id)` emulate "the user physically lifted the
 * object away" for clean-plate capture: SEM keeps entities in a private `objectMap`
 * (see src/sim/bootstrap.ts header comment); toggling `.visible` on that entity affects
 * both the rendered environmentCanvas and computeDepthBuffer, which is exactly what the
 * capture pipeline's CameraFrameSource reads.
 */
import { test, expect } from './fixtures';

test('approve, clean-plate capture, delete, restore, undo/redo round-trip', async ({ evalApp, simPage }) => {
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const ids = await evalApp(() => window.__realityEditor!.runCandidateDiscovery());
  expect(ids.length).toBeGreaterThanOrEqual(1);
  const objectId = ids[0]!;

  const approveResult = await evalApp(
    (id) => window.__testHelpers!.dispatchIntent({ kind: 'approve', objectId: id, approved: true }, 'test'),
    objectId,
  );
  expect(approveResult.ok).toBe(true);

  // Move the head to a good vantage point above the object's support surface, looking
  // down at the exposed footprint (not just the object's own center height), so a single
  // guided-capture viewpoint sees as much of it as the emulator's fixed-resolution camera
  // source can resolve.
  const objectInfo = await evalApp((id) => {
    const o = window.__realityEditor!.store.current.objects[id]!;
    const supportId = o.supportSurfaces[0];
    const support = supportId ? window.__realityEditor!.store.current.surfaces[supportId] : undefined;
    return { position: o.currentPose.position, floorY: support ? support.aabb.max.y : o.currentPose.position.y };
  }, objectId);
  await simPage.evaluate((info) => {
    const target = { x: info.position.x, y: info.floorY, z: info.position.z };
    window.__sim!.setHead({ x: target.x, y: target.y + 1.5, z: target.z + 0.6 });
    window.__sim!.lookAt(target);
  }, objectInfo);

  // Find the SEM volume backing this object (discovery re-ids everything - see
  // src/xr/scene-understanding.ts's own `plane-N`/`mesh-N` ids - so match by nearest
  // pose instead of assuming the ids line up) and hide it, so the clean-plate capture
  // observes an empty support surface, like the physical object having been lifted away.
  const volumeId = await evalApp((pos) => {
    const volumes = window.__sim!.listVolumes();
    let best: string | undefined;
    let bestDist = Infinity;
    for (const v of volumes) {
      const dx = v.pose.position.x - pos.x;
      const dy = v.pose.position.y - pos.y;
      const dz = v.pose.position.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < bestDist) {
        bestDist = d;
        best = v.id;
      }
    }
    return best;
  }, objectInfo.position);
  expect(volumeId, 'no SEM volume found near the discovered object pose').toBeDefined();
  await evalApp((vid) => window.__sim!.hideVolume(vid), volumeId!);

  // Guided multi-viewpoint capture (src/app/guide.ts's arc of 4 viewpoints around the
  // exposed footprint, verified from 3 off-path viewpoints) sees enough of the exposed
  // support surface from this one vantage point to reach tier A with near-total coverage,
  // stronger than the single-viewpoint capture this test used to exercise.
  const captureResult = await evalApp((id) => window.__realityEditor!.captureCleanPlate(id), objectId);
  expect(captureResult.tier).toBe('A');
  expect(captureResult.coverage).toBeGreaterThanOrEqual(0.95);

  await evalApp((vid) => window.__sim!.showVolume(vid), volumeId!);

  const deleteResult = await evalApp(
    (id) => window.__testHelpers!.dispatchIntent({ kind: 'delete', objectId: id }, 'test'),
    objectId,
  );
  expect(deleteResult.ok, JSON.stringify(deleteResult)).toBe(true);

  const visibleAfterDelete = await evalApp((id) => window.__realityEditor!.store.current.objects[id]?.visible, objectId);
  expect(visibleAfterDelete).toBe(false);

  const restoreResult = await evalApp(
    (id) => window.__testHelpers!.dispatchIntent({ kind: 'restore', objectId: id }, 'test'),
    objectId,
  );
  expect(restoreResult.ok).toBe(true);
  const visibleAfterRestore = await evalApp((id) => window.__realityEditor!.store.current.objects[id]?.visible, objectId);
  expect(visibleAfterRestore).toBe(true);

  const undoResult = await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'undo' }, 'test'));
  expect(undoResult.ok, JSON.stringify(undoResult)).toBe(true);
  const visibleAfterUndo = await evalApp((id) => window.__realityEditor!.store.current.objects[id]?.visible, objectId);
  expect(visibleAfterUndo).toBe(false); // undo of restore => back to deleted

  const redoResult = await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'redo' }, 'test'));
  expect(redoResult.ok, JSON.stringify(redoResult)).toBe(true);
  const visibleAfterRedo = await evalApp((id) => window.__realityEditor!.store.current.objects[id]?.visible, objectId);
  expect(visibleAfterRedo).toBe(true);
});

test('delete is rejected for an un-captured (tier E) object', async ({ evalApp }) => {
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const ids = await evalApp(() => window.__realityEditor!.runCandidateDiscovery());
  expect(ids.length).toBeGreaterThanOrEqual(1);
  const objectId = ids[0]!;

  // Approve but never run captureCleanPlate: object stays at tier E with no
  // background evidence, exactly the case the resolver must refuse.
  const approveResult = await evalApp(
    (id) => window.__testHelpers!.dispatchIntent({ kind: 'approve', objectId: id, approved: true }, 'test'),
    objectId,
  );
  expect(approveResult.ok).toBe(true);

  const tier = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.tier, objectId);
  expect(tier).toBe('E');

  const deleteResult = await evalApp(
    (id) => window.__testHelpers!.dispatchIntent({ kind: 'delete', objectId: id }, 'test'),
    objectId,
  );
  expect(deleteResult.ok).toBe(false);
  if (!deleteResult.ok) {
    // Tier E forbids 'delete' outright (TIER_CAPABILITIES), so the resolver rejects on
    // the tier check before it ever reaches the background-evidence check.
    expect(['tier_forbids', 'no_background_evidence']).toContain(deleteResult.reason);
  }
});

test('guided capture walks handle.guide through its steps and ends inactive', async ({ evalApp, simPage }) => {
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const ids = await evalApp(() => window.__realityEditor!.runCandidateDiscovery());
  expect(ids.length).toBeGreaterThanOrEqual(1);
  const objectId = ids[0]!;
  await evalApp(
    (id) => window.__testHelpers!.dispatchIntent({ kind: 'approve', objectId: id, approved: true }, 'test'),
    objectId,
  );

  const objectInfo = await evalApp((id) => {
    const o = window.__realityEditor!.store.current.objects[id]!;
    const supportId = o.supportSurfaces[0];
    const support = supportId ? window.__realityEditor!.store.current.surfaces[supportId] : undefined;
    return { position: o.currentPose.position, floorY: support ? support.aabb.max.y : o.currentPose.position.y };
  }, objectId);
  await simPage.evaluate((info) => {
    const target = { x: info.position.x, y: info.floorY, z: info.position.z };
    window.__sim!.setHead({ x: target.x, y: target.y + 1.5, z: target.z + 0.6 });
    window.__sim!.lookAt(target);
  }, objectInfo);

  expect(await evalApp(() => window.__realityEditor!.guide?.active ?? false)).toBe(false);

  // Sample handle.guide from inside the page while captureCleanPlate runs. The
  // simulator's capture() calls are async-but-fast (no real timers), so a macrotask
  // poll (setInterval/rAF) would never get a turn before the whole pipeline finishes;
  // instead re-queue a microtask each turn, which interleaves with the pipeline's own
  // `await source.capture(...)` continuations (also microtasks) closely enough to
  // observe each step src/app/guide.ts's wrapped source advances through.
  const observed = await evalApp(
    (id) =>
      new Promise<{ steps: number[]; total: number; finalActive: boolean }>((resolve) => {
        const steps: number[] = [];
        let total = 0;
        let done = false;
        function sample(): void {
          const g = window.__realityEditor!.guide;
          if (g?.active) {
            total = g.total;
            if (steps[steps.length - 1] !== g.step) steps.push(g.step);
          }
          if (!done) void Promise.resolve().then(sample);
        }
        sample();
        window.__realityEditor!.captureCleanPlate(id).then(() => {
          done = true;
          resolve({ steps, total, finalActive: window.__realityEditor!.guide?.active ?? false });
        });
      }),
    objectId,
  );

  expect(observed.total).toBeGreaterThan(1);
  expect(observed.steps.length).toBeGreaterThan(0);
  expect(Math.max(0, ...observed.steps)).toBeLessThanOrEqual(observed.total);
  // Steps only increase while active (never resets mid-capture).
  for (let i = 1; i < observed.steps.length; i++) {
    expect(observed.steps[i]).toBeGreaterThan(observed.steps[i - 1]!);
  }
  expect(observed.finalActive).toBe(false);
  expect(await evalApp(() => window.__realityEditor!.guide?.active ?? false)).toBe(false);
});
