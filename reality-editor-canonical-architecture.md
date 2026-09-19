# Reality Editor — Canonical Architecture

This is the current recommended architecture. Earlier Markdown files are research history
and rationale; when they conflict with this document, this document wins.

## Product contract

The experience is a live mixed-reality editor for a mostly static room:

- the physical world, hands, people, pets, and safety boundaries remain live;
- a short guided capture creates a spatially registered visual model of the room;
- a small, user-approved set of objects can be moved, deleted, restored, and replaced;
- physics uses simple, believable proxies;
- expensive reconstruction and generation happen before or after interaction;
- the display loop never waits for AI, PCA, network, inpainting, or asset generation.

The product does not promise arbitrary deletion of any object from any viewpoint. It
promises high-quality editing of objects whose background and interaction evidence pass
the capture contract.

## Two visual modes

The architecture supports both the practical baseline and the original high-impact
experience. They share the same scene store and object packages; only the visual resolver
changes.

### Live-overlay mode — default and fallback

Compositor passthrough fills the view. Captured room surfaces and edited objects are
rendered only in approved regions. This is the safest mode for setup, uncertain tracking,
low battery/thermal state, and any region where live dynamic reality cannot be separated
confidently.

### Captured-shell mode — the wow mode

A registered, baked room shell fills the virtual scene. Live passthrough remains beneath
it and is revealed where Depth API, tracked hand meshes, or a verified dynamic-reality
mask says that something physical must remain visible. The shell is not allowed to hide
people or hands merely because segmentation is late; it falls back locally to passthrough.

The shell must not use generic environment-depth occlusion blindly. The physical static
walls, floor, and furniture are the very surfaces the shell is replacing; allowing them
to occlude the shell can create z-fighting or unintended holes. The preferred policy is:

1. use the Scene/MRUK geometry to identify static shell surfaces;
2. exclude those static surfaces from the environment-depth occlusion mask where the
   captured shell is authoritative;
3. retain dynamic depth/hand occluders for people, hands, pets, and newly moved objects;
4. offset or transition shell surfaces where depth uncertainty remains;
5. fall back to Live-overlay mode if static/dynamic separation cannot be trusted.

This is a dedicated Captured-shell gate, not a shader detail. A room shell that flickers
against its physical counterpart is worse than a lower-fidelity live overlay.

Captured-shell mode is only enabled when the room shell’s registration, depth occlusion,
and dynamic-reality behavior pass the complete device test. It is a quality tier, not a
different data model. If the shell fails, the user falls back to Live-overlay mode
without losing object state.

This preserves the original goal—entering a photoreal captured version of one’s room—while
keeping a live-reality escape path everywhere the illusion becomes unsafe or visibly
wrong.

## Canonical stack

```text
                  USER / PHYSICAL WORLD
       hands, people, pets, furniture, safety boundaries
                              |
                  compositor passthrough authority
                              |
        +---------------------+---------------------+
        |                                           |
        live reality regions                         virtual regions
  unknown/dynamic/safety                  registered captured shell/mesh
                                        + promoted object packages
                                        + spawned assets
                                                |
                                   depth/occlusion + alpha windows
                                                |
                                      latest coherent snapshot
                                                |
                                            display

  ASYNC SUPPORTING SYSTEMS
  tracking / input -> intent -> transaction resolver -> scene store
  PCA RGB cameras -> CV / masks / lighting / change detection
  capture processing -> mesh / atlas / clean plates / visibility fields
  physics -> proxy state snapshots
  background jobs -> validated assets and versioned reconstructions
```

## Three image paths

1. **Compositor passthrough:** default live reality and safety authority.
2. **Passthrough Camera API:** Quest 3/3S camera data for CV/ML, lighting, and bounded
   local operations. It is asynchronous, permissioned, lower-FOV than the user view,
   and not the final stereo display path.
3. **App-rendered virtual content:** textured meshes, object assets, optional measured
   splat tiles, and UI.

PCA must not become a full-frame per-display rerender. If its frame is late or unavailable,
the runtime uses the last valid scene decision or returns the region to live passthrough.

## Representation choices

### Room

Use a baked, spatially tiled textured mesh as the standalone visual baseline for both
Live-overlay and Captured-shell modes. Use MRUK/Scene geometry as a separate low-
complexity collision and placement model. A splat tile may replace a mesh tile only after
a target-device benchmark proves visual benefit at the same thermal and frame-time budget.

