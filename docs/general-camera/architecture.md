# General-camera backend: architecture

Reality Editor's production path is the Quest 3 browser in WebXR `immersive-ar`: the
compositor draws passthrough, the runtime gives us a tracked head pose, planes, meshes,
and per-pixel depth. This document describes the second backend, which makes the same
editor work with **any camera** - a phone or laptop webcam (`getUserMedia`), a USB/RTSP
camera bridged through a `<video>` element, or a recorded video - where none of those
signals exist and all of them must be *estimated*.

The guiding rule is unchanged from the canonical architecture: **the display never
waits on estimation**. Video is drawn at camera rate; depth, pose refinement, and plane
fitting are asynchronous producers that publish stamped, confidence-tagged results the
frame loop reads once per frame.

## Decision: sibling entry, shared modules

`src/app/main.ts`'s `startApp` stays untouched (the WebXR path must not change
behaviour). The camera backend is a **sibling** `startCameraApp` in `src/camera/app.ts`
that reuses the same modules by import:

| Shared as-is | From |
|---|---|
| scene store, resolver, regions, quality manager, perf, freshness, persistence | `src/core` |
| `ObjectViews`, `PlateRenderer`, `BackgroundHull`, `ShellRenderer`, `GuideOverlay`, projective materials, depth meshes | `src/render` |
| `InteractionController` (consumes an `InputState`) | `src/app/interaction.ts` |
| `RegionManager`, `planCaptureViewpoints`, `spawnAsset`, catalog + proxy fit, voice grammar/controller | `src/app` |
| capture pipeline (`discover`, `acquireCleanPlate`, `verify`), `FrameStore`, `CameraFrame` contract | `src/capture` |

Everything camera-specific lives in the new `src/camera/` family and the new page
`camera.html` -> `src/camera/entry.ts`. Extending `AppOptions` with a
`backend: 'webxr' | 'camera'` switch was rejected because `startApp` is 760 lines of
XR-specific wiring (`renderer.xr`, `XRFrame`, reference spaces, anchors); a switch would
either duplicate that wiring behind flags or make the XR path depend on camera code.
`AppHandle` is still the public shape: `startCameraApp` returns an `AppHandle` (plus a
`camera` sub-handle, also exposed as `window.__camera`) so the existing e2e helpers,
HUD, and voice layer work unchanged. `enterAR()` on the camera handle starts the
camera; `inSession` means "video is playing".

## Data flow

```
 <video>  (getUserMedia | file | URL | fake device)
    |
    |  drawn full-screen behind a transparent three.js canvas   (RenderBackend)
    |
    +--> FrameSource.grab(): downscaled RGBA (<= 320 px wide) + timestamp
              |                       \
              |                        +--> DepthEstimator (Web Worker: transformers.js,
              |                        |    Depth Anything V2 small, WebGPU -> WASM)
              |                        |    publishes Stamped<DepthMap> (relative inverse depth
              |                        |    + metric scale/shift fitted against the floor plane)
              |                        |
              |                        +--> PoseSource (static tripod | device orientation |
              |                        |    orientation + optical-flow refinement)
              |                        |    publishes Pose + PoseQuality
              |                        |
              |                        +--> SurfaceEstimator (floor from camera height/pitch,
              |                             then RANSAC planes on the metric depth)
              |                             -> Surface[] + DetectedVolume[] -> store / discovery
              |
              +--> CameraFrameSource.capture(viewpoint?) : CameraFrame { rgba, depth?, pose, fovY, aspect }
                   (newest video frame + newest depth resampled to it + pose at that time;
                    `viewpoint` is advisory - a real camera can only capture from where it is)

 PointerInputAdapter (mouse/touch) ----> InputState ----> InteractionController ----> store
 VoiceController ------------------------------------------------------------------> store
 store.current --(once per frame)--> ObjectViews / Plates / BackgroundHull / Shell --> canvas
```

## Abstractions (`src/camera/contract.ts`)

