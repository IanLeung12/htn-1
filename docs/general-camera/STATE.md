# General-camera backend - state

Branch: `worktree-agent-a44ecaa8a93687167` (dev server + Playwright on port 5179 on this
branch only; 5177 is the owner's real-camera test origin). Architecture: `docs/general-camera/architecture.md`.

## Decisions

- **Sibling entry, not a switch.** `startCameraApp` (`src/camera/app.ts`) is a sibling of
  `startApp`; `src/app/main.ts` and the WebXR path are untouched. The camera app returns
  an `AppHandle` (exposed as `window.__realityEditor`) plus a `CameraHandle`
  (`window.__camera`) so the HUD, voice layer, resolver, renderers, and e2e helpers are
  shared by import.
- **Only additive changes outside `src/camera`:** `CameraFrame` gained optional
  `depthSource`, `depthConfidence`, `poseConfidence`, `depthToleranceM`
  (`src/capture/contract.ts`); `plates.ts` honours `depthToleranceM` when present
  (default unchanged). `vite.config.ts` gained the `camera.html` input, the
  `@huggingface/transformers` optimizeDeps exclusion and ES-format workers.
- **World frame = the dominant support plane.** The largest roughly-horizontal plane in
  the estimated depth (desk, bed, floor - whatever the camera mostly sees) is y = 0; its
  normal gives the camera's pitch and roll (`DepthSurfaceEstimator.correction`, applied
  smoothed to the static pose when tuning `autoAttitude` is 1); its distance is
  `cameraHeightM`. Other horizontal planes at any height become `table` surfaces, vertical
  planes become `wall` surfaces, so physics/`surfaceBelow` land spawned objects on the
  desk/bed the camera looks at. The floor prior remains the fallback before depth arrives.
- **Scale anchor.** A relative monocular model has no metric scale; the fit
  (`src/camera/depth/fit.ts`) anchors it on the analytic depth of the ground plane at
  tuning `cameraHeightM` below the camera. Height is therefore a tunable, not a
  measurement (`depthScale`/`depthShiftM` are additional live corrections).
- **Pointer -> InputState.** Mouse/touch synthesize the right (and, for a second touch,
  left) `HandState` so `InteractionController` is reused unchanged; drags slide along the
  horizontal plane of the grab point (wheel lifts); the virtual hand's ray origin is pulled
  to within 1 m of the hit so the controller's 3 m hover reach applies to far objects.
  Spawning uses the depth hit under the pointer/screen centre (`pickWorld`), snapped to the
  surface below, so objects land on what the camera looks at.
- **Depth model:** Depth Anything V2 small via `@huggingface/transformers` in a Web
  Worker (WebGPU, WASM fallback; owner measured 220-300 ms/frame on WebGPU, RTX 5060).
  Plane-prior analytic depth is the fallback and the e2e default (`?depth=prior`);
  `?depth=injected` is the test seam the e2e uses to push synthetic RGB-D maps.
- **Real objects, single fixed camera (tier D).** `Discover` is the approval gesture: each
  depth volume with a support surface is registered, approved, its appearance captured
  from the live frame (`setVisual baked`), and a synthetic support plate is inpainted
  from the ring around its footprint (`src/camera/synthetic-plate.ts`,
  `synthetic_completion`/`completed_v3`, tier D: move/restore/undo, no delete). Delete
  needs an observed clean plate (`captureCleanPlate` after the object was physically
  removed), which monocular depth caps at tier B (`src/camera/tier-cap.ts`).