The shell must be spatially partitioned so it can be carved into live regions. Do not
produce one monolithic opaque render with no region ownership or fallback boundary.

### Editable objects

Each object is a package, not merely a group of splats:

```text
identity and label
original/current pose and nearby anchor
visual asset: mesh/atlas, optional splat cluster
interaction proxy and collision proxy
occlusion/depth proxy
support/contact surfaces
background coverage field
capture provenance and quality tier
viewpoint envelope
physical parameters
fallback and undo state
```

Rigid objects use rigid transforms plus proxy geometry. Mesh-bound splats are optional for
deformable objects; they are not the room-wide default.

### Background

Every exposed region is classified as:

`observed clean plate → multi-view observed → constrained surface reconstruction →
synthetic completion → unavailable/live fallback`

The classification is stored with the asset and enforced by the interaction resolver.
Removing a foreground cluster never implies that valid background exists behind it.

## Capture workflow

1. Register the room shell, lighting appearance, and anchors.
2. Detect candidates and let the user approve editable objects.
3. Guide the user to lift, slide, or temporarily remove approved objects.
4. Capture clean plates of the exposed background and alternate viewpoints.
5. Build the visual mesh/atlas, object package, proxies, visibility field, and quality tier.
6. Return objects and run a verification sweep with deliberate off-path head motion.
7. Publish only objects whose asset package passes the required tier.

Prefer ten reliable objects over universal segmentation. Fixed or flush-to-wall objects
with no observed background should be placement-only or non-deletable.

## Runtime region state machine

Each region independently occupies one state:

```text
LIVE -> CAPTURED -> HYBRID -> TRANSITION -> FALLBACK
```

- `LIVE`: compositor passthrough is visible.
- `CAPTURED`: registered virtual region is trusted.
- `HYBRID`: virtual region with live passthrough windows/edge carve-outs.
- `TRANSITION`: preview, cross-fade, or reconstruction update.
- `FALLBACK`: restore live reality due to lost evidence or budget.

Dynamic reality has priority:

`verified hand/person/safety obstacle > live passthrough > captured room > polish`.

No stale mask may hide a person indefinitely. A watchdog can reduce quality but cannot
change committed physics semantics or lose undo history.

## Interaction transaction

```text
hand/controller/voice intent
  -> target resolver
  -> capability check: tier, coverage, anchor, tracking, physics
  -> ghost preview
  -> commit at physics boundary
  -> publish one coherent scene snapshot
  -> render
  -> monitor reality/depth/registration
  -> rollback or fallback if evidence expires
```

Voice is a convenience layer over the same deterministic resolver. An LLM may interpret
intent, but it cannot directly mutate transforms or bypass capability checks.

## Performance architecture

The target is sustained device performance, not average FPS. Measure p95/p99 frame time,
GPU/CPU, memory, thermal state, depth age, PCA frame age, registration error, and dropped
frame bursts with the complete feature set active.

Quality tiers:

1. **Safety:** live passthrough, tracking, hands, simple UI.
2. **Baseline:** live passthrough + textured room tiles + prepared object meshes.
3. **Enhanced:** measured local splats, soft occlusion, higher-quality assets.
4. **Tethered authoring/demo:** PC renderer and high-quality splats; not standalone proof.

The baseline must work without App SpaceWarp, full-room splats, maximum foveation, or
runtime generative models. Foveation and SpaceWarp are measured upgrades. SpaceWarp is
especially conditional because it requires correct motion vectors/depth and can artifact
with transparency, alpha clipping, disocclusion, and moving silhouettes.

## Visual calibration and lighting

The shell/live boundary is not only a geometry problem. Capture appearance and current
passthrough can differ in exposure, white balance, contrast, and shadows. Treat calibration
as a low-rate background service:

- record capture-time brightness/color metadata;
- estimate current brightness from PCA or platform signals without blocking rendering;
- apply a bounded color/exposure correction to the shell, never an uncontrolled full-frame
  filter that makes live reality look processed;
- use contact/blob shadows for spawned rigid objects before attempting expensive relighting;
- use MRUK/scene surfaces for shadow receivers and placement;
- smooth lighting changes and retain the last valid estimate when PCA is late.

