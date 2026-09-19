# Frame-loop allocation audit

Scope: `src/render/*.ts`, `src/xr/*.ts`, `src/app/interaction.ts` (per the runtime
budget's "avoid per-frame allocations and readbacks during interaction" rule and
architectural invariant 1, "no background job can block the display/render
clock" - the same logic applies to needless per-frame GC pressure on the main
thread that runs the render loop). `src/app/main.ts`, `src/core/*`,
`src/capture/*`, and `src/sim/*` were left untouched (owned elsewhere / out of
scope); behaviour is unchanged everywhere below - only allocation and
redundant-recompute patterns were fixed.

Regression guard: `tests/e2e/alloc.spec.ts` samples
`performance.memory.usedJSHeapSize` over 300 frames with 8 spawned objects
after a warm-up (Chromium-only, self-skips if the API is unavailable) and
asserts heap growth stays under a generous 2 MB bound.

## `src/render/objects.ts`

- **Before:** `updateHighlights()` ran every rendered frame (even when the
  scene snapshot version was unchanged) and, for every tracked object, called
  `Object3D.traverse()` with a fresh arrow-function closure and built a new
  `mats: THREE.MeshStandardMaterial[]` array - a closure + array allocation
  per object per frame, purely to find the same 1-2 materials every time.
  **After:** each `Entry` caches its flat `materials` list once, rebuilt only
  at construction and when an async glTF load swaps the solid's children.
  `updateHighlights()` now just iterates the cached array.
- **Before:** `updatePreview()` (called every frame while a grab preview is
  active) did `previewGroup.clear()` then allocated a brand-new
  `BufferGeometry` + `MeshStandardMaterial` + `Mesh` every single frame of the
  drag - and `Group.clear()` does not dispose GPU resources, so this was also
  a genuine leak (a fresh geometry/material orphaned every frame during every
  grab). **After:** the mesh is built once per preview target (keyed by
  `objectId`) and reused; only `position`/`quaternion` are touched per frame.
  The old mesh is explicitly disposed when the preview target changes or ends.

## `src/render/plates.ts`

- **Before:** `update()` ran a full `Object.values(snapshot.objects)` scan and
  allocated a new `Set<string>` on *every* rendered frame, regardless of
  whether the scene snapshot had changed, to figure out which plates are
  currently relevant. **After:** the object scan (and the `seen` `Set`) only
  runs when `snapshot.version` changes; the per-frame path just iterates a
  cached `activePlates` array to update envelope visibility against the
  (continuously-changing) head pose - the only thing that legitimately needs
  to be recomputed every frame.

## `src/render/shell.ts`

- **Before:** when `snapshot.version` was unchanged, `update()` still called
  `refreshVisibility()`, which iterated every tracked surface and called
  `regionForSurface()` - `Object.values(snapshot.regions)` - **per surface,
  per frame**, plus an unconditional `Group.remove()`/`Group.add()` pair per
  surface per frame. Regions live inside the versioned `SceneSnapshot` (see
  `src/core/types.ts`), so a region-state transition already bumps `version`
  like any other committed intent - there was nothing to refresh when the
  version hadn't moved. **After:** the redundant `refreshVisibility()` call
  (and method) was removed; visibility is only (re)placed inside
  `syncSurfaces()`, which is already version-gated.

## `src/xr/input.ts`

- **Before:** `update()` allocated a `['left', 'right'] as const` tuple and an
  arrow-function closure for `.forEach()` every single call (every XR frame).
  The per-hand joint loop did the same with `hand.forEach((jointSpace,
  jointName) => {...})` - a fresh closure per hand per frame, iterating up to
  25 hand joints - and two early-return paths did
  `track.visualGroup.children.forEach((c) => (c.visible = false))`, another
  closure allocation. **After:** the handedness tuple is hoisted to a
  module-level `HANDEDNESSES` constant and iterated with `for...of`; the joint
  loop uses `for (const [jointName, jointSpace] of hand)` (a `Map`, so
  `for...of` needs no closure); the two "hide all joints" call sites share a
  small non-closure `hideVisualGroup()` helper.

## `src/app/interaction.ts`

