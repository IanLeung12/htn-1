# Module ownership and interfaces

- `src/core/` pure TS. Contract: `src/core/types.ts`, API: `src/core/api.ts`. Tests: `tests/unit/`.
- `src/xr/` WebXR session, feature negotiation, input (hands/controllers), planes/meshes/anchors ingestion, depth.
- `src/render/` three.js renderer: passthrough-compatible scene, room shell tiles, object views, ghost previews, depth occlusion, background plates.
- `src/capture/` candidate discovery, clean-plate acquisition, object packages, tiers.
- `src/app/` `main.ts` implements `src/app/contract.ts` (startApp). `index.html` is the device page.
- `src/sim/` IWER + SEM + devui bootstrap. `sim.html` is the simulator page. Exposes `window.__sim`.
- `tests/e2e/` Playwright scenarios using the simulator.

Rules: no three.js or DOM in `src/core`. Renderer reads `store.current` once per frame. Nothing in the
frame loop awaits network, capture, or generation. Every fallback logs a reason.
