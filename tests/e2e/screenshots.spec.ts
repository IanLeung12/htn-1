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

  // Live-overlay mode, viewed from the side (not top-down): a flat plate on
  // the floor cannot hide a 3D object seen edge-on, which is exactly what
  // BackgroundHull (src/render/background-hull.ts) is for. Frame the deleted
  // table's original position dead-center so "the projected centre of the
  // deleted table's original box" is just the middle of each eye's viewport.
  await evalApp(() => window.__testHelpers!.dispatchIntent({ kind: 'setMode', mode: 'live-overlay' }, 'test'));

  const viewport = simPage.viewportSize();
  expect(viewport).not.toBeNull();
  const eyeWidth = viewport!.width / 2;
  const eyeHeight = viewport!.height;
  const centerX = Math.round(eyeWidth / 2);
  const centerY = Math.round(eyeHeight / 2);

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

  const results: Array<{ path: string; truthPath: string; tableLuminance: number; backgroundLuminance: number }> = [];
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
    results.push({ path: offset.path, truthPath, tableLuminance, backgroundLuminance });
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