- **`FrameSource`** - owns the `<video>` element and the media stream. `start()`,
  `stop()`, `readonly video`, `readonly intrinsics` (`fovY`, `aspect`, pixel size),
  `grab(maxWidth)` -> `{ rgba, width, height, timestamp }` from an offscreen canvas.
  Implementations: `MediaStreamFrameSource` (getUserMedia; also what the Playwright fake
  device feeds), `VideoFileFrameSource` (a URL/`File`, looped). RTSP is out of scope in
  the browser; it is bridged by any server that re-muxes to HLS/WebRTC and then handled
  as a URL.
- **`DepthEstimator`** - `start()`, `submit(frame)` (drops if busy: at most one in
  flight), `readonly latest: Stamped<DepthMap> | undefined`, `readonly status`
  (`loading | ready | unavailable`, backend `webgpu | wasm | none`, model id, last
  inference ms). `DepthMap` = `{ width, height, inverse: Float32Array, scale, shift }`
  plus `metricDepth()`; the metric depth is `1 / (scale * inverse + shift)`.
  Implementations: `WorkerDepthEstimator` (real model), `PlanePriorDepthEstimator`
  (analytic depth of the estimated floor plane, used when the model is unavailable and
  by e2e tests so they need no network), `NoDepth`.
- **`PoseSource`** - `readonly pose: Pose`, `readonly quality: PoseQuality`, `update(now)`.
  `PoseQuality` = `{ mode: 'static' | 'orientation' | 'visual', confidence: 0..1,
  trackingOk: boolean, driftM: number }`. Implementations: `StaticPoseSource`
  (tripod/laptop: fixed height and pitch, confidence 1 for orientation, 0 for
  translation), `OrientationPoseSource` (DeviceOrientation / `RelativeOrientationSensor`
  on phones, complementary-filtered, position held at the configured height),
  `VisualPoseRefiner` (later phase: sparse optical flow between consecutive grabbed
  frames to estimate rotation drift when sensors are absent, and to detect large
  camera motion so `trackingOk` can drop).
- **`SurfaceEstimator`** - `update(depth | undefined, pose, now)`; publishes
  `Surface[]` (floor plane always; table-height horizontal planes when the depth model
  finds them) and `DetectedVolume[]` (clusters of depth above a support plane) with a
  per-surface `confidence`. Phase 1 uses the *prior floor* (camera height + pitch, world
  origin on the floor under the camera); later phases fit planes by RANSAC on the metric
  depth and replace the prior when the fit is confident.
- **`InputAdapter`** - `PointerInputAdapter`: mouse/touch on the canvas -> the same
  `InputState` (`src/xr/input.ts`) hand-tracking produces, so `InteractionController` is
  unchanged. The virtual hand's ray is the pointer ray through the camera; its grab
  point rides the ray at the depth of the object hit, and while dragging it slides along
  the horizontal plane at the grab height (so objects glide over the floor/table);
  wheel or a second finger lifts/lowers; two-finger pinch/rotate maps to scale/yaw.
- **`RenderBackend`** - `CameraRenderBackend`: the `<video>` element below a
  transparent WebGL canvas (alpha 0 clear, `renderer.xr` disabled), a
  `PerspectiveCamera` whose `fov`/`aspect` are the camera intrinsics and whose pose is
  the `PoseSource` pose. Same scene graph order as XR: shell -> stencil boxes -> depth
  meshes -> objects. A depth occlusion mesh from the estimated depth is a later phase.

## Coordinate frame

World is y-up, metres. The origin is on the floor directly below the camera at start;
+X right, -Z forward along the camera's initial horizontal heading. `Surface` records
for the floor sit at y = 0, exactly like `local-floor` in XR, so `GuideOverlay`,
`surfaceBelow`, physics, and discovery keep their assumptions. The camera pose is
`(0, h, 0)` rotated by pitch/yaw/roll; `h` (camera height above the floor) is a user
setting with a default per device class (1.1 m laptop on a desk, 1.4 m handheld phone)
and is refined once RANSAC finds the floor.

