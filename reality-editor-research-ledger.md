# Reality Editor — Research Ledger and Verification Contract

Canonical synthesis: `reality-editor-canonical-architecture.md`. This ledger preserves
evidence status and unresolved compatibility questions; it is not a competing design.

This is the evidence-oriented companion to `reality-editor-canonical-architecture.md`.
It records what is established, what is only plausible, and what must be measured before
the architecture is allowed to grow.

## Claim status

| Claim | Status | Evidence / consequence |
|---|---|---|
| Quest can present passthrough beneath virtual content | Established | Meta Passthrough API documentation. Use it as the base reality layer. |
| The app can freely sample the physical camera as an RGB texture | Qualified | Since Horizon OS v74, Passthrough Camera API exposes forward-facing Quest 3/3S camera streams for CV/ML, but with permissions, 20–40 ms capture latency, limited view coverage, and performance/privacy constraints. It is not equivalent to the compositor’s final view. |
| Quest 3 has environment depth support | Established | Meta Depth API documentation. Verify exact runtime/package version. |
| Quest 3S can be assumed to provide the same Depth API path | Qualified / version-sensitive | Meta’s newer 2026 Depth API Overview lists Quest 3 and Quest 3S, while the lower-level XR.Oculus Unity page still says Quest 3 only. Require a runtime support check and pin the tested Horizon OS/SDK combination. |
| Anchors should be within 3 m of the content they stabilize | Established | Meta’s current anchor best-practices documentation says pose error/drift is amplified beyond this range. Use local anchors and re-placement flows. |
| Scene mesh is suitable for fast collisions | Established | Meta MRUK/Scene docs. Use simplified meshes for collision, not visual fidelity. |
| Scene mesh provides proper dynamic-object occlusion | Rejected | Meta explicitly distinguishes collision support from proper occlusion and points to Depth API for dynamic objects. |
| Passthrough over Link is a viable development path | Established | Meta supports it for developers. |
| PC-over-Link performance proves standalone performance | Rejected | Meta warns that Link appearance/performance differ. Keep separate acceptance gates. |
| Surface-projected passthrough is a safe new-project dependency | Rejected | Meta marks the Unity integration deprecated as of SDK v83; use reconstructed passthrough or Passthrough Windows for new work. |
| Passthrough Windows provide physically correct arbitrary per-pixel replacement | Rejected | Windows control framebuffer alpha and their occlusion is based on window geometry depth, not necessarily the real depth of the live content seen through them. |
| Depth API gives perfect live occlusion | Rejected | Meta documents hard/soft edge instability, latency, and depth limitations; use it with explicit confidence and fallback states. |
| Generic environment depth can be applied unchanged in captured-shell mode | Rejected | The captured shell intentionally overlaps static physical surfaces; static geometry must be masked or separated from dynamic occlusion to avoid flicker and accidental passthrough holes. |
| 3DGS can be interactive in VR with physics | Research-established | VR-GS provides prior art with an embedding/cage approach. |
| Mesh-bound splats are a production-ready Unity/Quest primitive | Unverified | GS-Verse is research evidence, not an engine/platform guarantee. Treat as an optional experiment. |
| 3DGS can sustain a full standalone Quest 3 room at VR cadence | Unverified / currently unsupported by the strongest evidence | VRSplat reports 72+ FPS at Quest 3 resolution with an RTX 4090 tethered PC. Its result does not establish XR2 standalone performance. Make textured mesh the standalone baseline. |
| QuestRoomScan is a useful capture reference | Plausible, not independently validated here | Its public repository describes GPU TSDF/Surface Nets, RGB texturing, persistence, PCA access, and optional PC-trained splats. Audit licenses, versions, and performance before adopting. |
| A guided clean-plate pass can make delete/move substantially more reliable | Strong architectural inference | Multi-view RGB-D/3D-removal research treats hidden geometry and view consistency as explicit problems. Capturing the exposed surface directly is lower-risk than relying on synthetic completion. |
| App SpaceWarp should be a baseline dependency | Rejected | Meta requires correct motion/depth data and custom-shader support, and documents artifacts for disocclusion, silhouettes, textures, and transparency. Keep the standalone baseline valid without it. |
| Maximum foveation is always beneficial | Rejected | Meta documents quality loss and workload-dependent gains; use measured SRP/pass-specific foveation. |
| Average FPS is enough to validate the experience | Rejected | A live-reality product needs p95/p99 frame, depth age, and thermal measurements because short hitches at occlusion boundaries are perceptually severe. |
| Removing an object’s splats reveals its original background | Usually false | The hidden surface may never have been captured. Require coverage metadata. |
| Generative models can be in the frame loop | Architecturally wrong | Even if technically possible, it violates the latency and determinism requirement. Use offline/background jobs only. |

## Data freshness contract

Every subsystem publishes a timestamped, versioned result. Consumers use the newest result
that is internally coherent; they do not block for freshness.

