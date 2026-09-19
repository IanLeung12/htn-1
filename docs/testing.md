# Testing: simulator + e2e

Reality Editor has no headset. Everything runs in desktop Chromium via Meta's IWER
emulator (`iwer` + `@iwer/sem` + `@iwer/devui`), which stands in for the Quest 3 browser's
WebXR runtime, passthrough camera, and scene understanding.

## Running the simulator by hand

```
npm run dev
```

Then open `http://localhost:5173/sim.html`. This:

1. Creates an emulated `XRDevice` (Meta Quest 3 config), installs the WebXR runtime, loads
   a Synthetic Environment Module (SEM) capture (`living_room` by default - one of
   `living_room`, `meeting_room`, `music_room`, `office_large`, `office_small`), and
   installs `@iwer/devui`'s manual controls.
2. Imports and starts the real app (`@/app/main`) against that emulated runtime, exactly
   like `index.html` does on-device.
3. Shows a small help overlay in the corner.

DevUI gives you manual keyboard/mouse control: **WASD** to move, drag with the mouse to
look, **Q/E** to move the hands (see the devui panel for the full key map - it's
independent of this project and may change with `@iwer/devui` versions), **space** to
pinch. Click "Enter AR" in the app's own DOM HUD to start the session (or pass
`?autoenter=1` - see below).

### Query parameters

| Param | Effect |
|---|---|
| `?env=<id>` | SEM capture to load (`living_room`, `meeting_room`, `music_room`, `office_large`, `office_small`) |
| `?headless=1` | Skip devui + the help overlay; skip the app's own DOM "Enter AR" button (`AppOptions.headless`) |
| `?autoenter=1` | Call `handle.enterAR()` automatically once the app has started |
| `?persist=<key>` | Forwarded to `startApp({ persistKey })` |

The programmatic simulator API is always available at `window.__sim` (see
`src/sim/types.ts` for the full `SimHandle` interface: `setHead`, `walkTo`, `lookAt`,
`setInputMode`, `hand(side)`/`controller(side)`, `loadEnvironment`, `listVolumes`,
`hideVolume`/`showVolume`, `perf`, `frameStats`). The app itself is at
`window.__realityEditor` (see `src/app/contract.ts`). Both are reachable from the browser
console for manual poking.

## Running the e2e suite

```
npm run test:e2e
```

This starts `vite` (via Playwright's `webServer` config) and runs every spec in
`tests/e2e/*.spec.ts` against `/sim.html?headless=1&autoenter=1&env=living_room`
(see `tests/e2e/fixtures.ts`). Each spec:

- fails if the page throws an uncaught exception or logs a `console.error` during the test
  (unless the test already failed for another, more specific reason);
- takes a full-page screenshot into `test-results/<test name>/failure.png` on failure;
- gets a `window.__testHelpers` object (installed by the fixture) with `dispatchIntent`,
  `spawnTestObject`, and `conditions` helpers so specs don't have to hand-roll
  `RuntimeConditions` for every `store.dispatch` call.

Chromium is launched with `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader --ignore-gpu-blocklist` (see `playwright.config.ts`) for
software WebGL2, since CI/dev machines running this suite may have no GPU. If WebGL
initialization ever regresses (e.g. a three.js r186+ upgrade requiring a newer flag), try
adding `--use-angle=swiftshader-webgpu` is *not* needed here - stick to the ANGLE/SwiftShader
GL path; this project does not use WebGPU.

## What each gate spec checks

Specs are organized by the feasibility gates in
`reality-editor-research-ledger.md` ("Go / no-go gates") and the measurement protocol in
the same document.

- **`gate1-session.spec.ts`** (Gate A - standalone reality): the `immersive-ar` session
  starts with `blendMode === 'alpha-blend'` (passthrough live), hand input mode is active,
  the quality tier is reachable and forceable (the safety-fallback control surface works),
  and at least 120 frames render with zero uncaught exceptions.
- **`gate2-registration.spec.ts`** (Gate B - captured layer): SEM's floor and at least one
  table-like surface show up in `store.current.surfaces`; after walking a ~2m loop, every
  previously-registered surface's pose is still present and bit-identical (this emulator's
  planes/meshes are static and only re-dispatch on `lastChangedTime` change - see
  `src/xr/scene-understanding.ts` - so "no drift" is a real invariant here, not a fuzzy
  tolerance check).