- **Before:** `update()` (called every frame) did
  `(['left', 'right'] as const).forEach((hand) => this.updateHand(...))` -
  the same tuple + closure allocation pattern as `input.ts`. **After:** hoisted
  to a module-level `HANDS` constant, iterated with `for...of`.

## `src/xr/depth.ts`

- **Before:** `getOcclusionMesh()` did
  `for (const mat of Array.isArray(material) ? material : [material])` every
  frame - when `material` is the (common) single-material case, `[material]`
  allocates a new one-element array every frame just to satisfy the
  `for...of`. **After:** an explicit `Array.isArray` branch with a plain
  `if`/`else` avoids the wrapper array.
- **Bug found while reviewing this file against three r186's
  `WebXRDepthSensing.js`:** the depth-sensing occlusion mesh is a full-screen
  quad whose vertex shader emits `gl_Position = vec4(position, 1.0)` directly
  (clip-space, ignoring the mesh's own transform - see
  `node_modules/three/src/renderers/webxr/WebXRDepthSensing.js`). Its
  `Object3D` sits at the identity transform (world origin), so three's default
  frustum-culling (which uses the object's world-space bounding sphere) is
  meaningless for it and can incorrectly cull the mesh once the viewer walks a
  few metres from the origin - exactly the "captured tile stays registered
  while walking" scenario in gate 2. Fixed by setting
  `mesh.frustumCulled = false` in `getOcclusionMesh()`.

## `src/xr/scene-understanding.ts`

- **Before:** change detection for every detected plane/mesh, on *every* XR
  frame, built a template-literal signature string via
  `${p.x.toFixed(3)},...}` (7 `toFixed()` calls + string concatenation) to
  compare against the previous signature - done specifically because some
  runtimes (the emulator included, per `STATE.md`) bump `lastChangedTime`
  every frame even when nothing moved, so this runs continuously for the
  lifetime of the session for every known surface. **After:** replaced the
  string signature with a numeric epsilon comparison against a cached
  `{px,py,pz,rx,ry,rz,rw,size}` struct (`poseSigChanged`), matching the same
  ~1 mm / 1e-3 rad granularity as the old `toFixed(3)` rounding but with zero
  string allocation on the (overwhelmingly common) "unchanged" path.
- **Before:** the global-mesh path (`handleMesh`'s `isGlobalMesh` branch)
  unconditionally pushed a fresh `{ id, pose, vertices, indices }` record
  (with a freshly-allocated `pose` object) every frame, even though the room
  mesh's pose/topology rarely changes once scanning settles. **After:** reuses
  the same `poseSigChanged` cache; the record is only rebuilt when the pose or
  vertex count actually changes.

## `src/render/hud.ts`

- **Before:** `InXRHud.update()` ran its dirty-check via
  `JSON.stringify([status, showRejection])` on *every* frame - serializing the
  whole status object (including nested `lastRejection`) to a string just to
  compare it to the previous draw - and `DomHud.update()` had no throttling or
  dirty-check at all, rebuilding a `lines` array + `.join('\n')` string and
  writing to `textContent` every single frame (up to ~90 Hz in-headset).
  HUD/diagnostic text is explicitly low-priority in the runtime budget's
  hierarchy (position 7, "decorative"/UI polish, well below head
  responsiveness). **After:** both HUDs throttle redraws to 4 Hz
  (`HUD_UPDATE_INTERVAL_MS = 250`) via a plain timestamp check, and `InXRHud`
  uses a field-by-field `hudChanged()` comparison (with frame-time/depth-age
  rounded to whole ms) instead of `JSON.stringify`.

## Not changed (reviewed, judged out of scope or acceptable)

- `src/render/shell.ts`'s `syncGlobalMeshes()` still allocates a `Set<string>`
  per frame; left as-is since the room typically has 0-1 global meshes and the
  removal-detection it performs needs a set either way - the cost is small and
  fixing it would require restructuring around array diffing for marginal
  gain.
- `src/xr/session.ts` and `src/app/main.ts` were not touched: `session.ts` has
  no per-frame code path, and `main.ts` is out of scope for this pass (owned
  elsewhere) even though it constructs `RuntimeConditions`/`FrameSample`
  object literals every frame - flagging it here for whoever next touches that
  file.
