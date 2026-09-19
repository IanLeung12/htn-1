# Running on a real Quest 3

## 1. Serve the app

Two ways to get the Quest 3 browser to see `navigator.xr` (WebXR requires a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
HTTPS, or `localhost`):

### Option A - `adb reverse` + plain HTTP (recommended for iteration)

`localhost` is always a secure context, so the plain dev server is enough as
long as the headset's `localhost:5173` is tunneled to your dev machine's
`localhost:5173` over USB:

```bash
npm run dev                       # plain http://localhost:5173 on your machine
adb reverse tcp:5173 tcp:5173     # forward the headset's localhost:5173 to yours
```

Then, **in the Quest browser**, open `http://localhost:5173/`. Requires
Developer Mode enabled on the headset, the Meta Quest Developer Hub / Android
Platform Tools (`adb`) installed on your machine, and the headset connected
over USB with USB debugging allowed (accept the prompt in the headset).
Verify the connection first with `adb devices` - the headset should show as
`device`, not `unauthorized`.

### Option B - HTTPS over LAN (no cable required)

```bash
npm run dev:https    # vite --host --mode https, self-signed cert via @vitejs/plugin-basic-ssl
```

This starts the same dev server but with a locally-generated self-signed TLS
certificate (via `@vitejs/plugin-basic-ssl`, loaded only in `--mode https` -
`npm run dev` is unchanged and stays plain HTTP). Find your dev machine's LAN
IP (e.g. `192.168.1.23`) and open `https://192.168.1.23:5173/` in the Quest
browser. The browser will warn about the untrusted self-signed certificate;
you must accept/continue past that warning (usually "Advanced" ->
"Proceed") for the page to load and for `navigator.xr` to be available. Both
devices must be on the same network, and some networks (guest Wi-Fi, client
isolation) block device-to-device traffic - if the page won't load, prefer
Option A.

## 2. Enabling WebXR features in the Quest browser

Passthrough (`immersive-ar`), hand-tracking, plane-detection, and persistent
anchors ship without any flags in the Meta Quest browser (Meta's WebXR mixed
reality docs describe requesting `immersive-ar` sessions with the
`plane-detection` feature descriptor and persistent anchors via
`requestPersistentHandle`/`restorePersistentAnchor` - no special browser
setting is documented for these:
<https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/>).

Depth-sensing history, since this matters for `src/xr/depth.ts`:

- WebXR depth-sensing was updated to the current spec shape (the
  `depthSensing` session-init dict this app uses in `src/xr/session.ts`) in
  the Quest browser in mid-2024.
- As of Quest browser **40.4** (rolling out in 2026), the browser also uses
  Meta's separate, non-WebXR "Depth API" (real-time stereo-disparity depth,
  Quest 3 / Quest 3S only, effective range ~5 m) to power **instant WebXR hit
  testing** without a scene mesh
  (<https://www.uploadvr.com/quest-browser-depth-api-webxr-hit-testing-instant-placement/>).
  That is a separate feature from the `depth-sensing` WebXR feature this app
  requests for occlusion; don't confuse "hit-test got faster/meshless" with
  "depth-sensing occlusion changed."
- Quest 3 supports `depth-sensing` with `gpu-optimized` usage and a
  `texture-array` (WebGL2 `TEXTURE_2D_ARRAY`) depth texture - the format
  three.js's built-in occlusion shader expects
  (`node_modules/three/src/renderers/webxr/WebXRDepthSensing.js` samples a
  `sampler2DArray`). Three only wires up its occlusion mesh when
  `session.depthUsage === 'gpu-optimized'` **and** the browser exposes the
  WebGL2 depth-sensing binding - if a future runtime only grants
  `cpu-optimized`, `depth-sensing` will show as an *enabled* feature (see the
  diagnostics panel) while the occlusion mesh never appears, which is why
  `src/xr/session.ts` requests `usagePreference: ['gpu-optimized',
  'cpu-optimized']` (gpu-optimized first) and `src/render/diagnostics.ts`
  surfaces `depthUsage`/`depthFormat` separately from whether the occlusion
  mesh is actually available, so that mismatch is visible instead of silently
  looking like "nothing is occluding."
- We could not find a documented `chrome://flags`-equivalent toggle required
  to turn depth-sensing on for a normal (non-origin-trial) WebXR site on
  current Quest browser builds; if a future Quest browser update reintroduces
  an experimental-features flag for it, it would appear in
  `oculus-browser://flags` (the Quest browser's internal flags page, opened
  from within the headset browser) rather than desktop `chrome://flags`.

No headset-side action was found to be required beyond granting the runtime
permission prompts (hand tracking / spatial data) that the browser shows the
first time a site requests those features.

## 3. Reading the on-device diagnostics

`src/render/diagnostics.ts` renders a small panel (top-right, monospace, dark
background) that is visible **before** entering AR - so `navigator.xr`
presence and `isSessionSupported('immersive-ar')` can be checked without a
Quest - and continues updating once a session starts (4 Hz refresh; it's a
diagnostic surface, not a display-critical one). It shows:

- `navigator.xr` present / `immersive-ar` supported
- the session's `XRFeatureReport`: which optional features actually got
  enabled vs. were requested-but-missing, the blend mode, and depth
  usage/format
- the bound reference space type
- `session.frameRate` / `supportedFrameRates`, and whether a guarded
  `session.updateTargetFrameRate(90)` attempt succeeded
- hand-tracking availability, plane/mesh counts, depth-sample age
- the current quality tier, frame-time p50/p95/p99, and the last 5 quality
  tier-change history entries

The same lines are available via `diagnostics.getLines()` so the in-XR HUD
(`src/render/hud.ts`) can mirror a subset of this once a session is active and
the DOM panel is no longer visible inside the headset's compositor.

## 4. Capturing a remote DevTools profile

1. Enable Developer Mode on the headset (via the Meta Horizon mobile app,
   Devices -> your headset -> Developer Mode) and install Android Platform
   Tools so `adb` is on your `PATH`.
2. Connect the headset over USB and accept the "Allow USB debugging" prompt
   inside the headset. Confirm with `adb devices` - it must show `device`,
   not `unauthorized`.
3. Forward the dev server port if you're using Option A above:
   `adb reverse tcp:5173 tcp:5173`.
4. On your desktop, open Chrome and navigate to `chrome://inspect/#devices`.
   The Quest browser tab running Reality Editor should appear under "Remote
   Target" (may take a few seconds; make sure "Discover USB devices" is
   checked).
5. Click **inspect** to open a full desktop DevTools window attached to the
   headset's tab. From there:
   - **Performance panel:** click record, interact in the headset for the
     window you want to profile, stop, and you get a normal flame chart /
     allocation timeline - this is the most direct way to verify the
     frame-loop allocation fixes in `docs/perf-audit.md` on real hardware.
   - **Memory panel:** take heap snapshots or a "Allocation instrumentation on
     timeline" recording to look for retained per-frame objects.
   - **Console:** `window.__realityEditor.perf.stats('frameMs')` and
     `window.__realityEditor.quality.decision` are available directly (see
     `src/app/contract.ts`).

Sources: [Meta WebXR mixed reality docs](https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/),
[Meta WebXR workflow docs](https://developers.meta.com/horizon/documentation/web/webxr-workflow/),
[Meta browser remote debugging docs](https://developers.meta.com/horizon/documentation/web/browser-remote-debugging/),
[UploadVR: Quest browser Depth API hit testing](https://www.uploadvr.com/quest-browser-depth-api-webxr-hit-testing-instant-placement/).
