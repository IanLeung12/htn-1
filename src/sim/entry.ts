/**
 * Simulator page entry (loaded by sim.html). Installs the IWER runtime *before* importing
 * the app, then boots the app against it exactly like index.html does on-device.
 *
 * Query params:
 *   ?headless=1   - skip devui + the help overlay (used by Playwright)
 *   ?autoenter=1  - call handle.enterAR() automatically once the app has started
 *   ?env=<id>     - SEM capture to load (default living_room)
 *   ?persist=<key> - forwarded to startApp({ persistKey })
 */
import { installSimulator } from './bootstrap';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const headless = params.get('headless') === '1';
  const autoenter = params.get('autoenter') === '1';
  const environment = params.get('env') ?? undefined;
  const persistKey = params.get('persist') ?? undefined;

  await installSimulator({ environment });

  // Import the app *after* installSimulator so the emulated runtime is on
  // navigator.xr before any app code touches it. src/app/main.ts is owned by another
  // module (built in parallel against @/app/contract); a dynamic import with a
  // non-literal specifier was tried first to avoid a hard dependency on it existing at
  // typecheck time, but Vite/the browser can't resolve the '@' alias for a runtime
  // string that isn't a static import - only Vite's static-analysis transform rewrites
  // aliased specifiers. Now that src/app/main.ts exists, use a normal static import.
  const { startApp } = await import('@/app/main');
  const handle = await startApp({ headless, persistKey });

  if (!headless) {
    renderHelpOverlay();
  }

  if (autoenter) {
    try {
      await handle.enterAR();
    } catch (err) {
      console.error('[sim] enterAR() failed', err);
    }
  }
}

function renderHelpOverlay(): void {
  const el = document.createElement('div');
  el.id = 'sim-help';
  el.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:10000;font:12px monospace;color:#0f0;' +
    'background:rgba(0,0,0,0.6);padding:6px 8px;border-radius:4px;pointer-events:none;' +
    'max-width:340px;white-space:pre-line;';
  el.textContent =
    'Reality Editor simulator\n' +
    'DevUI panel: WASD move, drag look, Q/E hands, space pinch\n' +
    'window.__sim and window.__realityEditor are available in the console';
  document.body.appendChild(el);
}

main().catch((err) => {
  console.error('[sim] fatal error during bootstrap', err);
});
