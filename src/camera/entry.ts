/**
 * camera.html entry: starts the general-camera backend (src/camera/app.ts).
 *
 * Query params:
 *   ?source=camera|url|file   frame source (default camera = getUserMedia)
 *   ?url=<video url>          for source=url
 *   ?headless=1               hide the HUD/diagnostics/landing card (Playwright)
 *   ?autostart=1              start the camera without a click (fake device / file)
 *   ?pose=auto|static|orientation
 *   ?depth=auto|model|prior|none
 *   ?height=<m> ?pitch=<deg> ?fov=<deg> ?facing=environment|user
 *   ?persist=<key>
 */
import { startCameraApp } from './app';
import type { CameraAppConfig } from './contract';

function num(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const headless = params.get('headless') === '1';
  const autoStart = params.get('autostart') === '1';
  const persistKey = params.get('persist') ?? undefined;

  const config: Partial<CameraAppConfig> = {};
  const source = params.get('source');
  if (source === 'camera' || source === 'url' || source === 'file') config.source = source;
  const url = params.get('url');
  if (url) {
    config.url = url;
    if (!source) config.source = 'url';
  }
  const pose = params.get('pose');
  if (pose === 'auto' || pose === 'static' || pose === 'orientation') config.pose = pose;
  const depth = params.get('depth');
  if (depth === 'auto' || depth === 'model' || depth === 'prior' || depth === 'none') config.depth = depth;
  const facing = params.get('facing');
  if (facing === 'environment' || facing === 'user') config.facing = facing;
  if (params.has('height')) config.cameraHeightM = num(params.get('height'), 1.1);
  if (params.has('pitch')) config.pitchRad = (num(params.get('pitch'), -20) * Math.PI) / 180;
  if (params.has('fov')) config.fovY = (num(params.get('fov'), 50) * Math.PI) / 180;

  const container = document.getElementById('app') ?? document.body;
  const app = await startCameraApp({ container, headless, persistKey, config, autoStart });

  const landing = document.getElementById('landing');
  const startButton = document.getElementById('start-camera') as HTMLButtonElement | null;
  const status = document.getElementById('landing-status');
  if (headless || autoStart) {
    landing?.classList.add('hidden');
    return;
  }
  if (startButton) {
    startButton.disabled = false;
    startButton.addEventListener('click', async () => {
      startButton.disabled = true;
      startButton.textContent = 'Starting…';
      try {
        const report = await app.handle.enterAR();
        if (status) status.textContent = `enabled: ${report.enabled.join(', ')}`;
        landing?.classList.add('hidden');
      } catch (err) {
        console.error('[camera] start failed', err);
        if (status) status.textContent = err instanceof Error ? err.message : String(err);
        startButton.disabled = false;
        startButton.textContent = 'Start camera';
      }
    });
  }
  const heightInput = document.getElementById('cam-height') as HTMLInputElement | null;
  if (heightInput) {
    heightInput.value = String(app.camera.config.cameraHeightM);
    heightInput.addEventListener('change', () => {
      const h = Number(heightInput.value);
      if (Number.isFinite(h) && h > 0.2 && h < 3) app.camera.setCameraHeight(h);
    });
  }
  const fovInput = document.getElementById('cam-fov') as HTMLInputElement | null;
  if (fovInput) {
    fovInput.value = String(Math.round((app.camera.config.fovY * 180) / Math.PI));
    fovInput.addEventListener('change', () => {
      const deg = Number(fovInput.value);
      if (Number.isFinite(deg) && deg > 20 && deg < 120) app.camera.setFovY((deg * Math.PI) / 180);
    });
  }
  const fileInput = document.getElementById('cam-file') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const next = new URL(location.href);
      next.searchParams.set('source', 'file');
      // Files cannot survive a reload; hand the File straight to a fresh app instance instead.
      app.handle.dispose();
      void startCameraApp({ container, headless, persistKey, config: { ...config, source: 'file' } }).then(async (fresh) => {
        const src = fresh.camera.frameSource as unknown as { setFile?: (f: File) => void };
        src.setFile?.(file);
        await fresh.handle.enterAR();
        landing?.classList.add('hidden');
      });
    });
  }
}

main().catch((err) => {
  console.error('[camera] fatal error during bootstrap', err);
});
