# General-camera backend - state

Branch: `worktree-agent-a44ecaa8a93687167` (dev server + Playwright on port 5177 on this
branch only). Architecture: `docs/general-camera/architecture.md`.

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
- **World frame:** floor at y = 0, camera at (0, h, 0), -Z forward (same as XR
  `local-floor`), so `surfaceBelow`, physics, regions, and the guide overlay work as-is.
- **Pointer -> InputState.** Mouse/touch synthesize the right (and, for a second touch,
  left) `HandState` so `InteractionController` is reused unchanged; drags slide along the
  horizontal plane of the grab point (wheel lifts); the virtual hand's ray origin is pulled
  to within 1 m of the hit so the controller's 3 m hover reach applies to far objects.
- **Depth model:** Depth Anything V2 small via `@huggingface/transformers` in a Web
  Worker (WebGPU, WASM fallback), metric scale/shift fitted against the floor prior
  (`src/camera/depth/fit.ts`). Plane-prior analytic depth is the fallback and the e2e
  default (`?depth=prior`) so tests need no network/GPU.
- **Tier caps:** monocular depth caps clean plates at B unless multi-view agreement
  (>= 3 frames, > 15 degrees bearing spread, <= 8 cm RMS) passes; plane-prior depth caps
  at C (`src/camera/tier-cap.ts`).
- **Anchors:** `room-anchor` counts as localized whenever the pose source reports
  `trackingOk`, so spawned/discovered objects (which carry `anchorId: 'room-anchor'`) are
  editable; tracking loss pauses edits through the existing `anchor_lost`/`tracking_lost`
  resolver rules.
- **Fake camera in tests:** Chromium `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-video-capture` with a synthetic Y4M written by `tests/e2e/y4m.ts`
  at test time (Chrome only reads Y4M there).

## Status

| Phase | Item | Status |
|---|---|---|
| 1 | `camera.html` + `src/camera/entry.ts` landing card (height/FOV/file settings) | done |
| 1 | `MediaStreamFrameSource` / `VideoFileFrameSource` (`src/camera/frame-source.ts`) | done |
| 1 | `StaticPoseSource`, `OrientationPoseSource` (+ pure orientation math) | done, unit-tested |
| 1 | Floor prior surface + ray/plane helpers (`src/camera/surfaces/floor-prior.ts`) | done, unit-tested |
| 1 | `PointerInputAdapter` (drag on plane, wheel lift, second touch = left hand) | done, e2e-tested |
| 1 | `startCameraApp` wiring: store, regions, physics, voice, HUD, renderers, diagnostics | done |
| 1 | Camera diagnostics panel (`d` toggles) | done |
| 1 | Playwright `camera-phase1.spec.ts` (4 scenarios on the fake device) | green |
| 2 | Plane-prior depth estimator, `DepthEstimator.sample()` into `CameraFrame` | done |
| 2 | Model depth worker + metric fit (`src/camera/depth/{worker,model,fit}.ts`) | implemented; not yet exercised end to end (needs a GPU/network run); unit tests for the fit pending |
| 3 | RANSAC planes + volumes from depth | not started |
| 4 | Clean-plate capture through the camera with tier caps | wired (single viewpoint); e2e pending |
| 5 | Optical-flow pose refinement, `trackingOk` from motion | not started |

Checks on this branch: `npx tsc --noEmit` clean; `npx vitest run` 233 passed (206 existing +
27 new); `npx vite build` green; Playwright camera spec 4/4.

## Integration findings

- `getUserMedia` on the fake device reports 320x240 for a 320x240 Y4M; `video.paused`
  goes false only after `play()` resolves, so `FrameSource.ready` gates on
  `videoWidth > 0 && readyState >= 2 && !paused`.
- `#app` is `position: fixed` in the page CSS; setting `style.position = 'relative'`
  on it collapsed its height to 0 (the overlay canvas then had no pixels). The app only
  promotes a `static` container to `relative`.
- Floor surfaces carry a +-0.01 m aabb pad (same as XR plane surfaces), so physics
  settles a 0.08 m half-extent cube at y = 0.09, not 0.08.
- Spawning must not read the pointer's world point before any pointer event; the
  right hand must be `active`.

## Next steps

1. Unit tests for `fit.ts` (synthetic inverse depth from a known plane + outliers) and
   `tier-cap.ts` (bearing spread, agreement, caps).
2. Phase 3: RANSAC floor/table/vertical planes on the metric depth, volumes from
   above-plane clusters, replacing the floor prior when confident; refine camera height.
3. Phase 4: guided multi-shot capture UX for a handheld camera; background hull over
   video e2e (delete a discovered volume on the synthetic video).
4. Phase 5: optical-flow motion detector -> `trackingOk`, envelope gating; smoke-test the
   depth worker on a WebGPU machine and record latency in this file.
5. Manual test on a phone (orientation pose, touch two-finger scale/yaw) over HTTPS
   (`npm run dev:https`).
