/**
 * Visual smoke: captures what the simulator composes (emulated passthrough + app canvas)
 * in live-overlay and captured-shell modes with spawned objects, a grabbed preview, and a
 * deleted physical object showing its plate. Screenshots land in test-results/screens/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures';

const OUT = path.join(process.cwd(), 'test-results', 'screens');

test('visual smoke screenshots', async ({ evalApp, simPage }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await expect.poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 }).toBeGreaterThan(0);

  await simPage.evaluate(() => {
    window.__sim!.setHead({ x: 0, y: 1.6, z: 1.2 });
    window.__sim!.lookAt({ x: -0.5, y: 0.8, z: -0.5 });
  });
  await simPage.waitForTimeout(400);
  await simPage.screenshot({ path: path.join(OUT, '01-live-overlay.png') });

  for (let i = 0; i < 3; i++) {
    await evalApp((i) => window.__testHelpers!.spawnTestObject({ position: { x: -0.4 + i * 0.4, y: 1.1, z: -0.6 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, { userName: `Cube ${i}`, physical: { massKg: 0.3, friction: 0.5, restitution: 0.1, kinematic: false } }), i);
  }
  await simPage.waitForTimeout(1500);
  await simPage.screenshot({ path: path.join(OUT, '02-spawned-settled.png') });

  await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'setMode', mode: 'captured-shell' }, 'test'));
  await simPage.waitForTimeout(600);
  await simPage.screenshot({ path: path.join(OUT, '03-captured-shell.png') });

  const ids = await evalApp(() => window.__realityEditor!.runCandidateDiscovery());
  const tableId = await evalApp((ids) => ids.find((id) => window.__realityEditor!.store.current.objects[id]!.label === 'table') ?? ids[0], ids);
  await evalApp((id) => window.__testHelpers!.dispatchIntent({ kind: 'approve', objectId: id, approved: true }, 'test'), tableId!);
  const pos = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.currentPose.position, tableId!);
  const vol = await evalApp((p) => { const vs = window.__sim!.listVolumes().filter((v) => v.kind !== 'plane'); let b = vs[0]!; let bd = Infinity; for (const v of vs) { const d = Math.hypot(v.pose.position.x - p.x, v.pose.position.z - p.z); if (d < bd) { bd = d; b = v; } } return b.id; }, pos);
  await evalApp((v) => window.__sim!.hideVolume(v), vol);
  const cap = await evalApp((id) => window.__realityEditor!.captureCleanPlate(id), tableId!);
  await evalApp((v) => window.__sim!.showVolume(v), vol);
  await simPage.evaluate((p) => { window.__sim!.setHead({ x: p.x + 0.3, y: 1.6, z: p.z + 1.6 }); window.__sim!.lookAt({ x: p.x, y: 0.4, z: p.z }); }, pos);
  await simPage.waitForTimeout(300);
  await simPage.screenshot({ path: path.join(OUT, '04-table-before-delete.png') });
  const del = await evalApp((id) => window.__testHelpers!.dispatchIntent({ kind: 'delete', objectId: id }, 'test'), tableId!);
  await simPage.waitForTimeout(400);
  await simPage.screenshot({ path: path.join(OUT, '05-table-deleted.png') });

  // Hand menu: bring the head back to a neutral forward-looking pose, raise
  // the left hand ~0.35m in front of it with the palm turned toward the
  // head, so the palm-up menu (src/render/hand-menu.ts) is visible.
  //
  // IWER's `relaxedHandPose` (the hand's rest pose) bakes a fixed rotation
  // into the wrist joint's offset relative to the hand root, so both the
  // approximate palm normal (cross product of two metacarpal joints, see
  // src/xr/input.ts) and the menu quads' own facing (they inherit the
  // wrist's *orientation* directly, see src/render/hand-menu.ts) are
  // non-trivial functions of the hand root quaternion set via `setPose`.
  // A -66 degree rotation about world +X (found by a small offline search
  // over `relaxedHandPose`'s wrist transform - see docs/ui.md) is the best
  // single-axis balance: the palm normal points ~0.77 toward the head *and*
  // the button quads face ~0.78 toward the camera, so both the visibility
  // gate and the on-screen legibility of the menu are satisfied at once.
  await simPage.evaluate(() => {
    window.__sim!.setHead({ x: 0, y: 1.6, z: 0 });
    window.__sim!.lookAt({ x: 0, y: 1.6, z: -1 });
    window.__sim!.setInputMode('hand');
  });
  const palmTowardHead = { x: -0.5446390350150271, y: 0, z: 0, w: 0.838670567945424 };
  await simPage.evaluate((q) => {
    window.__sim!.hand('left').setPose(q);
    void window.__sim!.hand('left').moveTo({ x: 0, y: 1.6, z: -0.35 }, 0);
  }, palmTowardHead);
  await simPage.waitForTimeout(300);
  await simPage.screenshot({ path: path.join(OUT, '06-hand-menu.png') });

  console.log('SCREENS', JSON.stringify({ cap, del: del.ok, tableId }));
});