- **`gate3-discovery.spec.ts`** (Gate C - editable object): `runCandidateDiscovery()`
  returns at least one candidate from the room, and approving one is a normal, auditable
  `dispatch({ kind: 'approve' }, source: 'test')` transaction.
- **`gate4-cleanplate-edit.spec.ts`** (Gate D - truthful delete): approve → move the head to
  a good vantage point → `sim.hideVolume(id)` (emulates lifting the physical object away) →
  `captureCleanPlate` reaches tier A with coverage >= 0.95 (guided multi-viewpoint capture,
  `src/app/guide.ts` - a 4-viewpoint arc around the exposed footprint plus 3 off-path
  verification viewpoints, replacing the single current-head-pose viewpoint the app used to
  pass to the capture pipeline) → `sim.showVolume(id)` → delete → restore → undo → redo, all
  as real resolver transactions. A second test confirms deleting an approved-but-never-captured
  (tier E) object is rejected (`tier_forbids` - `TIER_CAPABILITIES.E` doesn't include `delete`
  at all, so the resolver never even reaches the background-coverage check for that case). A
  third test drives `captureCleanPlate` while sampling `AppHandle.guide` from inside the page
  (a microtask-based poll, since the simulator's frame captures are async-but-fast enough that
  a macrotask poll like `setInterval` would never get a turn) and asserts the step count
  strictly increases through the guided arc and `guide.active` ends `false`.
- **`gate5-dynamic-reality.spec.ts`**: exercises the quality-manager fallback path end to
  end (feed 12 `trackingOk: false` samples -> tier drops to 0 -> `main.ts`'s
  `quality.subscribe` handler force-dispatches `setMode('live-overlay')`), plus the region
  state machine now that `src/app/regions.ts` wires it into the store: waits for at least one
  region to exist (created reactively from `registerSurface` commits), drives the mode to
  `captured-shell` and polls a non-floor horizontal region to `CAPTURED`, calls
  `AppHandle.reportObstruction(point)` at its centre ("a person crossed here") and asserts it
  goes `HYBRID`/`dynamic_obstruction`, then - since that evidence is one-shot and never
  re-reported - polls it back to `CAPTURED` once the obstruction hold time (500ms,
  `src/core/regions.ts`) elapses via the state machine's own `TRANSITION` step. It then forces
  a region to `FALLBACK` for a reason the frame loop's own baseline-recovery never touches
  (`budget` - see `src/app/regions.ts`'s note on why `dynamic_obstruction` would race that
  check) and confirms a `move`/`delete` of an object inside it is rejected with
  `region_fallback`. A simpler smoke test also force-dispatches `setRegionState` directly on
  the first region that exists.
- **`interaction-grab.spec.ts`**: spawns a cube, moves a tracked hand onto it, pinches
  (`poseId = 'pinch'`, which is a fixed hand shape - see below), translates the hand 0.3m,
  releases, and checks the object's `currentPose` moved with it; plus the programmatic
  `AppHandle.grab()`/`release()` path.
- **`perf.spec.ts`**: spawns 8 objects, runs the frame loop for 600 frames past the current
  count, writes `{ stats, maxFrameMsInWindow }` to `test-results/perf.json`, and asserts no
  single frame in that window exceeded 250ms (a "did it wedge" check, not a device
  performance budget - see the note below).
- **`persistence.spec.ts`**: with a `persistKey`, spawns an object, waits out
  `autoPersist`'s 250ms debounce, reloads the page (fresh `XRDevice`, fresh app instance),
  and confirms the object rehydrates from `localStorage`.
