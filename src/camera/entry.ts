/**
 * camera.html entry: starts the general-camera backend (src/camera/app.ts).
 *
 * Query params:
 *   ?source=camera|url|file|stereo|zed-sdk   frame source (default camera = getUserMedia)
 *   ?bridge=ws://localhost:8765   for source=zed-sdk: tools/zed-bridge/server.py (docs/general-camera/zed-sdk.md)
 *   ?url=<video url>          for source=url
 *   ?headless=1               hide the HUD/diagnostics/landing card (Playwright)
 *   ?autostart=1              start the camera without a click (fake device / file)
 *   ?pose=auto|static|orientation
 *   ?depth=auto|model|prior|none
 *   ?height=<m> ?pitch=<deg> ?fov=<deg> ?facing=environment|user
 *   ?device=<video input label substring>   e.g. ?device=zed
 *   ?mode=vga|hd720|hd1080    ZED stereo capture mode (see config.stereoMode)
 *   ?serial=<sn>              ZED factory-calibration serial (config.zedSerial)
 *   ?persist=<key>
 *
 * `device`, `mode`, and `serial` are also settable from the landing card
 * (#cam-device, #cam-stereo-mode, #cam-serial) and persisted to localStorage
 * under `reality-editor-camera:device` / `:stereoMode` / `:zedSerial` so they
 * survive a reload. A `device` matching /zed/i with no explicit `source`
 * switches the default source to 'stereo' (src/camera/app.ts constructs a
 * ZedStereoFrameSource for that kind; see src/camera/stereo/zed-frame-source.ts).
 */
import { startCameraApp } from './app';
import type { CameraAppConfig } from './contract';

const STORAGE_PREFIX = 'reality-editor-camera:';

function num(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(STORAGE_PREFIX + key, value);
    else localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // ignore (private browsing / storage disabled)
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const headless = params.get('headless') === '1';
  const autoStart = params.get('autostart') === '1';
  const persistKey = params.get('persist') ?? undefined;

  const config: Partial<CameraAppConfig> = {};
  const source = params.get('source');
  if (source === 'camera' || source === 'url' || source === 'file' || source === 'stereo' || source === 'zed-sdk') config.source = source;
  const bridge = params.get('bridge') ?? readStorage('bridgeUrl');
  if (bridge) config.bridgeUrl = bridge;
  const zedConf = params.get('zedconf');
  if (zedConf) config.zedMinConfidence = Math.max(0, Math.min(255, Number(zedConf)));
  const url = params.get('url');
  if (url) {
    config.url = url;
    if (params.get('stereo') === 'sbs') config.stereo = 'sbs';
    if (!source) config.source = 'url';
  }

  // Device / ZED stereo settings: URL param wins, else fall back to whatever
  // was persisted from a previous session.
  const device = params.get('device') ?? readStorage('device');
  if (device) config.device = device;
  const mode = params.get('mode') ?? readStorage('stereoMode');
  if (mode === 'vga' || mode === 'hd720' || mode === 'hd1080') config.stereoMode = mode;
  const serial = params.get('serial') ?? readStorage('zedSerial');
  if (serial) config.zedSerial = serial;
  if (!source && device && /zed/i.test(device)) config.source = 'stereo';

  const pose = params.get('pose');
  if (pose === 'auto' || pose === 'static' || pose === 'orientation') config.pose = pose;
  const depth = params.get('depth');
  if (depth === 'auto' || depth === 'model' || depth === 'prior' || depth === 'none' || depth === 'injected') config.depth = depth;
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
    if (app.handle.inSession || headless) {
      landing?.classList.add('hidden');
      return;
    }
    // Auto-start failed (no camera, permission denied, insecure context): keep the card
    // with the reason instead of a silent black page; the button below retries.
    if (status) status.textContent = app.camera.diagnostics.error ?? 'camera did not start';
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
  const deviceSelect = document.getElementById('cam-device') as HTMLSelectElement | null;
  const deviceRefreshButton = document.getElementById('cam-device-refresh') as HTMLButtonElement | null;
  const serialInput = document.getElementById('cam-serial') as HTMLInputElement | null;
  const stereoModeSelect = document.getElementById('cam-stereo-mode') as HTMLSelectElement | null;

  async function populateDeviceOptions(): Promise<void> {
    if (!deviceSelect || !navigator.mediaDevices?.enumerateDevices) return;
    const previousValue = deviceSelect.value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    deviceSelect.innerHTML = '';
    const autoOption = document.createElement('option');
    autoOption.value = '';
    autoOption.textContent = 'auto (facing mode)';
    deviceSelect.appendChild(autoOption);
    for (const d of videoInputs) {
      const option = document.createElement('option');
      option.value = d.label || d.deviceId;
      option.textContent = d.label || `camera ${d.deviceId.slice(0, 8)}`;
      deviceSelect.appendChild(option);
    }
    // Restore the previous selection (URL param / localStorage / prior refresh) if still present.
    const wanted = config.device ?? previousValue;
    if (wanted) {
      const match = Array.from(deviceSelect.options).find((o) => o.value === wanted || o.value.toLowerCase().includes(wanted.toLowerCase()));
      if (match) deviceSelect.value = match.value;
    }
  }

  if (deviceSelect) {
    void populateDeviceOptions();
    deviceSelect.addEventListener('change', () => {
      writeStorage('device', deviceSelect.value);
      if (serialInput && /zed/i.test(deviceSelect.value)) serialInput.value ||= '25491304';
    });
  }
  if (deviceRefreshButton) {
    deviceRefreshButton.addEventListener('click', () => {
      void populateDeviceOptions();
    });
  }
  if (stereoModeSelect) {
    stereoModeSelect.value = config.stereoMode ?? 'vga';
    stereoModeSelect.addEventListener('change', () => {
      writeStorage('stereoMode', stereoModeSelect.value);
    });
  }
  if (serialInput) {
    serialInput.value = config.zedSerial ?? readStorage('zedSerial') ?? '25491304';
    serialInput.addEventListener('change', () => {
      writeStorage('zedSerial', serialInput.value);
    });
  }

  // "ZED SDK bridge" landing option: the sources are chosen when the app is constructed, so
  // switching reloads the page with ?source=zed-sdk&bridge=<url> (persisted like the device).
  const zedSdkCheckbox = document.getElementById('cam-zed-sdk') as HTMLInputElement | null;
  const bridgeInput = document.getElementById('cam-bridge-url') as HTMLInputElement | null;
  if (zedSdkCheckbox) {
    zedSdkCheckbox.checked = config.source === 'zed-sdk';
    if (bridgeInput) bridgeInput.value = config.bridgeUrl ?? 'ws://localhost:8765';
    zedSdkCheckbox.addEventListener('change', () => {
      const next = new URL(location.href);
      if (zedSdkCheckbox.checked) {
        const url = bridgeInput?.value || 'ws://localhost:8765';
        writeStorage('bridgeUrl', url);
        next.searchParams.set('source', 'zed-sdk');
        next.searchParams.set('bridge', url);
      } else {
        next.searchParams.delete('source');
        next.searchParams.delete('bridge');
      }
      location.assign(next.toString());
    });
    bridgeInput?.addEventListener('change', () => writeStorage('bridgeUrl', bridgeInput.value));
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
