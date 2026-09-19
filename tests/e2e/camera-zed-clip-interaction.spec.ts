/**
 * Interaction on the real ZED clip through the stereo path: the desk the
 * camera sits on (~6 cm above it) registers as the ground (y = 0), a pick on
 * the bare, textureless desk resolves (plane-filled depth or the ray/surface
 * fallback) to 0.3-0.5 m, the pointer's hover rests on the depth, a discovered
 * object is hovered and dragged with the mouse. Prints the measured numbers.
 */
import { test, expect } from '@playwright/test';

test('ZED SBS clip: desk is the ground, bare-desk pick, hover and drag a discovered object', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/camera.html?headless=1&autostart=1&source=url&url=/zed/zed2-sbs-hd720-8s.webm&stereo=sbs&pose=static&depth=prior');
  await page.waitForFunction(() => Boolean(window.__realityEditor && window.__camera), { timeout: 30_000 });
  await expect.poll(async () => page.evaluate(() => window.__realityEditor!.inSession && window.__camera!.frameSource.ready), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => page.evaluate(() => window.__camera!.depthEstimator.status.frames), { timeout: 30_000 }).toBeGreaterThan(3);

  // 1. The desk under the camera is the fitted ground: y = 0, camera a few centimetres above it.
  await expect.poll(async () => page.evaluate(() => window.__camera!.surfaceEstimator.surfaces[0]?.origin), { timeout: 30_000 }).toBe('ransac');
  const ground = await page.evaluate(() => {
    const cam = window.__camera!;
    const se = cam.surfaceEstimator as unknown as { cameraHeightM: number; lastFrame: { position: { x: number; y: number; z: number } } | null; groundExtent: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null; surfaces: { surface: { id: string; aabb: { max: { y: number } } }; confidence: number; origin: string }[] };
    const map = cam.depthEstimator.latest!;
    const weight = (map as unknown as { weight?: Float32Array }).weight;
    let matched = 0;
    let filled = 0;
    let planeFilled = 0;
    if (weight) for (let i = 0; i < weight.length; i++) {
      if (weight[i]! >= 1) matched++;
      else if (weight[i]! >= 0.5) filled++;
      else if (weight[i]! > 0) planeFilled++;
    }
    const n = map.width * map.height;
    return { cameraHeightM: se.cameraHeightM, confidence: se.surfaces[0]!.confidence, extent: se.groundExtent, frameY: se.lastFrame?.position.y ?? null, coverage: { matched: matched / n, filled: filled / n, planeFilled: planeFilled / n } };
  });
  console.log(`ZED clip ground: camera ${ground.cameraHeightM.toFixed(3)} m above the fitted desk (confidence ${ground.confidence.toFixed(2)}), extent x ${ground.extent?.min.x.toFixed(2)}..${ground.extent?.max.x.toFixed(2)} z ${ground.extent?.min.z.toFixed(2)}..${ground.extent?.max.z.toFixed(2)}; map coverage matched ${(ground.coverage.matched * 100).toFixed(0)}% mean-filled ${(ground.coverage.filled * 100).toFixed(0)}% plane-filled ${(ground.coverage.planeFilled * 100).toFixed(0)}%`);
  expect(ground.cameraHeightM).toBeGreaterThan(0.01);
  expect(ground.cameraHeightM).toBeLessThan(0.2);
  expect(ground.coverage.planeFilled).toBeGreaterThan(0.02);

  // 2. Picks: the bare desk at the bottom centre (a hole or plane-filled), and the cans in the middle.
  const picks = await page.evaluate(() => {
    const cam = window.__camera!;
    const origin = (cam.surfaceEstimator as unknown as { lastFrame: { position: { x: number; y: number; z: number } } | null }).lastFrame?.position ?? cam.poseSource.pose.position;
    const dist = (p: { x: number; y: number; z: number } | null | undefined): number | null => (p ? Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z) : null);
    const at = (x: number, y: number) => {
      const r = cam.pickWorldDetailed(x, y);
      return r ? { mode: r.mode, confidence: r.confidence, y: r.point.y, dist: dist(r.point) } : null;
    };
    return { deskCentre: at(0, -0.8), deskLeft: at(-0.15, -0.85), deskRight: at(0.15, -0.7), cans: at(0, -0.2) };
  });
  console.log(`ZED clip picks: desk centre ${JSON.stringify(picks.deskCentre)}, desk left ${JSON.stringify(picks.deskLeft)}, desk right ${JSON.stringify(picks.deskRight)}, cans ${JSON.stringify(picks.cans)}`);
  // The bare desk is the bottom-centre band (blanket to the left, the owner's sleeve to the right). The clip plays on
  // while we sample: at least two of the three desk picks must be the desk (0.2-0.8 m away, on y ~ 0).
  const desk = [picks.deskCentre, picks.deskLeft, picks.deskRight].filter((p): p is NonNullable<typeof p> => p !== null && p.dist! > 0.2 && p.dist! < 0.8 && Math.abs(p.y) < 0.08);
  expect(desk.length).toBeGreaterThanOrEqual(2);
  expect(picks.deskCentre).not.toBeNull();
  expect(picks.deskCentre!.dist!).toBeGreaterThan(0.2);
  expect(picks.deskCentre!.dist!).toBeLessThan(0.6);
  expect(picks.cans).not.toBeNull();
  expect(picks.cans!.dist!).toBeGreaterThan(0.3);
  expect(picks.cans!.dist!).toBeLessThan(0.6);

  // 3. Hover: the pointer rests on what the depth sees (not the origin).
  const rect = await page.evaluate(() => {
    const canvas = document.querySelector('#app canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  await page.mouse.move(rect.left + rect.width * 0.5, rect.top + rect.height * 0.6);
  await page.waitForTimeout(200);
  const hover = await page.evaluate(() => {
    const p = window.__camera!.pointer.pointerWorld;
    return { x: p.x, y: p.y, z: p.z };
  });
  console.log(`ZED clip hover at (0.5, 0.6): pointerWorld ${JSON.stringify(hover)}`);
  expect(Math.hypot(hover.x, hover.y, hover.z)).toBeGreaterThan(0.1);

  // 4. Discover the cans/laptop volume, hover it, drag it 80 px to the right.
  await expect.poll(async () => page.evaluate(() => window.__camera!.surfaceEstimator.volumes.length), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  const ids = await page.evaluate(() => window.__realityEditor!.runCandidateDiscovery());
  expect(ids.length).toBeGreaterThanOrEqual(1);
  // Sweep the canvas in-page (programmatic pointer injection + a synchronous adapter update; the frame loop's
  // own update is idempotent on a drained queue) for a hover hit on any discovered object, then drive the
  // real mouse from that spot.
  const hit = await page.evaluate((r) => {
    const cam = window.__camera!;
    for (let fy = 0.25; fy <= 0.95; fy += 0.04) {
      for (let fx = 0.05; fx <= 0.95; fx += 0.04) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        cam.pointer.inject('move', x, y);
        cam.pointer.update();
        if (cam.pointer.hoverId) return { x, y, id: cam.pointer.hoverId };
      }
    }
    return null;
  }, rect);
  expect(hit).not.toBeNull();
  const before = await page.evaluate((id) => window.__realityEditor!.store.current.objects[id]!.currentPose.position, hit!.id);
  await page.mouse.move(hit!.x, hit!.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(hit!.x + i * 10, hit!.y);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await page.evaluate((id) => window.__realityEditor!.store.current.objects[id]!.currentPose.position, hit!.id);
  console.log(`ZED clip drag: ${hit!.id} hovered at (${(hit!.x - rect.left).toFixed(0)}, ${(hit!.y - rect.top).toFixed(0)}) px, moved ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.02);
  expect(errors).toEqual([]);
});