- **`screenshots.spec.ts`**: not an assertion-driven spec - a visual smoke test that drives
  the simulator through a sequence of states and writes PNGs to `test-results/screens/` for
  human review (see `docs/ui.md` for what "good" looks like):
  - `01-live-overlay.png` - passthrough + the in-XR HUD strip, mode `live`.
  - `02-spawned-settled.png` - three physics-settled spawned cubes, mode `live`.
  - `03-captured-shell.png` - after `setMode('captured-shell')`, room-mode glyph filled.
  - `04-table-before-delete.png` / `05-table-deleted.png` - a captured table, tier A, before
    and after `delete` (clean-plate reveal).
  - `07-hand-menu.png` - the left hand raised in front of the head with its palm turned
    toward it (`window.__sim.hand('left').setPose(...)` + `.moveTo(...)`), showing the
    palm-up hand menu (`src/render/hand-menu.ts`). The rotation used here isn't an arbitrary
    guess: IWER's `relaxedHandPose` (the hand's rest pose) bakes a real rotation into the
    wrist joint's local offset, so both the palm-facing check (`src/xr/input.ts`'s
    `palmNormal`, a cross product of the index/pinky metacarpal joints) and the menu quads'
    own facing (they inherit `wristQuaternion` directly) are non-trivial functions of the
    hand root quaternion set via `setPose`. A small offline search over
    `node_modules/iwer/lib/device/configs/hand/relaxed.js`'s wrist transform (see
    `docs/ui.md`) found a single rotation, -66 degrees about world +X, that scores well on
    both at once (palm-toward-head dot ~0.77, button-quads-toward-camera dot ~0.78) - a
    different pick for either constraint alone (e.g. -90 degrees, dot 0.96) leaves the
    button quads viewed almost edge-on and effectively invisible.

## Key IWER facts discovered while building this (see `src/sim/bootstrap.ts` header for the
full writeup with citations to the exact `.d.ts`/`.js` files)

- **Session auto-grant**: `XRSystem.requestSession()` (the normal
  `navigator.xr.requestSession('immersive-ar', ...)` path) resolves immediately under
  emulation, no user gesture or `grantOfferedSession()` needed. `grantOfferedSession()`
  only matters if the app uses the separate `navigator.xr.offerSession()` pattern, which
  this app does not.
- **SEM render loop**: `sem.render(now)` is called automatically every XR frame by IWER's
  own `XRSession` device-frame loop while a session is active - not by SEM or the app. The
  camera source (`src/sim/camera-source.ts`) also calls `sem.render()` itself on
  `capture()`, so a frame is available even before any session exists.
- **Depth**: `sem.computeDepthBuffer(viewMatrix, projectionMatrix, w, h, near, far)` expects
  the *view* matrix (world-to-camera, i.e. `camera.matrixWorldInverse`), not the camera's
  world matrix - it inverts internally to recover the camera transform. It returns `null`
  if there are no tracked meshes at all (`trackedMeshes.size === 0`); SEM captures with only
  planes and no boxes/meshes would need a different clean-plate coverage story, but all five
  bundled captures include at least some box/mesh entities.
