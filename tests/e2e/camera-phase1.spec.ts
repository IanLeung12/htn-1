/**
 * General-camera backend, phase 1: the webcam (a fake device playing a
 * synthetic Y4M) is the passthrough, the floor prior is a Surface at y=0,
 * spawned objects rest on it, and the mouse moves them along the floor
 * through the unchanged InteractionController/resolver.
 */
import { test, expect } from './camera-fixtures';

test('camera starts from getUserMedia and the video plays under the overlay', async ({ evalCam }) => {
  await expect
    .poll(async () => evalCam(() => window.__realityEditor!.inSession && window.__camera!.frameSource.ready), { timeout: 15_000 })
    .toBe(true);

  const info = await evalCam(() => {
    const cam = window.__camera!;
    const v = cam.frameSource.video;
    return {
      kind: cam.frameSource.kind,
      width: v.videoWidth,
      height: v.videoHeight,
      paused: v.paused,
      features: window.__realityEditor!.features,
      poseMode: cam.poseSource.quality.mode,
      depthBackend: cam.depthEstimator.status.backend,
    };
  });
  expect(info.kind).toBe('camera');
  expect(info.width).toBe(320);
  expect(info.height).toBe(240);
  expect(info.paused).toBe(false);
  expect(info.features?.enabled).toContain('video:camera');
  expect(info.poseMode).toBe('static');
  expect(info.depthBackend).toBe('analytic');

  // A grabbed frame carries real pixels from the fake device (the synthetic room is not black).
  const grab = await evalCam(() => {
    const g = window.__camera!.frameSource.grab(160);
    if (!g) return null;
    let sum = 0;
    for (let i = 0; i < g.rgba.length; i += 4) sum += g.rgba[i]! + g.rgba[i + 1]! + g.rgba[i + 2]!;
    return { width: g.width, height: g.height, mean: sum / (g.width * g.height * 3) };
  });
  expect(grab).not.toBeNull();
  expect(grab!.width).toBe(160);
  expect(grab!.mean).toBeGreaterThan(40);
});

test('floor prior is registered as a surface at y=0 and the camera pose sits above it', async ({ evalCam }) => {
  await expect
    .poll(async () => evalCam(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 })
    .toBeGreaterThan(0);
  const floor = await evalCam(() => {
    const s = window.__realityEditor!.store.current.surfaces['camera-floor']!;
    return { label: s.label, orientation: s.orientation, topY: s.aabb.max.y, pose: window.__camera!.poseSource.pose };
  });
  expect(floor.label).toBe('floor');
  expect(floor.orientation).toBe('horizontal');
  expect(floor.topY).toBeCloseTo(0.01, 3);
  expect(floor.pose.position.y).toBeCloseTo(1.1, 3);
  // Regions are created from surfaces (src/app/regions.ts), same as in XR.
  const regionCount = await evalCam(() => Object.keys(window.__realityEditor!.store.current.regions).length);
  expect(regionCount).toBeGreaterThan(0);
});

