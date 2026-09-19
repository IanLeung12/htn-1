# Reality Editor - Project State

Last updated: 2026-09-19 (session 1, feature pass 5)

## Decision log

- **2026-09-19 Stack:** WebXR app (Vite + TypeScript + Three.js r186) targeting the Meta Quest 3
  browser in `immersive-ar`. Unity is not installed on the build machine and no headset is
  attached, so the Unity/Meta-SDK assumptions in the planning docs are mapped onto WebXR modules:
  passthrough (`immersive-ar`), `depth-sensing` (gpu-optimized), `mesh-detection`,
  `plane-detection`, `anchors`, `hand-tracking`, `hit-test`. Raw camera access is not available
  in the Quest browser, so photoreal capture of *physical* objects on device is Tier E
  (placement-only). The simulator supplies a synthetic physical world so the full capture,
  clean-plate, move, delete, restore loop is implemented and tested end to end.
- **2026-09-19 Simulation:** Meta's IWER (`iwer` 2.4) + `@iwer/sem` (five real Quest room
  captures with emulated passthrough, planes, meshes, hit-test, depth) + `@iwer/devui`.
  Automated tests run in headless Chromium via Playwright driving IWER programmatically.
- **2026-09-19 Layering:** `src/core` is pure TS (no DOM/three) and holds the scene store,
  transaction resolver, region state machine, quality manager, freshness contract, persistence.
  `src/xr` owns session/features/input/depth. `src/render` owns three.js. `src/capture` owns
  candidate discovery, clean plates, object packages. `src/sim` owns IWER bootstrap.

## Status

| Area | Status |
|---|---|
| Planning docs read, stack chosen | done |
| Repo scaffold (vite/ts/vitest/playwright) | done |
| Core contract `src/core/types.ts` | done |
| Core logic (store, resolver, regions, quality, perf) | done, 103 unit tests |
| XR session + feature negotiation + input | done (untested on device) |
| Renderer (passthrough, shell, objects, depth occlusion) | done (untested on device) |
| Simulator page (IWER + SEM + devui) | done; lift/return of objects, requested-viewpoint camera source |
| Capture pipeline (discovery, clean plate, tiers) | done, 18 unit tests; end-to-end tier A in the simulator |
| E2E tests (Playwright + IWER) | 18 pass, 0 skipped |
| Region state machine wired into the app | done (`src/app/regions.ts`; regions created from tracked surfaces, driven every frame, obstruction/fallback tested e2e) |
| Multi-viewpoint guided capture in the app | done (`src/app/guide.ts`; 4-viewpoint arc + 3 off-path verification, `AppHandle.guide` UI state rendered by the HUD) |
| Proxy physics (settle, collide) | done, wired; system moves skip undo |
| Voice commands + hand menu | done, wired; deterministic grammar over the resolver |
| Diagnostics panel, HTTPS dev, manifest | done (`npm run dev:https`, docs/device.md) |
| Frame-loop allocation audit | done (docs/perf-audit.md, alloc e2e spec) |
| Asset catalog (6 glTF models, voice/menu spawn, proxy refit on load) | done |
| Compact HUD strip, selection label, palm menu, landing pages | done |
| Photometric: frame store, plate fix, textured shell, hull v2 (stencil-clipped multi-frame depth meshes) | done; deleted table matches ground truth exactly from 0 and 45 degrees |
| Persistent room anchor, anchor-relative persistence | done (device relocalization untested) |
| Two-hand move/yaw/scale with tier gating | done |
| Captured object appearance for moved physical objects; captured-shell carve | done (moved table matches reference within 18/255) |
| Captured-shell mode as tiled RGB-D room reconstruction (28 viewpoints, 1.5 m tiles, region-carved, 1.2 M vertex cap) | done (matches live view within 6/255 centre region) |
| Review fixes (tracking signal, watchdog, one snapshot per frame, session guards, grab rules) | done |
| Device validation on Quest 3 | blocked: no headset |

## Feasibility gates (from canonical architecture) mapped to tests

| Gate | How it is checked here |
|---|---|
| 1 passthrough + hands + safety fallback | e2e: session starts in AR, hands tracked, quality tier 0 reachable |
| 2 captured tile stays registered while walking | e2e: shell tile anchored to plane; head walks loop; drift metric |
| 3 approved object gets mask/proxy/anchor/tier | unit + e2e: capture pipeline output |
| 4 clean-plate object moves and deletes | unit: resolver; e2e: delete reveals plate |
| 5 person crossing not hidden | unit: region fallback on dynamic obstruction |
| 6 static shell depth masking | render: static surfaces excluded from depth occlusion |
| 8 5-10 objects sustained perf | e2e perf trace p95/p99 (emulated, indicative only) |

## Integration findings (2026-09-19, region wiring + guided capture pass)

- Regions have no creation intent story through `setRegionState` alone (it requires the
  region to already exist), so `src/core/types.ts`/`src/core/resolver.ts` gained two small
  additive intents, `registerRegion` (upsert by id) and `removeRegion` - both system-sourced,
  not undoable, mirroring `registerSurface`/`removeSurface`. `src/app/regions.ts`'s
  `RegionManager` creates one region per tracked surface (`table`/`desk`/`shelf`/`couch`/
  `bed`/`storage`/`floor`, or vertical `wall`), id `region:<surfaceId>`, bounds = surface aabb
  expanded 0.25m (floor: +0.5m up), reactively off `registerSurface`/`removeSurface` commits.