Meta’s current Passthrough Relighting sample demonstrates supported highlight/shadow
effects over scene anchors. Use that as the first-party baseline for spawned content, but
keep shell calibration separate from physical-scene relighting: the captured room is a
baked appearance, while live people and hands are current camera imagery.

## Device policy

- Quest 3 is the reference target for the first serious benchmark.
- Quest 3S is conditionally supported: current Meta overview documentation lists it for
  Depth API, while a lower-level Unity page still says Quest 3 only. Perform runtime
  capability checks and pin the tested OS/SDK combination.
- No Quest 2 support for the core experience because depth/dynamic-reality behavior is
  insufficient for this product contract.
- PC/Link validates authoring and controlled demos only, never standalone performance.

## Feasibility gates

1. Passthrough + hands + safety fallback standalone.
2. One captured textured-mesh tile remains registered while walking.
3. One approved object gets clean mask, proxy, anchor, and coverage tier.
4. One clean-plate object moves and deletes across the tested viewpoint envelope.
5. A person crosses a local captured region without being hidden when confidence drops.
6. Static-shell depth masking prevents walls/furniture from flickering through the
   captured shell while dynamic people/hands remain visible.
7. The complete captured shell can locally reveal live people/hands without unacceptable
   seams, depth lag, or registration drift.
8. Five to ten objects pass sustained thermal and p95/p99 performance tests.
9. PCA improves a bounded operation without entering the display critical path.
10. Optional splat tile and SpaceWarp upgrades are each benchmarked independently.

If Gate 2 fails, become passthrough-first with virtual object assets. If Gate 3 fails,
reduce the editable set. If Gate 4 fails, keep move but disable delete for that object.
If Gate 5 fails, remove captured-room replacement from that region. If Gate 6 fails,
ship Live-overlay mode and keep Captured-shell mode as a controlled experiment. If Gate 7
fails, limit the shell to local surfaces or disable it.

## Explicitly out of scope for the core architecture

- full-frame PCA-to-display rerendering;
- per-frame neural inpainting;
- arbitrary object deletion without background evidence;
- raw Gaussian primitives as colliders;
- LLMs in the render or physics loop;
- surface-projected passthrough as a new foundation, since Meta marks the Unity APIs
  deprecated as of SDK v83;
- treating tethered RTX rendering as standalone evidence.

## Why this is the best current tradeoff

It preserves the project’s distinctive visual goal without betting on the least reliable
parts of the stack. The user sees a live world by default. Captured meshes supply stable,
fast visual richness, and Captured-shell mode can provide the full-room photoreal moment
when its occlusion gate passes. Clean plates make important edits truthful. Proxies make physics
cheap. PCA adds perception without controlling display timing. Splatting, SpaceWarp,
generative completion, and neural inpainting remain valuable upgrades that can be removed
without collapsing the product.

## Evidence

- [Meta Depth API overview](https://developers.meta.com/horizon/documentation/unity/unity-depthapi-overview/)
- [Meta Passthrough Camera API](https://developers.meta.com/horizon/documentation/unity/unity-pca-overview/)
- [Meta Passthrough Windows](https://developers.meta.com/horizon/documentation/unity/unity-customize-passthrough-passthrough-windows/)
- [Meta occlusion guidance](https://developers.meta.com/horizon/documentation/unity/unity-customize-passthrough-passthrough-occlusions/)
- [Meta advanced depth occlusion and depth masks](https://developers.meta.com/horizon/documentation/unity/unity-depthapi-occlusions-advanced-usage/)
- [Meta Runtime Optimizer](https://developers.meta.com/horizon/documentation/unity/unity-quest-runtime-optimizer/)
- [Meta App SpaceWarp](https://developers.meta.com/horizon/documentation/unity/unity-asw/)
- [Meta OpenXR settings](https://developers.meta.com/horizon/documentation/unity/unity-openxr-settings/)
- [Meta Passthrough Relighting](https://developers.meta.com/horizon/documentation/unity/unity-passthrough-relighting/)
- [InpaintFusion](https://immersive-technology-lab.github.io/projects/inpaintfusion/index.html)
- [VRSplat](https://arxiv.org/abs/2505.10144)
- [QuestRoomScan](https://github.com/arghyasur1991/QuestRoomScan)