The camera frustum's vertical field of view is not reported by `getUserMedia`; the
default is 50 degrees (typical laptop webcam ~ 55 deg diagonal at 4:3) and can be set
with `?fov=` or in the settings drawer. FOV error scales every metric estimate, which is
one more reason estimated frames are confidence-tagged (below).

## Truthfulness contract for estimated depth and pose

Quest depth and tracking are *measured*; here they are *inferred*. The contract:

1. **Every estimated frame is tagged.** `CameraFrame` gains optional, additive fields
   `depthConfidence` (0..1), `poseConfidence` (0..1), `depthSource:
   'sensor' | 'monocular' | 'plane-prior'` and `depthToleranceM` (declared in
   `src/capture/contract.ts` as optional fields; existing producers never set them and
   existing consumers ignore them). The XR/simulator sources are unaffected.
2. **Tier caps.** Clean plates whose frames carry monocular or plane-prior depth
   cannot reach tier A: the camera app wraps `acquireCleanPlate` with a
   `capTierForEstimatedDepth` step that downgrades `observed_clean_plate` /
   `observed_v1` to `multi_view_observed` / `fused_v2` (tier B) unless a
   **multi-view agreement** check passes: at least three capture viewpoints whose
   metric depth of the exposed region agrees within 8 cm RMS *and* whose poses differ by
   more than 15 degrees of bearing (a static tripod never satisfies the second clause,
   so a tripod caps at tier B; delete stays allowed, scale does not). Plane-prior
   depth caps at tier C (`constrained_surface`).
3. **Depth tolerance follows confidence.** `plates.ts` accepts an observation only if
   the sampled depth is within 5 cm of the projected point. Monocular depth cannot meet
   that reliably, so the camera app resamples the estimated depth to the captured frame
   and sets the per-frame `depthToleranceM` = `max(0.05, 0.08 * depth)`; the pipeline
   uses it when present (default 0.05 when absent, so the XR path is unchanged). The
   coverage number is then honest about what the estimator could confirm rather than
   silently zero.
4. **Pose uncertainty drives `trackingOk` and the quality watchdogs.**
   `RuntimeConditions.trackingOk = poseQuality.trackingOk`, which is false when the
   orientation sensor is stale (> 250 ms), when the optical-flow refiner reports motion
   the orientation source did not (a handheld camera being walked without a
   translation estimate), or when the video stalls. `FrameSample.registrationErrorM`
   carries `poseQuality.driftM`; the existing `QualityManager` degrades tiers on it and
   the region machine falls back on `tracking_lost`.
5. **Envelopes are small.** Objects captured through the camera backend get a
   viewpoint envelope of radius 0.5 m (static) or 1.0 m (orientation with visual
   refinement) around the capture position with `maxAngle` 0.6 rad, because we cannot
   verify parallax from where the camera never was.
6. **Diagnostics show the estimate, not the wish.** The camera diagnostics panel
   reports the pose mode, pose confidence, depth backend and inference time, depth
   age, floor confidence, and the tier cap in force.

## Model and library choices