test('spawned cube lands on the floor in front of the camera and a mouse drag moves it along the floor', async ({ camPage, evalCam }) => {
  await expect.poll(async () => evalCam(() => window.__realityEditor!.inSession), { timeout: 15_000 }).toBe(true);

  // Spawn through the same DOM HUD button a user would press.
  const before = await evalCam(() => Object.keys(window.__realityEditor!.store.current.objects).length);
  await evalCam(() => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('#re-hud button')].find((b) => b.textContent === 'Spawn cube')!;
    btn.click();
  });
  await expect.poll(async () => evalCam(() => Object.keys(window.__realityEditor!.store.current.objects).length)).toBe(before + 1);

  const spawned = await evalCam(() => {
    const objs = Object.values(window.__realityEditor!.store.current.objects);
    const o = objs[objs.length - 1]!;
    return { id: o.id, pose: o.currentPose };
  });
  // Resting on the floor: centre at half extent above the floor surface (whose aabb top is
  // padded 0.01 m, same as XR plane surfaces), in front of the camera (-Z).
  expect(spawned.pose.position.y).toBeGreaterThan(0.07);
  expect(spawned.pose.position.y).toBeLessThan(0.1);
  expect(spawned.pose.position.z).toBeLessThan(0);

  // Project the cube to screen space, press on it, drag right, release.
  const screen = await evalCam((id) => {
    const cam = window.__camera!;
    const o = window.__realityEditor!.store.current.objects[id]!;
    // Find the pixel whose floor-plane hit is nearest the cube by scanning a coarse grid.
    const canvas = document.querySelector('#app canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    let best = { x: 0, y: 0, d: Infinity };
    for (let py = 0; py <= 40; py++) {
      for (let px = 0; px <= 40; px++) {
        const cx = rect.left + (px / 40) * rect.width;
        const cy = rect.top + (py / 40) * rect.height;
        const w = cam.worldAtPixel(cx, cy);
        const d = Math.hypot(w.x - o.currentPose.position.x, w.z - o.currentPose.position.z);
        if (d < best.d) best = { x: cx, y: cy, d };
      }
    }
    return best;
  }, spawned.id);
  expect(screen.d).toBeLessThan(0.1);

  await camPage.mouse.move(screen.x, screen.y);
  await camPage.waitForTimeout(100);
  await expect.poll(async () => evalCam(() => window.__camera!.pointer.hoverId)).toBe(spawned.id);

  await camPage.mouse.down();
  await camPage.waitForTimeout(80);
  await camPage.mouse.move(screen.x + 120, screen.y, { steps: 10 });
  await camPage.waitForTimeout(120);
  // While dragging, the preview follows the pointer.
  const preview = await evalCam(() => window.__realityEditor!.store.current.preview);
  expect(preview?.objectId).toBe(spawned.id);
  await camPage.mouse.up();
  await camPage.waitForTimeout(150);

  const after = await evalCam((id) => window.__realityEditor!.store.current.objects[id]!.currentPose, spawned.id);
  expect(after.position.x).toBeGreaterThan(spawned.pose.position.x + 0.1);
  // Stays on the floor plane (the drag plane is the grab height; physics settles the rest).
  expect(Math.abs(after.position.y - 0.09)).toBeLessThan(0.06);
  const previewCleared = await evalCam(() => window.__realityEditor!.store.current.preview);
  expect(previewCleared).toBeUndefined();

  // Undo returns it.
  const undo = await evalCam(() => window.__cameraTestHelpers!.dispatchIntent({ kind: 'undo' }, 'test'));
  expect(undo.ok).toBe(true);
  const undone = await evalCam((id) => window.__realityEditor!.store.current.objects[id]!.currentPose, spawned.id);
  expect(undone.position.x).toBeCloseTo(spawned.pose.position.x, 2);
});

test('delete, restore, and voice work through the shared resolver; diagnostics report estimates', async ({ evalCam }) => {
  await expect.poll(async () => evalCam(() => window.__realityEditor!.inSession), { timeout: 15_000 }).toBe(true);
  const id = await evalCam(() => window.__cameraTestHelpers!.spawnTestObject({ position: { x: 0.3, y: 0.08, z: -1.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, { userName: 'Test Cube' }));

  const del = await evalCam((oid) => window.__cameraTestHelpers!.dispatchIntent({ kind: 'delete', objectId: oid }), id);
  expect(del.ok).toBe(true);
  expect(await evalCam((oid) => window.__realityEditor!.store.current.objects[oid]!.visible, id)).toBe(false);
  const restore = await evalCam((oid) => window.__cameraTestHelpers!.dispatchIntent({ kind: 'restore', objectId: oid }), id);
  expect(restore.ok).toBe(true);

  await evalCam(() => window.__realityEditor!.voice!.submitText('delete the test cube'));
  await expect.poll(async () => evalCam((oid) => window.__realityEditor!.store.current.objects[oid]!.visible, id)).toBe(false);

  // The diagnostics panel is refreshed every 250 ms; wait for it to reflect the running video.
  await expect.poll(async () => evalCam(() => window.__camera!.diagnostics.videoReady), { timeout: 10_000 }).toBe(true);
  const diag = await evalCam(() => window.__camera!.diagnostics);
  expect(diag.poseMode).toBe('static');
  expect(diag.depthBackend).toBe('analytic');
  expect(diag.videoReady).toBe(true);
  expect(diag.surfaceCount).toBeGreaterThan(0);
  expect(diag.tierCap).toBe('C');
  expect(diag.trackingOk).toBe(true);
});
