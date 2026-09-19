/**
 * Gate B (captured layer): registration must stay stable enough that users don't
 * interpret the capture as a second, misaligned room - see reality-editor-research-ledger.md
 * "Go / no-go gates" > Gate B and "Measurement protocol" > Registration.
 *
 * SEM's planes/meshes are static; src/xr/scene-understanding.ts only re-dispatches a
 * surface when `plane.lastChangedTime` changes, so in this emulator surfaces are
 * registered once and never drift - this test pins that behavior down numerically
 * instead of just asserting "no drift" qualitatively.
 */
import { test, expect } from './fixtures';

test('floor and at least one table-like surface are registered from SEM', async ({ evalApp }) => {
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const labels = await evalApp(() => Object.values(window.__realityEditor!.store.current.surfaces).map((s) => s.label));
  expect(labels).toContain('floor');
  expect(labels.some((l) => ['table', 'desk', 'couch', 'shelf', 'bed', 'storage'].includes(l))).toBe(true);
});

test('surface poses do not drift while walking a loop', async ({ evalApp, simPage }) => {
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const before = await evalApp(() =>
    Object.fromEntries(
      Object.entries(window.__realityEditor!.store.current.surfaces).map(([id, s]) => [id, { pose: s.pose, aabb: s.aabb }]),
    ),
  );

  // Walk a ~2m loop around the starting position.
  const loop: [number, number][] = [
    [1, 1.2],
    [1, -0.8],
    [-1, -0.8],
    [-1, 1.2],
    [0, 1.2],
  ];
  for (const [x, z] of loop) {
    await simPage.evaluate(([px, pz]) => window.__sim!.walkTo({ x: px, y: 1.6, z: pz }, 0.05), [x, z] as [number, number]);
  }

  const after = await evalApp(() =>
    Object.fromEntries(
      Object.entries(window.__realityEditor!.store.current.surfaces).map(([id, s]) => [id, { pose: s.pose, aabb: s.aabb }]),
    ),
  );

  const ids = Object.keys(before);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const b = before[id]!;
    const a = after[id];
    expect(a, `surface '${id}' disappeared after walking the loop`).toBeDefined();
    const dx = Math.abs(a!.pose.position.x - b.pose.position.x);
    const dy = Math.abs(a!.pose.position.y - b.pose.position.y);
    const dz = Math.abs(a!.pose.position.z - b.pose.position.z);
    expect(dx, `surface '${id}' drifted in x`).toBeLessThan(1e-6);
    expect(dy, `surface '${id}' drifted in y`).toBeLessThan(1e-6);
    expect(dz, `surface '${id}' drifted in z`).toBeLessThan(1e-6);
  }
});
