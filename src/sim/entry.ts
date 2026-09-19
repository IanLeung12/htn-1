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
import { installLocomotion } from './locomotion';
import { getLandingDiagnosticLines } from '@/render/diagnostics';
import type { AppHandle } from '@/app/contract';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const headless = params.get('headless') === '1';
  const autoenter = params.get('autoenter') === '1';
  const environment = params.get('env') ?? undefined;
  const persistKey = params.get('persist') ?? undefined;

  const sim = await installSimulator({ environment });
  if (!headless) installLocomotion(sim.xrDevice);

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
    void renderLandingCard(handle);
  }

  if (autoenter) {
    try {
      await handle.enterAR();
      document.getElementById('sim-landing')?.classList.add('hidden');
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

/**
 * A minimal version of index.html's landing card, for manual (non-headless)
 * simulator use: same dark card, one-sentence pitch, "Enter AR" button, and
 * a capability list fed by `getLandingDiagnosticLines()`. Kept separate from
 * `renderHelpOverlay()` (the DevUI keyboard cheat-sheet, still useful once
 * a session is running) rather than merged into it.
 */
async function renderLandingCard(handle: AppHandle): Promise<void> {
  const style = document.createElement('style');
  style.textContent = `
    #sim-landing { position:fixed; inset:0; z-index:20000; display:flex; align-items:center;
      justify-content:center; padding:16px; background:radial-gradient(120% 120% at 50% 20%, #1a1a20 0%, #0b0b0d 70%);
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    #sim-landing.hidden { display:none; }
    #sim-landing .card { width:100%; max-width:360px; background:#16161a; border:1px solid rgba(255,255,255,0.08);
      border-radius:16px; padding:26px 22px; box-shadow:0 20px 60px rgba(0,0,0,0.5); text-align:center; color:#f2f2f5; }
    #sim-landing h1 { margin:0 0 6px; font-size:20px; font-weight:600; }
    #sim-landing p { margin:0 0 18px; font-size:13px; color:#9a9aa4; line-height:1.5; }
    #sim-landing button { display:block; width:100%; padding:13px 16px; font-size:15px; font-weight:600;
      color:#06101f; background:#5b9dff; border:none; border-radius:10px; cursor:pointer; }
    #sim-landing button:disabled { opacity:0.5; cursor:default; }
    #sim-landing .caps { margin:18px 0 0; padding:10px 12px; background:rgba(255,255,255,0.03);
      border:1px solid rgba(255,255,255,0.08); border-radius:10px; text-align:left; }
    #sim-landing .caps h2 { margin:0 0 6px; font-size:10.5px; font-weight:600; text-transform:uppercase;
      letter-spacing:0.06em; color:#9a9aa4; }
    #sim-landing .caps ul { margin:0; padding:0; list-style:none; font:11px ui-monospace, monospace;
      line-height:1.6; color:#9a9aa4; word-break:break-word; }
    #sim-landing a { display:inline-block; margin-top:14px; font-size:12px; color:#9a9aa4; text-decoration:none;
      border-bottom:1px dotted currentColor; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'sim-landing';
  root.innerHTML = `
    <div class="card">
      <h1>Reality Editor</h1>
      <p>Edit your room in place - simulated here with a synthetic room instead of a headset camera.</p>
      <button id="sim-enter-ar">Enter AR</button>
      <div class="caps">
        <h2>What works in this simulator</h2>
        <ul id="sim-caps-list"><li>Checking…</li></ul>
      </div>
      <a href="/">Back to the main app →</a>
    </div>
  `;
  document.body.appendChild(root);

  const capsList = root.querySelector('#sim-caps-list')!;
  const lines = await getLandingDiagnosticLines(6);
  capsList.replaceChildren(
    ...lines.map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }),
  );

  const button = root.querySelector('#sim-enter-ar') as HTMLButtonElement;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Entering…';
    try {
      await handle.enterAR();
      root.classList.add('hidden');
    } catch (err) {
      console.error('[sim] enterAR() failed', err);
      button.disabled = false;
      button.textContent = 'Enter AR';
    }
  });
}

main().catch((err) => {
  console.error('[sim] fatal error during bootstrap', err);
});
