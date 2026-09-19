# Reality Editor - Project State

Last updated: 2026-09-19 (session 1, integration pass)

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
| E2E tests (Playwright + IWER) | 18 pass, 1 skipped (region wiring) |
| Region state machine wired into the app | todo |
| Multi-viewpoint guided capture in the app | todo (pipeline supports it; app passes one viewpoint) |
| Proxy physics (settle, collide) | todo |
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

## Open questions / risks

- Quest browser depth-sensing texture format on real hardware (texture-array vs texture) must be
  confirmed on device; renderer supports both.
- SEM depth is CPU-computed in the emulator; on-device gpu-optimized path untested.