| Need | Choice | Why | Sources |
|---|---|---|---|
| Monocular depth | Depth Anything V2 small (ViT-S, ~25 M params) via `@huggingface/transformers` `depth-estimation` pipeline, `device: 'webgpu'` with `wasm` fallback, in a Web Worker | Published ONNX weights (fp16 ~50 MB, q8/q4 smaller); real-time video demo in the transformers.js v3 repo; best accuracy/speed of the small monocular models. Its output is relative inverse depth (affine-invariant), so metric scale and shift are fitted per frame against the floor plane (pixels the floor estimate says are floor give known metric depth). The metric-indoor variant (`depth-anything-v2-metric-indoor-small`) is an alternative once its ONNX export is verified; it was not reachable at design time. | [onnx-community/depth-anything-v2-small](https://huggingface.co/onnx-community/depth-anything-v2-small), [transformers.js webgpu-video-depth-estimation example](https://github.com/huggingface/transformers.js/tree/v3/examples/webgpu-video-depth-estimation), [Xenova announcement (~50 MB fp16, real-time in browser)](https://x.com/xenovacom/status/1801672335830798654), [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) |
| Budget | 518x518 input is the model default; we run 252x252 (multiple of the 14 px patch) and target <= 200 ms on a laptop GPU, <= 1 s on WASM. Frames are dropped while one is in flight; the loop never waits. | | |
| Pose (phones) | `DeviceOrientationEvent` (`absolute` when available; iOS needs `requestPermission`) or `RelativeOrientationSensor`; complementary filter | Ubiquitous, zero cost, no model | MDN |
| Pose (visual) | In-house sparse Lucas-Kanade optical flow on the grabbed grayscale frame (<= 200 corners), estimating rotation drift and a motion magnitude; **not** full VO | Full monocular SLAM in the browser exists (AlvaAR: OV2SLAM/ORB-SLAM2 compiled to WebAssembly) but is a heavyweight, GPL-derived dependency with no sensor fusion; it is recorded as the upgrade path for phase 5 rather than adopted now. WebXR `immersive-ar` on Android Chrome is the *other* backend already (the WebXR path) and needs no camera code. | [AlvaAR](https://github.com/alanross/AlvaAR) |
| Planes | RANSAC on the metric depth point cloud (pure TS, unit-tested): floor first (normal within 15 degrees of +Y, largest support), then horizontal planes above it (tables), then vertical planes; volumes are connected components of depth above a support plane | Standard; no dependency | |
| Fake camera in tests | Chromium `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>.y4m` (+ `--use-fake-ui-for-media-stream`); Chrome only reads Y4M for this, so a small synthetic Y4M is generated at test time by `tests/e2e/y4m.ts` | Real `getUserMedia` code path exercised end to end without hardware | [Playwright issue 4532](https://github.com/microsoft/playwright/issues/4532), [fake video capture with Playwright](https://daviddalbusco.com/blog/fake-video-capture-with-playwright/) |

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| 1 | `camera.html` + `startCameraApp`: video passthrough, static/orientation pose, prior floor plane as a `Surface`, mouse/touch interaction, spawn/move/delete/undo of virtual objects resting on the floor, voice, diagnostics panel | tsc, vitest, vite build, Playwright `camera-*.spec.ts` green with the fake device; existing 206 unit + 29 e2e green |
| 2 | Depth: worker estimator, plane-prior fallback, metric fit against the floor, depth diagnostics; `CameraFrameSource.capture()` returns RGB-D | unit tests on synthetic depth maps (scale/shift fit, resampling) |
| 3 | Surfaces: RANSAC floor/table/vertical planes, `DetectedVolume`s from depth clusters -> discovery works on real scenes; floor height refinement | unit tests with synthetic point clouds; e2e discovery on the fake video |
| 4 | Capture + deletion: clean-plate capture through the camera source, tier caps, background hull over video, moved-object appearance | e2e: delete a discovered volume, hull draws, tier <= B |
| 5 | Pose tracking: optical-flow refinement, `trackingOk` from motion, quality watchdog wiring, envelope gating | unit tests on synthetic motion; e2e tracking-loss fallback |

## Test plan

- **Unit (vitest, node):** floor prior geometry (camera height/pitch -> plane, pixel ->
  floor point); pointer ray -> `InputState` mapping; plane drag maths; RANSAC on
  synthetic clouds with outliers; scale/shift fit of inverse depth against a known
  plane; depth resampling; tier cap logic; pose-quality -> `trackingOk` rules; y4m
  writer round-trip (header + frame size).
- **E2E (Playwright, Chromium with the fake device):** `camera.html?headless=1&
  source=camera&depth=prior` loads, `getUserMedia` resolves against the Y4M, the
  `<video>` plays, the app exposes `window.__realityEditor` and `window.__camera`;
  floor surface registered at y = 0; spawn a cube -> it rests on the floor; pointer
  drag moves it and the committed pose stays on the floor; delete/restore/undo;
  diagnostics panel shows pose mode and depth backend; later phases add discovery and
  deletion-with-hull scenarios. The XR suites keep their own port (5173/5175); this
  branch runs on 5177.