- **Hiding an object for clean-plate capture**: SEM has no public API to toggle one
  entity's visibility. `sim.hideVolume`/`showVolume` reach into SEM's private `objectMap`
  (a `Map<uuid, SpatialEntity>`, `SpatialEntity extends THREE.Mesh`) and toggle
  `Object3D.visible`. This is respected by both `sem.render()` (environmentCanvas) and
  `sem.computeDepthBuffer()` (which force the *group* visible for the depth pass but still
  respect each entity's own `.visible`).
- **Hand pinch is a fixed pose, not a continuous gesture in this app**: IWER's
  `XRHandInput.updateHandPose()` always interpolates between the *current* `poseId`'s joint
  transforms and the `pinch` pose's joint transforms, using `pinchValue` as the blend
  factor. When `poseId === 'pinch'`, that interpolation is `pinch -> pinch`, i.e. always the
  full pinch shape regardless of `pinchValue`. Since `src/xr/input.ts` derives pinch purely
  from the live index-tip/thumb-tip joint distance (not from `pinchValue`/the gamepad
  button), `sim.hand(side).pinch(true)` sets `poseId = 'pinch'` (which is sufficient by
  itself) and also calls `updatePinchValue(1)` for consumers that do read the gamepad axis.
- **Coordinate frames**: this IWER version's `local-floor`/`unbounded` reference spaces are
  constructed with **no offset** from `XRDevice`'s global space
  (`new XRReferenceSpace(type, device.globalSpace)`, identity offset matrix) - i.e.
  `local-floor` poses are numerically identical to `xrDevice.position`/`SEM` world
  coordinates in this emulator. That is *not* guaranteed by the WebXR spec on a real
  device (a real `local-floor` space is usually offset to floor level), so don't rely on it
  outside this simulator; it's noted here because several specs and `sim.setHead`/`lookAt`
  target the same coordinates as `store.current` object/surface poses, and that only works
  because of this specific behavior.
- **`xrDevice.remote` (`RemoteControlInterface`)** is a frame-synchronized command queue
  built for out-of-process control (e.g. driving the device from outside the page); most of
  its methods require an active XR session and are queued rather than immediate. Since the
  simulator is in-process, `src/sim/bootstrap.ts` does not use it at all - it mutates
  `xrDevice`/hand/controller position and quaternion directly (all are mutable
  `Vector3`/`Quaternion` wrappers returned by getters) and drives its own `walkTo`/`moveTo`
  animations via `requestAnimationFrame`, which works identically whether or not a session
  is active.

## Known emulator limitations

- **No real camera/photoreal capture on-device.** The simulator's `CameraFrameSource`
  reads SEM's synthetic room geometry, not a real depth/RGB sensor. It's good enough to
  exercise the full discovery -> capture -> tier -> edit -> delete -> restore pipeline
  end-to-end, but coverage/tier numbers are a function of the SEM capture's geometric
  fidelity and this project's fixed 320x240 capture resolution (`src/sim/camera-source.ts`),
  not of the real device's camera.
- **Depth is CPU-computed** by SEM (`computeDepthBuffer` renders the scene a second time
  with a depth material and reads back pixels on the CPU) rather than the GPU-optimized
  path a real Quest 3 would use. `XRFeatureReport.depthUsage`/`depthFormat` should still be
  reported by the session, but the *timing* characteristics of on-device
  depth-sensing are not represented here.
- **Perf numbers are indicative only.** `perf.spec.ts` runs on whatever machine executes
  the test (often software-rendered WebGL2 via SwiftShader), which is dramatically slower
  and has different bottlenecks than the Quest 3's mobile GPU. Treat `test-results/perf.json`
  as a regression trip-wire ("did this change make the stack visibly worse or get it
  stuck"), not as a stand-in for on-device profiling.
- **Depth-sensing freshness is unreliable under emulation.** `DepthOcclusion.state.ageMs` is
  `Infinity` whenever the session has never reported a depth-sensing texture, which is common
  here. `src/app/regions.ts`'s `RegionManager` treats a non-finite depth age as "no evidence
  either way" (0) rather than feeding it straight into `RegionStateMachine.tick()`, which
  would otherwise force every newly-`HYBRID` region straight to `FALLBACK`/`depth_stale`
  before an obstruction's hold time ever elapses.
- **`AppHandle.enterAR()`'s contract says it "resolves after the first frame renders"**, but
  as implemented in `src/app/main.ts` it resolves as soon as `requestARSession()` resolves,
  without awaiting the `firstFramePromise` it sets up. In practice this hasn't caused test
  flakiness (frames start rendering essentially immediately under emulation and specs poll
  for state rather than assuming exactly one frame has passed), but it's worth knowing if a
  future spec needs a guarantee that at least one frame has actually rendered before
  `enterAR()`'s promise settles.
