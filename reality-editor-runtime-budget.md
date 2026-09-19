# Reality Editor — Runtime Budget and Degradation Contract

Planning document for keeping the experience real-time while preserving live reality.
This is intentionally stricter than “the demo usually reaches 72 FPS.”

## Performance decision

The app must be designed to run acceptably without App SpaceWarp, without maximum
foveation, and without a full-room Gaussian-splat renderer. Those features may improve a
measured build, but they are not the foundation.

Meta’s current Runtime Optimizer uses approximately 14.2 ms as the target frame time for
VR applications (~70 FPS) and marks below 80% of that target as “good.” Use that as an
initial engineering reference, not as a guarantee for every display mode or headset.

The product’s acceptance metric is sustained p95/p99 frame behavior on the exact target
device, with live passthrough, hands, depth/occlusion, physics, and the largest supported
editable scene active together.

## Budget hierarchy

```text
1. XR tracking / compositor / live passthrough
2. safety and dynamic reality visibility
3. head pose responsiveness and stable presentation
4. interaction physics and grab feedback
5. editable object visual quality
6. room backdrop quality
7. lighting polish, generative refinement, decorative effects
```

When the budget is exceeded, degrade from the bottom upward. Never preserve a beautiful
captured room by sacrificing live-reality visibility or head responsiveness.

## Runtime clocks

| Clock | Responsibility | Rule |
|---|---|---|
| display/XR clock | pose, compositor, presentation | never wait for app jobs |
| render clock | current scene snapshot and visible virtual layers | render only committed state |
| physics clock | proxy colliders and object transforms | fixed step; publish coherent snapshots |
| hand/input clock | hand/controller pose and interaction state | preserve current grab briefly if tracking flickers |
| depth clock | environment depth and occlusion confidence | expose timestamp/age to resolver |
| PCA clock | RGB camera frames, CV, lighting, local validation | asynchronous; never direct display dependency |
| background clock | capture processing, asset baking, reconstruction | cancellable and versioned |

Every result carries a source timestamp, scene version, and confidence. A consumer may
use an older valid result; it may not combine results from incompatible scene versions.

## Render architecture

Use one straightforward forward/mobile path first. Keep render passes low and measurable;
Meta’s Quest guidance warns against excessive passes and recommends forward/Forward+ for
Quest-class applications.

### Standalone baseline

- opaque or alpha-clipped textured meshes for the room backdrop;
- compact authored meshes for editable objects and collision;
- environment depth only where its cost and edge quality justify it;
- tracked hand occluder meshes for hand boundaries where supported;
- no per-frame segmentation, inpainting, or neural rendering;
- no full-room high-density splat assumption;
- no transparent material dependency for core objects.

### Optional visual upgrades

- local splat tiles for objects/surfaces that pass a real device benchmark;
- higher-quality PC/tethered renderer for controlled demonstrations;
- offline inpainted background tiles with provenance;
- relighting and contact shadows after the core budget is green.

## Foveation policy

Foveation is a measured quality/performance tradeoff, not a universal switch.

- Start with Unity 6 SRP foveation for expensive geometry passes where it helps.
- Avoid applying foveation blindly to lightweight fullscreen/composite passes; Meta’s
  documentation says that can lose fast paths or provide no benefit.
- Validate the visible quality of captured texture boundaries and UI at every chosen level.
- Do not put critical seam edges or fine edit affordances where foveation makes them
  visibly unstable.
- Treat eye-tracked foveation as unavailable unless the target headset actually supports
  the required eye tracking.

Fixed foveated rendering can provide meaningful savings in pixel-intensive scenes, but
Meta also documents noticeable peripheral-quality loss at aggressive levels. The correct
setting is the highest quality that closes the measured budget, not the highest setting
that makes a screenshot look fast.

## App SpaceWarp policy

App SpaceWarp is a later optimization experiment, not an initial requirement.

It requires:

- Vulkan and the supported Unity/OpenXR path;
- correct motion vectors and depth;
- matching camera properties between the forward and motion-vector passes;
- compatible custom shaders;
- explicit handling for alpha-clipped and transparent materials;
- artifact testing during head motion, object grabs, and disocclusion.

The captured-room system is likely to contain splats, alpha blending, passthrough windows,
and moving object boundaries—the exact cases where SpaceWarp artifacts are costly. Keep
the baseline stable without it. Enable it per quality tier only when motion-vector
coverage and artifact acceptance are demonstrated.

## Quality tiers

### Tier 0 — safety fallback

Live passthrough, hands, simple UI, minimal virtual content. Used whenever the budget,
tracking, depth, or registration watchdog fails.

