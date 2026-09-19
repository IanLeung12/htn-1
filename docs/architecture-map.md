# Architecture to code map

Where each rule from the planning documents lives in the implementation.

| Canonical concept | Code | Enforced by |
|---|---|---|
| Product contract: display never waits on AI, capture, network | `src/app/main.ts` frame loop | no `await` in the loop; capture and pipeline run as async jobs; `perf.samples()[i].appMs` records loop CPU time |
| Two visual modes (live-overlay, captured-shell) | `SceneSnapshot.mode`, `src/render/shell.ts` | `setMode` intent; quality manager forces live-overlay when `allowCapturedShell` is false |
| Static-shell depth exclusion | `src/xr/depth.ts`, `src/render/shell.ts` | shell draws first (renderOrder 0) and claims depth; the depth-sensing mesh only wins when strictly nearer; objects draw last |
| Region state machine LIVE/CAPTURED/HYBRID/TRANSITION/FALLBACK | `src/core/regions.ts`, `src/app/regions.ts` | one region per surface; obstruction evidence from hands and head; `setRegionState` only on change |
| Dynamic reality priority (person > passthrough > shell > polish) | `src/core/regions.ts` | obstruction forces HYBRID then FALLBACK; evidence expires through TRANSITION |
| Object package | `EditableObject` in `src/core/types.ts` | built by `src/capture/discovery.ts`, refined by `plates.ts` and `verify.ts` |
| Background classification and provenance | `BackgroundPlate.provenance`, `version` | resolver refuses delete without observed evidence; `updateBackground` never downgrades provenance |
| Editability tiers A to E | `TIER_CAPABILITIES` in `src/core/types.ts` | `src/core/resolver.ts` checks every mutating intent |
| Viewpoint envelope | `ViewpointEnvelope`, `pointInEnvelope` in `src/core/math.ts` | resolver rejects `outside_envelope`; plate and hull renderers hide outside it |
| Capture workflow passes 0 to 3 | `runCandidateDiscovery`, `captureCleanPlate`, `src/app/guide.ts` | 4 capture viewpoints and 3 off-path verification viewpoints; simulator renders them, device guides the user |
| Interaction transaction | `src/app/interaction.ts` | hover, grab, per-frame `preview`, commit `move` at release, `clearPreview`; rejection explanation surfaced on HUD |
| Voice as convenience layer over the resolver | `src/app/voice-grammar.ts`, `src/app/voice.ts` | commands map to intents; Tier E deletion is explained, not forced |
| Physics uses proxies at fixed step | `src/core/physics.ts`, `src/app/physics-bridge.ts` | system-sourced moves never enter undo history |
| Quality tiers and watchdogs | `src/core/quality.ts` | fast degrade, slow recover with hysteresis; history logged with reasons |
| Freshness contract | `src/core/freshness.ts` | timestamped, versioned results; consumers never block |
| Persistence | `src/core/persistence.ts` | debounce with max wait; localStorage adapter |
| Feature negotiation on device | `src/xr/session.ts` | required `local-floor` only; everything else optional and reported |
| Feasibility gates | `tests/e2e/gate*.spec.ts` | run in the IWER simulator; device runs still required |
