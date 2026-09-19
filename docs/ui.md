# UI: HUD, hand menu, mic, landing page

Design goal: the interface should feel like an extension of the room, not a screen laid over
it. Concretely that means small, high-contrast text at the edge of the view, no large
translucent panels, and controls that live where a hand naturally is (the palm, the strip)
rather than floating in the middle of what you're looking at.

## In-XR HUD (`src/render/hud.ts`, `InXRHud`)

A single canvas-texture sprite, anchored to the camera every frame via `attachTo(camera)`,
bottom-centre of the view, `HUD_DISTANCE_M` (0.45m) away. Two densities:

- **`minimal`** (default): a compact strip, `HUD_WIDTH_M` x `HUD_HEIGHT_M` (0.22m x 0.05m),
  8px-rounded corners, ~30% opaque dark background (`rgba(10,10,14,0.30)`). One line:

  ```
  ⌂ T1 · 72fps · depth 12ms · live
  ```

  - Left end: a tiny room-mode glyph (a house outline), filled when `mode ===
    'captured-shell'`, outline-only for `'live-overlay'`.
  - The line itself: quality tier, fps (derived from `frameP95`), depth-sensing age, and a
    short mode word (`live`/`shell`).
  - Right end: reserved for the mic glyph - drawn by a separate mesh
    (`MicButton.attachTo(camera)` in `src/render/hand-menu.ts`), not the HUD canvas, so the
    strip leaves that area visually empty.
  - A second line appears **only** for 3 seconds when there's a rejection (red tint) or an
    active capture-guide hint (teal tint), then auto-hides (`REJECTION_DISPLAY_MS`). This
    reuses the same panel real estate rather than adding a second always-present line.
- **`full`** (`setDensity('full')`): the previous multi-line debug panel (tier/mode/frame
  p95/depth age/selected id/rejection/guide), unchanged in spirit from before this pass -
  for development use, not the default experience.

Redraws are throttled to 4Hz (`HUD_UPDATE_INTERVAL_MS`) and skipped entirely when nothing
meaningfully changed (`hudChanged`), matching the project's runtime-budget rule that HUD
text is diagnostic, not display-critical.

### Selected-object label

Instead of a `selected: <name>` line inside the strip, the selected object's name floats as
a small world-anchored billboard sprite (`InXRHud.label`) just above the object
(`position.y + 0.14`). It's allocation-free per frame (a single reused `THREE.Vector3`) and
only repaints its canvas texture when the name text itself changes.

**This needs one small change in `src/app/main.ts`** (not applied - main.ts is owned by
another agent; see the comment block at the top of `src/render/hud.ts` for the exact lines):

1. `scene.add(inXRHud.label);` next to the existing `scene.add(inXRHud.panel);`.
2. Two extra fields on the `HudStatus` object passed to `inXRHud.update(...)`:
   `selectedObjectName` and `selectedObjectPosition`, both optional, sourced from
   `snapshot.objects[interaction.selectedId]`.

Both fields are optional, so the app runs correctly without this change - the label simply
stays hidden and the strip works exactly as described above either way.

## Mic button (`src/render/hand-menu.ts`, `MicButton`)

A small circular glyph (a capsule + stand, not a text label) at the strip's right end.
Gray/translucent when idle, solid red with a brighter ring when listening
(`setListening(true)`). Its `attachTo(camera)` API is unchanged from before this pass (still
called once per frame by `src/app/voice-install.ts`, which has no reference to `InXRHud`) -
internally it now computes its offset from the HUD's own shared constants
(`HUD_WIDTH_M`/`HUD_VERTICAL_OFFSET_M`/`HUD_DISTANCE_M`, exported by `hud.ts`), so the two
modules land in the same place without needing to reference each other. No change to
`voice-install.ts` was needed.

## Hand menu (`src/render/hand-menu.ts`, `HandMenu`)

Palm-up menu on the left hand's wrist joint, visible only while the palm faces the head
(`dot(palmNormal, toHead) > 0.6`). Buttons share the HUD's font
(`system-ui`/`-apple-system`/`Segoe UI`), have rounded corners (10px radius), and are spaced
`GAP = 0.03m` apart (was 0.006m). Three visual states per button:

- **idle**: dark, translucent.
- **hover** (right index tip within 4cm, `HOVER_DIST_M`): highlighted blue.
- **pressed** (within 2cm, `PRESS_DIST_M`, or a pinch-ray hit): brighter blue, fires the
  action once on entry (not on every frame while held).

### A note on hand orientation in the simulator

The menu's own facing (the quads inherit `wristQuaternion` directly) and the palm-facing
gate (`palmNormal`, a separate cross-product computed from joint positions) are both
non-trivial functions of the hand root quaternion under IWER's `relaxedHandPose` - the rest
pose bakes a real rotation into the wrist joint, it isn't identity relative to the hand
root. `tests/e2e/screenshots.spec.ts`'s hand-menu screenshot picks a rotation (-66 degrees
about world +X) found by a short offline search that scores well on both constraints at
once; see `docs/testing.md`'s note on `07-hand-menu.png` for the numbers and the derivation
script's approach. This is purely a simulator/test concern - on real hand tracking the
joints (and therefore both `palmNormal` and `wristQuaternion`) come from the actual hand
pose, not a fixed rest-pose config.

## Landing page (`index.html`, `src/sim/entry.ts`'s non-headless landing card)

A single centred, dark card: product name, one-sentence description, a large "Enter AR"
button, a "what works on your device" list, and a link to the simulator (index.html only -
the simulator's own card links back to the main app instead).

- The capability list is fed by `getLandingDiagnosticLines()` (`src/render/diagnostics.ts`),
  a small async helper added alongside (not instead of) the existing `Diagnostics.getLines()`
  live-panel mirror. It reuses the same `buildLines()` formatting the full diagnostics panel
  uses, filled in with only what's answerable before a session exists
  (`navigator.xr` presence, `isSessionSupported('immersive-ar')`) - everything else renders
  the same "not started"/"—" placeholders `buildLines()` already shows pre-session. First 6
  lines are shown.
- "Enter AR" calls `AppHandle.enterAR()` directly - the same action
  `src/render/hud.ts`'s `DomHud` "Enter AR" button invokes (that button now carries
  `data-action="enter-ar"` as a stable hook, in case a future caller only has the DOM and
  not the `AppHandle`, e.g. `document.querySelector('#re-hud [data-action="enter-ar"]')
  .click()`). Both `index.html` and the simulator's landing card already hold the resolved
  `AppHandle` in the same script scope, so calling it directly is simpler than dispatching a
  synthetic click and has identical effect.
- No external assets, no icon fonts - a plain SVG-free glyph set drawn on `<canvas>` (HUD/
  mic/hand-menu) and system fonts everywhere.

## Summary of what changed and why

The pre-existing in-XR HUD was a ~55%-opaque, 0.3m x 0.15m multi-line panel with a text
`MIC` button floating independently in the middle-ish of the view - both readable in a
screenshot review as "big dark rectangle" and "floating button" respectively. This pass:

1. Replaced the panel with a thin instrument strip (minimal density by default, full density
   available for debugging via `setDensity('full')`).
2. Moved the mic into the strip as a small glyph, and gave the strip its own room-mode
   glyph at the opposite end.
3. Moved the selected-object name out of the strip and onto a world-anchored label over the
   object itself.
4. Gave the hand menu consistent styling, hover feedback, and correct spacing.
5. Added a landing page that explains the product and its device support before asking
   for an AR session, instead of dropping straight into a bare canvas + dev button bar.
