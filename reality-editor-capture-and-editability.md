# Reality Editor — Capture Protocol and Editability Model

This document turns the background-reconstruction problem into a capture-time contract.
It complements Architecture Revision 4 and is planning only.

## Core decision

Do not promise that arbitrary captured objects can be deleted cleanly from a single room
scan. During setup, acquire a **clean plate** of the surfaces that the user wants to
edit. A clean plate is an observation of the background with the foreground object moved,
lifted, or viewed from another angle.

This is the most important quality lever for a mostly static room. It spends user time
once, when the system can ask for cooperation, to remove uncertainty from every later
real-time interaction.

## Why this beats a default generative fill

Object masks can identify which Gaussians or mesh faces belong to a mug. They cannot reveal
the table texture and geometry hidden behind the mug. A 2D fill can look acceptable from
one view while breaking under head parallax; a 3D fill can invent plausible but false
structure. InpaintFusion addresses this by fusing RGB-D inpainting into a global surfel
map, while newer 3D removal methods still treat multi-view consistency and hidden
geometry as explicit problems.

The product should use a hierarchy:

```text
observed clean plate
    > multi-view observed background
    > planar / constrained reconstruction
    > offline 3D inpainting with confidence label
    > live passthrough fallback
```

Generative completion remains valuable for optional visual polish, but it must never be
silently treated as observed reality.

## Guided setup sequence

### Pass 0 — room registration

Capture the room shell, floor, walls, major furniture, lighting appearance, and spatial
anchors. The output is useful for placement and visual registration, not yet a promise
that every object is editable.

### Pass 1 — candidate discovery

Detect candidate objects, surfaces, and object relationships. Ask the user to approve
objects by pointing, touching, or naming them. Do not make every detected object editable
by default.

For each approved object, show a simple editability preview:

- object boundary;
- estimated physical proxy;
- the surface likely to be exposed when moved;
- a coverage indicator;
- the maximum supported viewing range for the eventual edit.

### Pass 2 — clean-plate acquisition

For each approved object, guide the user through the least disruptive action that exposes
its background:

- lift a small object and hold it aside while the headset looks at the support surface;
- slide a movable object away from a wall or table region;
- walk around the object to observe the surface from multiple angles;
- temporarily remove a cluster of objects from one shelf or tabletop;
- mark a heavy or fixed object as non-deletable when its hidden background cannot be seen.

Use the live camera/depth stream to verify that the object is actually out of the way.
Capture background color, depth, normals/planes, camera poses, and visibility rather than
only a single screenshot.

The user should never be asked to clean the entire room unless the product explicitly
chooses a full-room archival workflow. Prefer small local clean plates around high-value
objects.

### Pass 3 — verification sweep

Return objects to their original positions and inspect the reconstructed result from the
head-motion envelope the product supports. The system should deliberately move the view
slightly off the capture path to expose holes, floaters, seams, and parallax failures.

Only after this sweep does an object become an `EDITABLE` record.

## Editability tiers

| Tier | Background evidence | Supported action | Runtime presentation |
|---|---|---|---|
| A — clean | Directly observed clean plate with good coverage | move, delete, restore, undo | captured background; normal object transform |
| B — multi-view | Not directly cleared, but observed from sufficient alternate views | move/delete within tested envelope | fused reconstruction; bounded confidence |
| C — constrained | Plane/surface model plus limited texture evidence | move with ghost/limited delete | planar patch or hybrid passthrough |
| D — speculative | Generative completion only | preview/experimental delete | clearly labeled transition or fallback |
| E — unavailable | Hidden surface never observed and unsafe to infer | move only if original hole remains, or no edit | live passthrough / object retained |

The interaction resolver checks the tier before committing an action. Voice commands such
as “delete the cabinet” cannot override a Tier E result; they can only produce an
explanation or offer a guided recapture.

## Object package produced by capture

```text
EditableObject
  identity
  semantic label and user-approved name
  original pose + nearby anchor
  visual representation(s)
  rigid/deformable interaction proxy
  collision proxy
  occlusion proxy
  support/contact surfaces
  original visibility mask
  clean-plate regions
  coverage mesh / visibility field
  reconstruction provenance
  quality tier and confidence
  supported viewpoint envelope
  fallback state
```

The coverage mesh is as important as the object mask. It says which newly exposed pixels
are observed, reconstructed, or unknown. It prevents the renderer from treating all empty
space after Gaussian removal as valid background.

## Runtime edit transaction

```text
select object
  -> check tier, anchor, tracking, and current physical scene
  -> preview object movement and exposed background
  -> enter TRANSITION state
  -> commit object transform + background region atomically
  -> render newest coherent snapshot
  -> monitor live reality for unexpected obstruction/change
  -> fallback or rollback if confidence drops
```

For a move, keep the original location’s background state coupled to the object’s motion.
Do not first move the visual object and only later discover that its old location has no
valid plate. For a delete, require a valid exposed region before hiding the object.

## Background update policy

Treat background reconstruction as a versioned asset, not mutable pixels:

- `observed_v1`: direct clean plate;
- `fused_v2`: additional views merged;
- `completed_v3`: offline completion, explicitly synthetic;
- `invalidated`: live scene changed or registration failed.

An offline job may improve an asset, but cannot silently downgrade its provenance. If a
new completion is worse under a particular view, the resolver can retain the previous
version or return to passthrough.

## Scope boundaries that protect real-time behavior

- Capture-time segmentation and reconstruction may take seconds or longer; runtime does
  not wait for them.
- Runtime only selects among pre-baked region assets and current scene states.
- PCA may validate a selected region, but the display loop uses the last valid snapshot.
- Physics uses compact proxies, never raw splat collision tests.
- Text-to-3D generation is an asset-authoring job; spawned objects must be cached and
  validated before becoming interactive.
- A large, fixed, flush-to-wall object is not automatically editable merely because a
  detector found it.

## Product language

Use “captured,” “reconstructed,” and “live” as real internal categories and expose a
simple version of them in the experience. Users will tolerate a short setup ritual and a
limited edit list more readily than they will tolerate a room that visibly lies about
what is behind a removed object.

## Evidence

- [InpaintFusion: Incremental RGB-D Inpainting for 3D Scenes](https://immersive-technology-lab.github.io/projects/inpaintfusion/index.html)
  demonstrates global RGB-D/surfel fusion for view-consistent 3D inpainting.
- [Clutter Detection and Removal in 3D Scenes with View-Consistent Inpainting](https://openaccess.thecvf.com/content/ICCV2023/papers/Wei_Clutter_Detection_and_Removal_in_3D_Scenes_with_View-Consistent_Inpainting_ICCV_2023_paper.pdf)
  frames object removal as a multi-view, RGB-D and geometry-completion problem rather
  than simple point deletion.
- [GPGS: Consistent 3D Object Removal](https://ojs.aaai.org/index.php/AAAI/article/view/37515)
  treats geometry-aware completion and multi-view consistency as separate requirements.
- [OVR-GS](https://www.mdpi.com/1424-8220/26/16/5258) shows a newer localized Gaussian
  completion direction, but remains evidence for an offline upgrade path, not a render-loop
  dependency.

## Decision

The capture experience should optimize for **a small set of highly reliable editable
objects**, not universal segmentation. Clean-plate acquisition is the preferred way to
make delete and move honest, fast, and view-consistent. The runtime should be boring:
choose a prepared representation, apply a transaction, render it, and fall back to live
reality whenever its evidence expires.
