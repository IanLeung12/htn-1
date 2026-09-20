// Headless live check against the real ZED bridge: click-detect two objects, Delete via the menu, dump stats + screenshots.
import { chromium } from 'playwright';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5177/camera.html?source=zed-sdk&bridge=ws://localhost:8765&autostart=1&height=0.75&zedconf=40';
const outDir = process.argv[3] ?? '.';
const targets = JSON.parse(process.argv[4] ?? '[["right can",0.49,0.50],["mask",0.62,0.56],["left can",0.42,0.50]]');

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__camera && window.__camera.depthEstimator && window.__camera.depthEstimator.latest, null, { timeout: 30000 });
await page.waitForTimeout(12000);
const before = await page.evaluate(() => {
  const cam = window.__camera;
  const app = window.__realityEditor;
  return { hidden: document.hidden, status: (document.body.innerText.match(/zed-sdk [^\n]*/) || [])[0], tables: Object.values(app.store.current.surfaces).filter((s) => s.label === 'table').map((s) => +s.aabb.max.y.toFixed(3)), tilt: window.__zedBridge && +(window.__zedBridge.poseSource.tiltRad * 180 / Math.PI).toFixed(2) };
});
console.log('before', JSON.stringify(before));
await page.screenshot({ path: path.join(outDir, 'live-0-before.png') });

let i = 0;
for (const [name, fx, fy] of targets) {
  i += 1;
  const res = await page.evaluate(async ([name, fx, fy]) => {
    const app = window.__realityEditor;
    const cam = window.__camera;
    const el = cam.pointer.element;
    const r = el.getBoundingClientRect();
    const ev = (t, x, y) => el.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: t === 'pointerup' ? 0 : 1, bubbles: true }));
    const x = r.left + r.width * fx, y = r.top + r.height * fy;
    const before = Object.keys(app.store.current.objects);
    ev('pointermove', x, y);
    await new Promise((r) => setTimeout(r, 150));
    ev('pointerdown', x, y);
    await new Promise((r) => setTimeout(r, 80));
    ev('pointerup', x, y);
    await new Promise((r) => setTimeout(r, 3000));
    const menu = document.querySelector('.camera-context-menu');
    const buttons = menu ? [...menu.querySelectorAll('button')].map((b) => b.textContent + (b.title ? '!' : '')) : [];
    const id = Object.keys(app.store.current.objects).find((k) => !before.includes(k)) ?? (menu && menu.firstChild ? null : null);
    const det = cam.detectAt(fx * 2 - 1, 1 - fy * 2);
    const del = menu && [...menu.querySelectorAll('button')].find((b) => b.textContent === 'Delete');
    let after = null;
    if (del && !del.title) {
      del.click();
      await new Promise((r) => setTimeout(r, 2000));
      after = { rs: cam.renderStats(), eraser: cam.debugEraser().map((e) => ({ id: e.id, synthetic: e.synthetic, tex: e.tex, size: e.size })) };
    }
    return { name, menuShown: menu && menu.style.display, buttons, newId: id, det: det.volume ? { he: det.volume.halfExtents } : det.trace && det.trace.reason, after, hint: (document.body.innerText.match(/(Detected|Nothing standing|deleted|Delete hides|follows)[^\n]*/) || [])[0] };
  }, [name, fx, fy]);
  console.log('step', i, JSON.stringify(res));
  await page.screenshot({ path: path.join(outDir, `live-${i}-${name.replace(/\s+/g, '_')}.png`) });
}
const final = await page.evaluate(() => ({ objs: Object.values(window.__realityEditor.store.current.objects).map((o) => o.id + ':' + o.tier + ':' + o.visible), rs: window.__camera.renderStats() }));
console.log('final', JSON.stringify(final));
await browser.close();
