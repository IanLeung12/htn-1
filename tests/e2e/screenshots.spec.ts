/**
 * Visual smoke: captures what the simulator composes (emulated passthrough + app canvas)
 * in live-overlay and captured-shell modes with spawned objects, a grabbed preview, and a
 * deleted physical object showing its plate. Screenshots land in test-results/screens/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { test, expect } from './fixtures';

const OUT = path.join(process.cwd(), 'test-results', 'screens');

/** Mean 0..255 luminance of an (x,y)-centered square patch of a PNG buffer. */
function meanAbsDiff(a: PNG, b: PNG, x0: number, y0: number, w: number, h: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * a.width + x) * 4;
      const la = (a.data[i]! + a.data[i + 1]! + a.data[i + 2]!) / 3;
      const lb = (b.data[i]! + b.data[i + 1]! + b.data[i + 2]!) / 3;
      sum += Math.abs(la - lb);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function patchLuminance(png: PNG, cx: number, cy: number, radius: number): number {
  let sum = 0;
  let count = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx]!;
      const g = png.data[idx + 1]!;
      const b = png.data[idx + 2]!;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

test('visual smoke screenshots', async ({ evalApp, simPage }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await expect.poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 }).toBeGreaterThan(0);

  // Centre of the left eye's viewport - used throughout this spec to sample
  // whatever a head pose looking directly at a world point projects to.
  const viewport = simPage.viewportSize();
  expect(viewport).not.toBeNull();
  const eyeWidth = viewport!.width / 2;
  const eyeHeight = viewport!.height;
  const centerX = Math.round(eyeWidth / 2);
  const centerY = Math.round(eyeHeight / 2);

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
  const roomShell = await evalApp(() => window.__realityEditor!.captureRoomShell?.());
  await simPage.waitForTimeout(600);
  await simPage.screenshot({ path: path.join(OUT, '03-captured-shell.png') });

  const ids = await evalApp(() => window.__realityEditor!.runCandidateDiscovery());
  const tableId = await evalApp((ids) => ids.find((id) => window.__realityEditor!.store.current.objects[id]!.label === 'table') ?? ids[0], ids);
  await evalApp((id) => window.__testHelpers!.dispatchIntent({ kind: 'approve', objectId: id, approved: true }, 'test'), tableId!);
  const pos = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.currentPose.position, tableId!);
  const originalPose = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.originalPose, tableId!);
  const vol = await evalApp((p) => { const vs = window.__sim!.listVolumes().filter((v) => v.kind !== 'plane'); let b = vs[0]!; let bd = Infinity; for (const v of vs) { const d = Math.hypot(v.pose.position.x - p.x, v.pose.position.z - p.z); if (d < bd) { bd = d; b = v; } } return b.id; }, pos);

  // Object-appearance pass ("move the table and see the table"): this MUST
  // run before the object is hidden/lifted - the object is still physically
  // present, unlike the clean-plate pass below.
  const appearance = await evalApp((id) => window.__realityEditor!.captureObjectAppearance?.(id), tableId!);

  await evalApp((v) => window.__sim!.hideVolume(v), vol);
  const cap = await evalApp((id) => window.__realityEditor!.captureCleanPlate(id), tableId!);
  await evalApp((v) => window.__sim!.showVolume(v), vol);
  await simPage.evaluate((p) => { window.__sim!.setHead({ x: p.x + 0.3, y: 1.6, z: p.z + 1.6 }); window.__sim!.lookAt({ x: p.x, y: 0.4, z: p.z }); }, pos);
  await simPage.waitForTimeout(300);
  await simPage.screenshot({ path: path.join(OUT, '04-table-before-delete.png') });

  // --- Moved-object appearance: "move the table and see the table" --------
  // Match guided capture's FIRST arc viewpoint exactly (src/app/guide.ts's
  // `planCaptureViewpoints`: bearing0 = the head's bearing to the footprint
  // centre at capture time, i.e. right here - the head has not moved since
  // the '01-live-overlay' setHead call above - height=HEIGHT_MIN_M=1.2m,
  // distance=DIST_MIN_M=1.0m), so the "before" reference below is looking
  // from the exact real-world viewpoint `captureObjectAppearance` used to
  // build the appearance frame that should now be reprojected for the moved
  // copy - any other angle risks the guided arc's OTHER viewpoints (whose
  // real-world sightline may be partly blocked by this room's jagged scan
  // geometry) dominating instead.
  const ARC_HEAD_POSE = { x: 0, y: 1.6, z: 1.2 }; // must match the setHead() call preceding captureObjectAppearance
  const MOVE_VIEW_RADIUS_M = 1.0;
  const MOVE_VIEW_HEIGHT_M = 1.2;
  const MOVE_VIEW_ANGLE = Math.atan2(ARC_HEAD_POSE.z - pos.z, ARC_HEAD_POSE.x - pos.x);
  const moveViewOffset = { x: MOVE_VIEW_RADIUS_M * Math.cos(MOVE_VIEW_ANGLE), z: MOVE_VIEW_RADIUS_M * Math.sin(MOVE_VIEW_ANGLE) };
  const MOVE_OFFSET_M = 0.6;
  const movedPos = { x: pos.x + MOVE_OFFSET_M, y: pos.y, z: pos.z };

  // "Before" reference: the table's real, physically-present appearance,
  // viewed from the same relative offset the "after" screenshot below will
  // use around the table's NEW position - captured while the table still
  // sits at its ORIGINAL position, before any move.
  await simPage.evaluate(({ p, offset, h }) => {
    window.__sim!.setHead({ x: p.x + offset.x, y: h, z: p.z + offset.z });
    window.__sim!.lookAt(p);
  }, { p: pos, offset: moveViewOffset, h: MOVE_VIEW_HEIGHT_M });
  await simPage.waitForTimeout(300);
  await simPage.screenshot({ path: path.join(OUT, '08-table-before-move-reference.png') });

  const moveResult = await evalApp(
    (args) => window.__testHelpers!.dispatchIntent(
      { kind: 'move', objectId: args.id, pose: { position: args.pose, rotation: { x: 0, y: 0, z: 0, w: 1 } } },
      'test',
    ),
    { id: tableId!, pose: movedPos },
  );
  await simPage.waitForTimeout(400);

  // "After": same relative viewpoint, now around the table's new position.
  // If the moved copy is rendered as its own captured depth/texture
  // (src/render/objects.ts), this should closely resemble the "before"
  // reference above; the old primitive-box stand-in would not.
  await simPage.evaluate(({ p, offset, h }) => {
    window.__sim!.setHead({ x: p.x + offset.x, y: h, z: p.z + offset.z });
    window.__sim!.lookAt(p);
  }, { p: movedPos, offset: moveViewOffset, h: MOVE_VIEW_HEIGHT_M });
  await simPage.waitForTimeout(300);
  await simPage.screenshot({ path: path.join(OUT, '08-table-moved.png') });

  const beforeMovePng = PNG.sync.read(fs.readFileSync(path.join(OUT, '08-table-before-move-reference.png')));
  const afterMovePng = PNG.sync.read(fs.readFileSync(path.join(OUT, '08-table-moved.png')));
  const moveMad = meanAbsDiff(beforeMovePng, afterMovePng, centerX - 60, centerY - 60, 120, 120);
  console.log('MOVE', JSON.stringify({ appearance, moveResult: moveResult.ok, moveMad }));

  expect(moveResult.ok, 'moving the approved, tier-A physical table should be permitted').toBe(true);
  expect(
    moveMad,
    'the moved table should resemble its own captured appearance from the same relative viewpoint, not a flat primitive-box colour',
  ).toBeLessThanOrEqual(20);

  // Move it back to its original pose so the rest of this spec (delete /
  // captured-shell ground truth, both keyed on `pos`) is unaffected.
  await evalApp((args) => window.__testHelpers!.dispatchIntent({ kind: 'move', objectId: args.id, pose: args.pose }, 'test'), { id: tableId!, pose: originalPose });
  await simPage.waitForTimeout(300);
  const del = await evalApp((id) => window.__testHelpers!.dispatchIntent({ kind: 'delete', objectId: id }, 'test'), tableId!);
  await simPage.waitForTimeout(400);
  await simPage.screenshot({ path: path.join(OUT, '05-table-deleted.png') });

  // --- Captured-shell carve: the shell must not keep showing the deleted
  // table's old box/scan-mesh geometry (src/render/shell.ts's carve of the
  // global mesh + hiding the object's own surface tile). Ground truth: the
  // same captured-shell render but with the real SEM volume ALSO hidden -
  // if the carve/hide worked, the app's own render should already match it
  // without needing the volume physically hidden (the background hull fills
  // the resulting hole with a depth-correct reprojection in both modes).
  await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'setMode', mode: 'captured-shell' }, 'test'));
  await simPage.evaluate((p) => {
    window.__sim!.setHead({ x: p.x, y: 1.7, z: p.z + 1.6 });
    window.__sim!.lookAt({ x: p.x, y: 0.4, z: p.z });
  }, pos);
  await simPage.waitForTimeout(500);
  await simPage.screenshot({ path: path.join(OUT, '09-captured-shell-after-delete.png') });

  await evalApp((v) => window.__sim!.hideVolume(v), vol);
  await simPage.waitForTimeout(400);
  await simPage.screenshot({ path: path.join(OUT, '09-captured-shell-after-delete-ground-truth.png') });
  await evalApp((v) => window.__sim!.showVolume(v), vol);
  await simPage.waitForTimeout(300);

  const shellPng = PNG.sync.read(fs.readFileSync(path.join(OUT, '09-captured-shell-after-delete.png')));
  const shellTruthPng = PNG.sync.read(fs.readFileSync(path.join(OUT, '09-captured-shell-after-delete-ground-truth.png')));
  const shellMad = meanAbsDiff(shellPng, shellTruthPng, centerX - 150, centerY - 150, 300, 300);
  console.log('SHELL_CARVE', JSON.stringify({ shellMad }));
  expect(shellMad, 'captured-shell after delete should no longer show the table box').toBeLessThanOrEqual(15);

  // Live-overlay mode, viewed from the side (not top-down): a flat plate on
  // the floor cannot hide a 3D object seen edge-on, which is exactly what
  // BackgroundHull (src/render/background-hull.ts) is for. Frame the deleted
  // table's original position dead-center so "the projected centre of the
  // deleted table's original box" is just the middle of each eye's viewport.
  await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'setMode', mode: 'live-overlay' }, 'test'));

  // Two head positions at ~1.2m from the table, 45 degrees apart, both
  // looking straight at its original centre. If the hull only reprojected a
  // single clean-plate frame onto the box's faces (the pre-parallax-fix
  // behaviour), it would read as noticeably darker or brighter than the
  // real background from at least one of these angles, and would show the
  // wrong background geometry (ceiling/couch instead of whatever is really
  // behind the table) from the rotated angle in particular.
  //
  // The room this scene is emulated in is a jagged, per-face-shaded terrain
  // mesh, not a flat wall - luminance varies a lot even between two patches
  // a few pixels apart (normal-dependent lighting), so comparing the hull
  // patch against some other nearby-but-different surface is noisy and not
  // actually what "looks truthful" means. Instead, at each head position we
  // capture the literal ground truth for that exact screen patch: hide the
  // real physical volume (same trick `captureCleanPlate` above uses) so
  // passthrough alone shows whatever is really behind the table, at the
  // very same pixels the hull otherwise covers, then restore it. The hull
  // patch (real table present, hidden behind BackgroundHull's stand-in)
  // should match that ground truth to within the passthrough's own
  // sample-to-sample noise.
  // Both offsets are expressed as an angle around the table (measured the
  // same way `guide.ts`'s `bearingTo` does: atan2(z, x)) at a fixed 1.2m
  // radius. The first angle (90 degrees, i.e. the `{x:0, z:1.2}` "approach
  // from the front" offset used throughout this test) is where guided
  // capture's arc starts (the head was already at roughly this bearing from
  // the table when `captureCleanPlate` ran above - see `planCaptureViewpoints`
  // in src/app/guide.ts, which sweeps its 4-viewpoint arc +60 degrees per
  // step from the head's bearing at capture time). The second angle is 45
  // degrees further around in that same sweep direction, so it lands well
  // inside the guided arc's actual capture coverage rather than off the back
  // of it - this is still a substantively different viewing angle (enough to
  // exercise real parallax), not a trivial re-take of the first.
  const ANGLE0 = Math.PI / 2;
  const ANGLE1 = ANGLE0 + Math.PI / 4;
  const RADIUS_M = 1.2;
  const headOffsets = [
    { x: RADIUS_M * Math.cos(ANGLE0), z: RADIUS_M * Math.sin(ANGLE0), path: path.join(OUT, '06-table-deleted-side-view.png') },
    { x: RADIUS_M * Math.cos(ANGLE1), z: RADIUS_M * Math.sin(ANGLE1), path: path.join(OUT, '06b-table-deleted-side-view-45deg.png') },
  ];

  const results: Array<{ path: string; truthPath: string; tableLuminance: number; backgroundLuminance: number; regionMad: number }> = [];
  for (const offset of headOffsets) {
    await simPage.evaluate(({ p, offset }) => {
      window.__sim!.setHead({ x: p.x + offset.x, y: p.y + 0.3, z: p.z + offset.z });
      window.__sim!.lookAt(p);
    }, { p: pos, offset });
    await simPage.waitForTimeout(400);
    await simPage.screenshot({ path: offset.path });

    const truthPath = offset.path.replace(/\.png$/, '-ground-truth.png');
    await evalApp((v) => window.__sim!.hideVolume(v), vol);
    await simPage.waitForTimeout(300);
    await simPage.screenshot({ path: truthPath });
    await evalApp((v) => window.__sim!.showVolume(v), vol);
    await simPage.waitForTimeout(300);

    // Camera looks directly at `pos`, so its projection sits at the centre
    // of each eye's own viewport - sample the left eye's centre in both the
    // hull screenshot and its ground-truth counterpart.
    const png = PNG.sync.read(fs.readFileSync(offset.path));
    const truthPng = PNG.sync.read(fs.readFileSync(truthPath));
    const tableLuminance = patchLuminance(png, centerX, centerY, 6);
    const backgroundLuminance = patchLuminance(truthPng, centerX, centerY, 6);
    // Region-wide check: mean absolute luminance difference over a 300x300 window
    // around the deleted object's centre (covers its whole silhouette at 1.2 m).
    const regionMad = meanAbsDiff(png, truthPng, centerX - 150, centerY - 150, 300, 300);
    results.push({ path: offset.path, truthPath, tableLuminance, backgroundLuminance, regionMad });
  }

  console.log('SCREENS', JSON.stringify({ cap, del: del.ok, tableId, roomShell, results }));

  // Before the fix, the still-visible real table volume (or its single-frame
  // box reprojection) read as a distinctly different (darker/lighter) patch
  // than the ground truth of what's really behind it; after BackgroundHull
  // v2 replaces it with a parallax-correct depth mesh of the nearest
  // clean-plate viewpoint, both viewing angles should closely match ground
  // truth - i.e. the deleted table reads as truly gone, not just plausible.
  for (const r of results) {
    expect(Math.abs(r.tableLuminance - r.backgroundLuminance)).toBeLessThanOrEqual(12);
    expect(r.regionMad, `silhouette region should match ground truth: ${r.path}`).toBeLessThanOrEqual(12);
  }

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
  await simPage.screenshot({ path: path.join(OUT, '07-hand-menu.png') });

});
