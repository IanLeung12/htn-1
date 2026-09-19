/**
 * Two-hand manipulation: grab with one hand, pinch the same object with the
 * other hand while hovering it, then move/rotate/scale via the combined
 * hand-pair delta (src/app/two-hand.ts + src/app/interaction.ts). See
 * reality-editor-canonical-architecture.md "Interaction transaction".
 */
import { test, expect } from './fixtures';

const CENTER = { x: 0, y: 1.2, z: -1.5 };
const CUBE_POSE = { position: CENTER, rotation: { x: 0, y: 0, z: 0, w: 1 } };

/** Half the initial/final hand-to-hand distances used below (m); both stay inside the
 * spawned cube's default 0.08m interaction-proxy half-extent so each hand's ray origin
 * is "inside" the proxy and counts as hovering it (see isGraspable/originInside). */
const HALF_NEAR = 0.05;

async function settle(simPage: import('@playwright/test').Page, ms = 150): Promise<void> {
  await simPage.waitForTimeout(ms);
}

test('two-hand grab: moving hands apart doubles scale, position unchanged', async ({ evalApp, simPage }) => {
  const objectId = await evalApp(
    (pose) => window.__testHelpers!.spawnTestObject(pose, { label: 'other', userName: 'Two-Hand Cube', tier: 'A' }),
    CUBE_POSE,
  );

  await evalApp(() => window.__sim!.setInputMode('hand'));

  await simPage.evaluate(
    (p) => window.__sim!.hand('right').moveTo(p, 0),
    { x: CENTER.x + HALF_NEAR, y: CENTER.y, z: CENTER.z },
  );
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('right').pinch(true));
  await settle(simPage);

  const grabbedAfterRight = await evalApp((id) => window.__realityEditor!.store.current.preview?.objectId === id, objectId);
  expect(grabbedAfterRight, 'right hand should enter single-hand preview').toBe(true);

  await simPage.evaluate(
    (p) => window.__sim!.hand('left').moveTo(p, 0),
    { x: CENTER.x - HALF_NEAR, y: CENTER.y, z: CENTER.z },
  );
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('left').pinch(true));
  await settle(simPage);

  // Move both hands apart symmetrically about the (unchanged) midpoint, doubling the
  // hand-to-hand distance from 0.1m to 0.2m.
  await Promise.all([
    simPage.evaluate((p) => window.__sim!.hand('right').moveTo(p, 0.3), { x: CENTER.x + HALF_NEAR * 2, y: CENTER.y, z: CENTER.z }),
    simPage.evaluate((p) => window.__sim!.hand('left').moveTo(p, 0.3), { x: CENTER.x - HALF_NEAR * 2, y: CENTER.y, z: CENTER.z }),
  ]);
  await settle(simPage, 400);

  await evalApp(() => window.__sim!.hand('right').pinch(false));
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('left').pinch(false));
  await settle(simPage);

  const obj = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!, objectId);
  expect(obj.interactionProxy.kind).toBe('box');
  const halfExtentX = (obj.interactionProxy as { kind: 'box'; halfExtents: { x: number } }).halfExtents.x;
  expect(halfExtentX).toBeGreaterThan(0.16 * 0.9);
  expect(halfExtentX).toBeLessThan(0.16 * 1.1);
  expect(Math.abs(obj.currentPose.position.x - CENTER.x)).toBeLessThan(0.05);
  expect(Math.abs(obj.currentPose.position.y - CENTER.y)).toBeLessThan(0.05);
  expect(Math.abs(obj.currentPose.position.z - CENTER.z)).toBeLessThan(0.05);
});

