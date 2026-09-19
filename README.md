# Reality Editor

A live mixed-reality editor for a mostly static room, built for the Meta Quest 3 browser
(WebXR `immersive-ar`). The physical world, hands, and people stay live through passthrough.
A short guided capture registers the room and a small set of user-approved objects, which can
then be moved, deleted, restored, replaced, and undone with believable proxy physics. The
display loop never waits on capture, AI, or network work.

Architecture and product rules live in the `reality-editor-*.md` documents. `STATE.md` tracks
current status and decisions.

## What works today (simulator verified)

- Passthrough session with hands, controllers, planes, meshes, anchors, and depth occlusion.
- Candidate discovery from scene volumes; guided multi-viewpoint clean-plate capture; tiers A to E.
- Move, delete, restore, undo, redo through one deterministic resolver with envelope and tier checks.
- Proxy physics: released objects settle onto tables and floors and push each other apart.
- Voice commands ("delete the lamp", "move the cube up 20 cm", "what can I edit") and a palm menu.
- Region state machine that reveals live reality when a hand or person crosses a captured region.
- Deleting a physical object reprojects the clean-plate RGB-D frames into its silhouette, so it
  reads as gone from any angle inside the verified envelope; moving one carries its captured look.
- Two-hand move, yaw, and tier-gated scale; spawnable glTF catalog with proxies fitted on load.
- Quality watchdogs, on-device diagnostics, persistent room anchor, persistence across reloads.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173/           device page (Quest browser)
                     # http://localhost:5173/sim.html   desktop simulator (IWER emulator)
                     # http://localhost:5173/camera.html any camera: webcam, phone, USB, or a video file
npm test             # unit tests (core, capture)
npm run test:e2e     # Playwright scenarios driving the simulator headlessly
npm run check        # typecheck + unit tests + production build
```

To run on a Quest 3, serve over HTTPS (or use `adb reverse tcp:5173 tcp:5173` and open
`http://localhost:5173/` in the headset browser) and press Enter AR.

## Any camera (no headset)

`camera.html` runs the same editor on a laptop/phone webcam, a USB camera, or a recorded
video: the video is the passthrough, depth comes from a monocular model (Depth Anything V2
small in a Web Worker) with an analytic floor-plane fallback, the camera pose comes from
device orientation or a static tripod setting, and the mouse/finger replaces hands. Estimated
depth and pose are confidence-tagged and cap editability tiers (see
`docs/general-camera/architecture.md`). Query params: `?pose=static|orientation|visual`,
`?depth=auto|model|prior|none`, `?height=<m>`, `?pitch=<deg>`, `?fov=<deg>`, `?url=<video>`.

## Layout

| Path | Role |
|---|---|
| `src/core/` | Pure TypeScript: versioned scene store, transaction resolver, region state machine, quality manager, perf tracker, persistence |
| `src/xr/` | WebXR session, feature negotiation, hands/controllers, plane and mesh ingestion, anchors, environment depth |
| `src/render/` | three.js views: object views, background plates, room shell tiles, occlusion, HUD |
| `src/capture/` | Candidate discovery, clean-plate acquisition, verification sweep, editability tiers |
| `src/app/` | `startApp()` wiring and the interaction transaction |
| `src/sim/` | Headset simulator built on Meta IWER + synthetic environment module |
| `src/camera/` | General-camera backend: frame sources, pose sources, depth estimators, surface estimation, pointer input, `startCameraApp()` |
| `tests/unit/` | vitest |
| `tests/e2e/` | Playwright + IWER scenarios mapped to the feasibility gates |

See `docs/architecture-map.md`, `docs/module-ownership.md`, `docs/webxr-mapping.md`, `docs/testing.md`, `docs/device.md`, and `docs/perf-audit.md`.