| Subsystem | Suggested cadence | Can be stale? | Stale fallback |
|---|---:|---|---|
| Head pose / compositor | display cadence | No | XR runtime handles prediction/reprojection |
| Physics | fixed simulation step | Bounded only | Hold last valid state; never extrapolate without a defined policy |
| Scene snapshot | every committed transaction | Bounded | Continue rendering last committed snapshot |
| Hand pose | tracking cadence | Briefly | Keep grab state, fade interaction affordance |
| Environment depth | platform cadence | Briefly | Use last depth or disable dynamic occlusion |
| Lighting estimate | 5–15 Hz | Yes | Smooth last estimate; clamp changes |
| Live segmentation | feature-dependent | Yes | Keep current target or cancel interaction |
| Offline/background reconstruction | seconds/minutes | Yes | Show pending/unsupported state |
| Text-to-3D/network asset | seconds/minutes | Yes | Preloaded asset catalog / cancel request |

The scene renderer must never mix object transforms from different transaction versions in
one frame. A frame is allowed to use old data; it is not allowed to use contradictory data.

## Measurement protocol

Use a fixed test room, a fixed capture path, and a fixed five-minute scenario. Repeat each
test at least five times on a cold launch and once after thermal load. Store raw traces,
not just averages.

### Registration

- Walk a loop around the room and revisit the start point.
- Measure captured-layer alignment against stable physical edges at near, middle, and far
  distances.
- Record relocalization time after briefly covering the headset cameras.
- Fail if the product silently shows a registered capture outside its measured validity.

### Human/passthrough seam

- Move both hands across captured surfaces at varied depths.
- Have a second person enter, cross behind an edited object, and leave.
- Test a pet-sized or low object only if it is in scope.
- Evaluate both the visual seam and whether the compositor path actually supports the
  intended mask/depth relationship on the target device.

### Object authoring

- Select a high-contrast object, a textureless object, and an object touching another one.
- Record mask quality, collision proxy quality, background coverage, anchor localization,
  and time from capture completion to editable state.
- The touching-object case is mandatory; isolated-object segmentation is misleading.

### Interaction

- Grab, translate, rotate, release, collide, delete, undo, and relocalize.
- Repeat while the background task is producing a result.
- Confirm that late results cannot overwrite a newer committed transaction.

### Performance

Record p50/p95/p99 and maximum values for render, physics, tracking-to-state, state-to-
display, memory, thermal temperature, and dropped frames. Benchmark each layer alone,
then the complete stack. A subsystem that passes alone but fails in combination is not
cleared.

## Go / no-go gates

### Gate A — standalone reality

Go only if passthrough, hands, tracking, and safety fallback remain usable for the whole
scenario on the exact target headset.

### Gate B — captured layer

Go only if registration is stable enough that users do not interpret the capture as a
second misaligned room. Otherwise reduce the replacement region or make the product fully
passthrough-first.

### Gate C — editable object

Go only if one touching-object test passes with an explicit background-coverage result.
If not, constrain editing to pre-authored assets or isolated objects.

### Gate D — truthful delete

Go only if deletion remains plausible across the supported head-motion envelope. If a
viewpoint reveals missing background, the system must fall back visibly and intentionally.

### Gate E — sustained runtime

Go only if the complete stack meets the chosen display cadence and thermal envelope for
the full scenario. App SpaceWarp may be tested as an optimization, but it cannot be the
only reason the budget closes until its required motion/depth/material work is verified.

## Research that is intentionally deferred

- Full neural video inpainting: not compatible with the current product truth model until
  a compositor-accessible and temporally stable path is demonstrated.
- Runtime open-vocabulary segmentation: unnecessary for the first version; capture-time
  approval is more predictable.
- LLM voice interpretation: interaction grammar can be deterministic first.
- Deformable splat binding: valuable only after rigid object editing proves the product.
- Multiplayer/shared anchors: no evidence that collaboration is required for the core
  promise; avoid adding network state before local persistence is stable.
- High-quality relighting: first use stable material/light approximations and contact
  shadows; only investigate learned environment maps if the seam gate identifies lighting
  as the dominant failure.

## Source list

- [Meta Passthrough API overview](https://developers.meta.com/horizon/documentation/unity/unity-passthrough/)
- [Meta Passthrough over Link](https://developers.meta.com/horizon/documentation/unity/unity-passthrough-use-over-link/)
- [Meta Depth API in Unity](https://developers.meta.com/horizon/documentation/unity/unity-depthapi-xr-oculus/)
- [Meta Scene guidance](https://developers.meta.com/horizon/design/mr-health-scene/)
- [Meta MRUK sample overview](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-sample-mruk/)
- [Meta spatial-anchor best practices](https://developers.meta.com/horizon/documentation/unity/unity-spatial-anchors-best-practices/)
- [Meta Application SpaceWarp guide](https://developers.meta.com/horizon/documentation/unity/unity-asw/)
- [VR-GS paper](https://arxiv.org/abs/2401.16663)
- [GS-Verse paper](https://arxiv.org/abs/2510.11878)

## Planning conclusion

The architecture is ready for prototyping only after the three highest-risk questions
are made empirical: can the captured layer stay registered, can the target compositor
produce the intended live/captured seam, and can one touching object be separated with a
known background result. Until those are answered, additional models and interaction
features add confidence theater rather than architecture.
