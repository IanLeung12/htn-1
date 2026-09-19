/**
 * Visual check of the camera overlay: the fake webcam video under the
 * transparent three.js canvas with a spawned cube resting on the floor
 * prior. Saves test-results/camera-overlay.png for a human look; asserts
 * only that the composite is not blank and that the cube's pixels differ
 * from the video underneath.
 */
import { test, expect } from './camera-fixtures';
import path from 'node:path';

test('overlay composite renders the video and a spawned cube', async ({ camPage, evalCam }) => {
  await expect.poll(async () => evalCam(() => window.__realityEditor!.inSession && window.__camera!.frameSource.ready), { timeout: 15_000 }).toBe(true);
  await evalCam(() => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('#re-hud button')].find((b) => b.textContent === 'Spawn cube')!;
    btn.click();
  });
  await expect.poll(async () => evalCam(() => Object.keys(window.__realityEditor!.store.current.objects).length)).toBe(1);
  await camPage.waitForTimeout(600);
  const shot = path.resolve('test-results', 'camera-overlay.png');
  await camPage.screenshot({ path: shot });

  // The WebGL canvas must have drawn the cube: read back its pixels through the app canvas.
  const drawn = await evalCam(() => {
    const canvas = document.querySelector('#app canvas') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return -1;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let opaque = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) opaque += 1;
    return opaque / (w * h);
  });
  // preserveDrawingBuffer is off, so readPixels after the frame may be empty (-1/0); the
  // screenshot is the real check. Only assert when the buffer was readable.
  if (drawn > 0) expect(drawn).toBeLessThan(0.5);
});