test('two-hand grab: rotating hands 90 degrees about the midpoint yaws the object', async ({ evalApp, simPage }) => {
  const objectId = await evalApp(
    (pose) => window.__testHelpers!.spawnTestObject(pose, { label: 'other', userName: 'Two-Hand Rotate Cube', tier: 'A' }),
    CUBE_POSE,
  );

  await evalApp(() => window.__sim!.setInputMode('hand'));

  await simPage.evaluate((p) => window.__sim!.hand('right').moveTo(p, 0), { x: CENTER.x + HALF_NEAR, y: CENTER.y, z: CENTER.z });
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('right').pinch(true));
  await settle(simPage);

  await simPage.evaluate((p) => window.__sim!.hand('left').moveTo(p, 0), { x: CENTER.x - HALF_NEAR, y: CENTER.y, z: CENTER.z });
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('left').pinch(true));
  await settle(simPage);

  // Rotate the hand-to-hand vector 90 degrees about world Y around the (fixed) midpoint:
  // (HALF_NEAR, 0, 0) -> (0, 0, -HALF_NEAR), matching quatFromAxisAngle(Y, +90deg)'s convention.
  await Promise.all([
    simPage.evaluate((p) => window.__sim!.hand('right').moveTo(p, 0.3), { x: CENTER.x, y: CENTER.y, z: CENTER.z - HALF_NEAR }),
    simPage.evaluate((p) => window.__sim!.hand('left').moveTo(p, 0.3), { x: CENTER.x, y: CENTER.y, z: CENTER.z + HALF_NEAR }),
  ]);
  await settle(simPage, 400);

  await evalApp(() => window.__sim!.hand('right').pinch(false));
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('left').pinch(false));
  await settle(simPage);

  const rotation = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.currentPose.rotation, objectId);
  // quatFromAxisAngle({x:0,y:1,z:0}, PI/2) = { x:0, y: sin(pi/4), z:0, w: cos(pi/4) }.
  expect(Math.abs(rotation.y - Math.SQRT1_2)).toBeLessThan(0.1);
  expect(Math.abs(rotation.w - Math.SQRT1_2)).toBeLessThan(0.1);
});

test('two-hand grab on a tier C object: scale is ignored but move still commits', async ({ evalApp, simPage }) => {
  const objectId = await evalApp(
    (pose) => window.__testHelpers!.spawnTestObject(pose, { label: 'other', userName: 'Two-Hand Tier C Cube', tier: 'C' }),
    CUBE_POSE,
  );

  await evalApp(() => window.__sim!.setInputMode('hand'));

  await simPage.evaluate((p) => window.__sim!.hand('right').moveTo(p, 0), { x: CENTER.x + HALF_NEAR, y: CENTER.y, z: CENTER.z });
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('right').pinch(true));
  await settle(simPage);

  await simPage.evaluate((p) => window.__sim!.hand('left').moveTo(p, 0), { x: CENTER.x - HALF_NEAR, y: CENTER.y, z: CENTER.z });
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('left').pinch(true));
  await settle(simPage);

  // Move both hands apart (would double scale on a tier-A object) while also translating
  // the whole hand pair by +0.3m in x (a move, which tier C does allow).
  const translateX = 0.3;
  await Promise.all([
    simPage.evaluate(
      (p) => window.__sim!.hand('right').moveTo(p, 0.3),
      { x: CENTER.x + HALF_NEAR * 2 + translateX, y: CENTER.y, z: CENTER.z },
    ),
    simPage.evaluate(
      (p) => window.__sim!.hand('left').moveTo(p, 0.3),
      { x: CENTER.x - HALF_NEAR * 2 + translateX, y: CENTER.y, z: CENTER.z },
    ),
  ]);
  await settle(simPage, 400);

  await evalApp(() => window.__sim!.hand('right').pinch(false));
  await settle(simPage);
  await evalApp(() => window.__sim!.hand('left').pinch(false));
  await settle(simPage);

  const obj = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!, objectId);
  const halfExtentX = (obj.interactionProxy as { kind: 'box'; halfExtents: { x: number } }).halfExtents.x;
  expect(halfExtentX, 'tier C forbids scale: half-extent must stay at its spawned value').toBeCloseTo(0.08, 1);
  expect(Math.abs(obj.currentPose.position.x - (CENTER.x + translateX)), 'tier C still allows move').toBeLessThan(0.05);
});