- Depth-sensing freshness (`DepthOcclusion.state.ageMs`) is `Infinity` whenever the XR session
  has never reported a depth-sensing texture, which is common under emulation. Feeding that
  straight into `RegionStateMachine.tick()`'s `depthAgeMs > depthStaleMs` check would force
  every newly-HYBRID region straight to `FALLBACK`/`depth_stale` before an obstruction hold
  time ever elapses. `RegionManager` treats a non-finite depth age as "no evidence either way"
  (0) rather than "maximally stale" - see `RegionManagerOptions.effectiveDepthAgeMs`.
- `RegionStateMachine.request()`'s legal-transition table has no direct `CAPTURED -> LIVE`
  edge (only `FALLBACK -> LIVE`), so returning a region to LIVE when the app leaves
  captured-shell mode goes through a same-frame `FALLBACK` (reason `user`) hop first. The
  baseline driver in `RegionManager.tickRegion` only auto-recovers its own `user`-reason
  fallback; every other fallback reason only clears through the state machine's own
  evidence-driven `tick()` path (e.g. `dynamic_obstruction`'s hold-time expiry ->
  `TRANSITION` -> `CAPTURED`), so a forced `budget`/`thermal`/etc. fallback is not silently
  undone by the mode-driven baseline logic.
- Guided multi-viewpoint capture (`src/app/guide.ts`) plans a 4-viewpoint arc (1.2-1.6m eye
  height, 1.0-1.4m from the footprint centre, 60 degrees apart, starting at the current head
  bearing, each looking at the footprint centre) plus 3 off-path verification viewpoints,
  replacing the single current-head-pose viewpoint `captureCleanPlate` used before. In the
  simulator this reliably reaches tier A with ~full coverage (was tier A/B, >0.6 coverage
  with the single-viewpoint version).

## Integration findings (2026-09-19)

- Emulator depth: `@iwer/sem` decodes its RGBADepthPacking target without three.js's 255/256
  unpack scale, inflating depth 3-8% at room scale. Corrected in `src/sim/camera-source.ts`.
- Emulator surfaces bump `lastChangedTime` every frame; scene understanding now uses a pose +
  size signature for change detection (was causing ~200 store commits per second).
- Quest furniture volumes are rotated and have their origin at the top face; AABBs are now
  computed from rotated vertices and the volume centre is the AABB centre.
- Lifting an object in the simulator must also carve the global scan mesh and take stacked
  objects (a lamp on the table) with it; otherwise depth still sees the object.
- Grab release must commit the previewed pose, not the stale current pose.
- Persistence debounce needs a max wait because previews commit every frame.
- Deleting a spawned/imported object needs no background plate (it hides nothing real).
- Proxy physics drops mid-air objects, so e2e test objects default to kinematic.
- Physical-object proxies are world-aligned AABB half extents, so their pose rotation is identity;
  applying the Quest volume's rotation misplaced the background hull.
- Background plates and hulls must be unlit: they are photos with lighting baked in.
- Projecting one clean-plate photo onto the object's box shows parallax error from other
  viewpoints; the fix is reprojecting the frame's RGB-D as a depth mesh clipped to the object's
  silhouette (stencil), which is what the capture doc predicted.

## Live-browser findings (2026-09-19, real GPU, DevUI simulator)

- three.js draws the WebXR depth-sensing occlusion mesh with group order -Infinity, before
  everything and regardless of renderOrder. Its real-scene depth blocked every hull, plate, and
  appearance fragment, so deletes were invisible whenever depth sensing was active (a real Quest,
  or Chrome with a GPU). Headless SwiftShader has no GPU depth path, which is why e2e passed.
  Fix: a colourless depth-reset box (depth forced to far) inside the object silhouette at
  renderOrder 0.5, then captured content at 1, objects at 2. Limitation: a hand inside that
  silhouette is not depth-occluded until the captured-content shader samples the depth texture.
- Stencil clipping is unreliable across XR framebuffers; silhouette clipping now happens in the
  fragment shader with the app head pose as the eye.
- With the DevUI installed the emulator is in manual control mode (scripted head moves are
  ignored) and renders stereo over a mono passthrough image; use programmatic control and
  stereoEnabled=false for scripted demos.
- The shell tile for a hidden object was never skipped (surface id vs object id mismatch).

## Suggested next steps

1. Device validation on a Quest 3: feature report, depth texture format, hand confidence, anchor
   relocalization, real frame budget (`docs/device.md`).
2. Room reconstruction polish: multi-frame blending per tile, hole filling, higher camera
   resolution when a real camera source exists.
3. Guided capture UX on device: the HUD floor markers exist; a real walk-through has not been done.
4. Oriented proxies for rotated real objects (carve/appearance filters assume axis-aligned boxes).
5. Text-to-3D / asset generation as an offline job feeding the catalog (explicitly out of the
   render loop per the architecture).

## Known limitations

- Guided capture sweeps a 180 degree arc from the head bearing; head positions behind the
  object can find per-pixel gaps in hull coverage and fall through to live passthrough. Widen
  the arc or add a second pass when the envelope is enlarged.
- Captured-shell carve and appearance meshes assume identity-rotation, axis-aligned proxies (true
  for discovered objects today); rotated real objects would need oriented-box filters.
- Emulator frame rate is software-GL bound (5 to 10 fps); app CPU per frame is under 1 ms.
- Two agents running Playwright at once share port 5173; run suites serially.

## Open questions / risks

- Quest browser depth-sensing texture format on real hardware (texture-array vs texture) must be
  confirmed on device; renderer supports both.
- SEM depth is CPU-computed in the emulator; on-device gpu-optimized path untested.