- **Tracking loss from motion.** Every pose source is wrapped in `VisualPoseSource`
  (`src/camera/pose/visual.ts`): sparse Lucas-Kanade flow between grabbed frames; median
  flow above 6 px marks the camera as moving -> `trackingOk` false until it settles
  (edits pause through the resolver's `tracking_lost`). `?pose=visual` also integrates
  the flow's rotation into the pose (heading drifts; documented heuristic).
- **Tunables.** `src/camera/tuning.ts` (`window.__camera.tuning`, persisted in
  localStorage under `reality-editor-camera:tuning`, `t` toggles the slider panel):
  camera height/pitch/FOV/autoAttitude, depth scale/shift/smoothing, RANSAC threshold/
  iterations/min inliers/min plane extent, cluster cell/min count/min height, volume max
  side, surface interval, point stride. URL params override persisted values.
- **Fake camera in tests:** Chromium `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-video-capture` with a synthetic Y4M written by `tests/e2e/y4m.ts`
  at test time (Chrome only reads Y4M there). Firefox: `tests/e2e/firefox-camera.spec.ts`
  (run with `--browser=firefox`; skipped otherwise) uses Firefox's fake-stream prefs.

## Status

| Phase | Item | Status |
|---|---|---|
| 1 | `camera.html`, frame sources, static/orientation pose, floor prior, pointer input, HUD, diagnostics | done; `camera-phase1.spec.ts` 4/4 |
| 2 | Plane-prior depth; model worker + metric fit; `DepthEstimator.sample()` into `CameraFrame`; scale/shift/smoothing | done; owner-verified on WebGPU |
| 3 | RANSAC ground/tables/walls + volumes (`surfaces/ransac.ts`, `surfaces/depth-surfaces.ts`); attitude from the dominant plane; depth pick for spawn; tunables panel + persistence | done; `camera-capture.spec.ts` (injected depth) green |
| 4 | Discovery -> approve -> appearance + synthetic plate (tier D) -> move; observed clean plate -> tier B -> delete with hull over video | done (single viewpoint); multi-shot guide for moving cameras wired |
| 5 | Optical-flow motion -> `trackingOk`; regions recover from `tracking_lost` when tracking returns (`RegionManager.recoverTrackingFallbacks`, camera app only); `?pose=visual` rotation integration | done; `camera-tracking.spec.ts` green |
| - | Firefox black screen (owner report) | not reproduced in Firefox 155 with fake media (video, WebGL, WASM depth all fine); hardened: `facingMode: { ideal }`, landing card now shows the start error instead of hiding over black |

Checks on this branch: `npx tsc --noEmit` clean; `npx vitest run` 280 passed; `npx vite build`
green; Playwright camera specs 6/6 (phase1 4, capture 1, screenshot 1); XR suites 29/29
(re-run after phase 1; re-run again before the next merge).

## Integration findings

- Vertical-plane RANSAC must sample only points no horizontal plane claimed
  (`FindPlanesOptions.candidateMask`); otherwise the ground dominates every 3-point
  sample and walls are found ~30% of the time.
- A 0.3 m box top is a horizontal plane with > 100 inliers at 320x240/stride 2; the
  `planeMinExtentM` (0.4 m larger side) filter is what keeps it a volume, not a table.
- Point cloud density matters: stride 4 on 160x120 left ~20 points on a 0.3 m box at 2 m
  (below `clusterMinCount`); the app uses stride 2 on 320 px grabs (~16k points,
  ~200 ms per RANSAC run). That run now happens in a Web Worker
  (`surfaces/worker.ts`, `WorkerSurfaceEstimator`), one map in flight, results applied on
  the next frame; without Worker support it runs inline.
- `#app` is `position: fixed`; forcing `relative` collapsed it to 0 height (black overlay).
- Floor surfaces carry a +-0.01 m aabb pad (same as XR planes): physics settles a 0.08 m
  cube at y = 0.09.
- The pointer's world point must not be read before any pointer event (`right.active`).
- Losing most LK corners between frames (bump beyond the pyramid range) must count as
  motion, not as "0 px"; `VisualPoseSource` reports it above the loss threshold.
- The core region machine never leaves `FALLBACK/tracking_lost` on its own and the XR
  baseline driver only recovers `user` fallbacks, so after a bump every edit was refused
  with `region_fallback` forever; the camera app requests LIVE once tracking is back.

## Real-camera feedback (owner, Chrome, laptop webcam 640x480, WebGPU depth 227 ms)

- Bug 1 (fixed): the model estimator stopped publishing once the ground-anchored scale
  fit failed (camera level, floor out of frame); RANSAC kept refitting a stale map. Now it
  never stops: scale falls back to a temporal fit against the previous map, then the last
  good fit, then a bottom-band anchor (`fitInverseDepthBand`), each with lower confidence;
  diagnostics show `frames`, `published ... ago`, and the scale mode.
- Bug 2 (fixed): one surface split into layers 2-12 cm apart. Planes are now extracted
  best-first without a normal constraint (`extractPlanes`; a loose threshold otherwise
  slices a wall into "horizontal" strips), layered horizontals merge within
  max(0.08, 2 x threshold) with XZ overlap, default `ransacThresholdM` 0.05, extents are
  the 3-97 percentile of inliers, points beyond 6 m are ignored.
- Bug 3 (fixed): 20 degree roll from a small noisy fit. Attitude is learned only from planes
  with > 2000 inliers and confidence > 0.6, smoothed with a 2 s time constant.

## Next steps

1. Owner feedback loop on the real camera: tune `planeMinExtentM`, `clusterMinCount`,
   `ransacThresholdM`, `depthScale` live; record good defaults here.
2. Record RANSAC worker latency from the owner's laptop in this file.
3. Multi-frame appearance for moved real objects (accumulate frames as the camera pans in
   `?pose=visual`); hull from several shots.
4. E2E for `?pose=visual` rotation integration.
5. Phone test over HTTPS (`npm run dev:https`): orientation pose + two-finger scale/yaw.
