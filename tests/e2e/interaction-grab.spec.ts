/**
 * Interaction loop: grab (pinch), translate, release via hand tracking, and the
 * programmatic grab()/release() path from AppHandle. See
 * reality-editor-research-ledger.md "Measurement protocol" > Interaction.
 */
import { test, expect } from './fixtures';

const CUBE_POSE = { position: { x: 0, y: 1.2, z: -1.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };

test('pinch-grab, translate 0.3m, and release moves the object via the resolver', async ({ evalApp, simPage }) => {
  const objectId = await evalApp(
    (pose) => window.__testHelpers!.spawnTestObject(pose, { label: 'other', userName: 'Grab Test Cube' }),
    CUBE_POSE,
  );

  await evalApp(() => window.__sim!.setInputMode('hand'));
  await simPage.evaluate((pose) => window.__sim!.hand('right').moveTo(pose.position, 0), CUBE_POSE);

  // Let a couple of XR frames elapse so the hand-tracking joint poses (and the app's
  // input.ts, which derives pinch purely from index/thumb joint distance) settle.
  await simPage.waitForTimeout(150);
  await evalApp(() => window.__sim!.hand('right').pinch(true));
  await simPage.waitForTimeout(150);

  const selectedAfterPinch = await evalApp((id) => window.__realityEditor!.store.current.preview?.objectId === id, objectId);
  const target = { x: CUBE_POSE.position.x + 0.3, y: CUBE_POSE.position.y, z: CUBE_POSE.position.z };
  await simPage.evaluate((t) => window.__sim!.hand('right').moveTo(t, 0.3), target);
  await simPage.waitForTimeout(400);

  await evalApp(() => window.__sim!.hand('right').pinch(false));
  await simPage.waitForTimeout(150);

  const finalPose = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.currentPose, objectId);
  expect(selectedAfterPinch, 'object should have entered preview once pinched while hovered').toBe(true);
  expect(Math.abs(finalPose.position.x - target.x)).toBeLessThan(0.05);
  expect(Math.abs(finalPose.position.z - target.z)).toBeLessThan(0.05);
});

test('programmatic grab()/release() path', async ({ evalApp }) => {
  const objectId = await evalApp(
    (pose) => window.__testHelpers!.spawnTestObject(pose, { label: 'other', userName: 'Programmatic Grab Cube' }),
    { position: { x: 1, y: 1.2, z: -1.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  );

  const grabbed = await evalApp((id) => window.__realityEditor!.grab(id, 'right'), objectId);
  expect(grabbed).toBe(true);

  await evalApp((hand) => window.__realityEditor!.release(hand), 'right' as const);

  const stillVisible = await evalApp((id) => window.__realityEditor!.store.current.objects[id]?.visible, objectId);
  expect(stillVisible).toBe(true);
});