### Tier 1 — shipping standalone baseline

Live passthrough plus textured-mesh room regions, compact object assets, proxy physics,
and conservative occlusion. No full-room splat requirement.

### Tier 2 — enhanced standalone

Tier 1 plus measured local splat tiles, stronger texture resolution, and optional soft
occlusion. All dynamic-reality fallback rules remain active.

### Tier 3 — tethered/authoring demo

PC rendering, high-quality splats, offline/nearline reconstruction, and PCA-assisted
inspection. The tier is clearly labeled as tethered and does not clear standalone gates.

The runtime quality manager can move down tiers without restarting the scene. It must not
change object transforms or physics semantics while doing so.

## Watchdogs and degradation triggers

Trigger a lower tier or `LIVE` region fallback when any of these persists beyond a tested
threshold:

- frame time above the target percentile;
- GPU or CPU thermal throttling;
- depth timestamp too old for the occlusion policy;
- PCA frame age too high for the current mask;
- anchor not localized or registration error rising;
- background task queue causing allocation/memory pressure;
- dropped frames during a grab;
- dynamic person/hand confidence below the safety threshold;
- compositor or passthrough layer unavailable.

The threshold values must come from device traces, not arbitrary constants. Log every
degradation reason so a visually weaker frame can be diagnosed rather than mistaken for
random instability.

## Memory and asset policy

- Load the room as spatially streamable tiles, not one monolithic asset.
- Keep only nearby/high-confidence regions at their best quality.
- Store compact collision and occlusion geometry separately from visual assets.
- Use explicit budgets for texture atlas memory, mesh vertex/index memory, splat buffers,
  PCA camera buffers, and background reconstruction caches.
- Avoid per-frame allocations and readbacks during interaction.
- Keep multiple versions of a background asset only while a transaction needs them; then
  garbage-collect by policy, not opportunistically on the render thread.

## Measurement matrix

Every feature is tested in isolation and in the complete scenario:

| Scenario | Required observation |
|---|---|
| passthrough only | base head responsiveness and thermal baseline |
| room mesh only | visual-layer cost and registration stability |
| depth occlusion only | edge quality, latency, GPU cost |
| hands + object grab | input-to-motion latency and occlusion |
| PCA + detector | camera age, memory, CPU/GPU overhead |
| background transition | allocations, hitches, visual fallback |
| 5–10 edited objects | asset/physics scaling and memory |
| sustained five-minute session | p95/p99 frame time, thermal behavior, battery |
| failure injection | correct downgrade and recovery without restart |

Report median, p95, p99, worst burst, and thermal state. “Average FPS” is insufficient
because a short hitch while a person crosses the captured layer is a product failure even
if the average is excellent.

## Architectural invariants

1. No background job can block the display/render clock.
2. No stale result can hide verified live reality indefinitely.
3. Lowering visual quality cannot alter physical simulation semantics.
4. The app can return to Tier 0 without restarting or losing committed scene state.
5. A feature is not cleared by passing on PC, Link, or simulator only.
6. The primary visual baseline is valid without Gaussian splats or App SpaceWarp.
7. Every synthetic background records its provenance and supported viewpoint envelope.

## Evidence

- [Meta Quest Runtime Optimizer](https://developers.meta.com/horizon/documentation/unity/unity-quest-runtime-optimizer/)
  gives the current approximate 14.2 ms target and device-side bottleneck workflow.
- [Meta Unity rendering guidance](https://developers.meta.com/horizon/documentation/unity/unity-rendering/)
  covers phase sync, compositor layers, stereo rendering, and foveation.
- [Meta SRP/OpenXR settings](https://developers.meta.com/horizon/documentation/unity/unity-openxr-settings/)
  documents SRP foveation tradeoffs and depth-submission guidance.
- [Meta App SpaceWarp guide](https://developers.meta.com/horizon/documentation/unity/unity-asw/)
  documents Vulkan, motion-vector, depth, camera-matrix, and custom-shader requirements.
- [Meta App SpaceWarp sample](https://developers.meta.com/horizon/documentation/unity/unity-sample-app-spacewarp/)
  demonstrates disocclusion, silhouette, texture, and transparency artifacts.
- [Meta FFR guidance](https://developers.meta.com/horizon/documentation/unity/os-fixed-foveated-rendering/)
  documents performance gains and visible-quality tradeoffs.

## Decision

The system is real-time when it is allowed to be visually conservative. Use the live
world, compact meshes, prepared object packages, asynchronous PCA, and explicit quality
tiers as the product foundation. Add splats, SpaceWarp, higher-fidelity occlusion, and
generative completion only as independently measured upgrades that can be removed without
breaking the experience.
