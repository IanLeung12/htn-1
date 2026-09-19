# Mapping the canonical architecture onto WebXR

The planning documents were written against Unity + Meta XR SDK. This project implements the
same architecture on the Quest 3 browser. This table records the mapping and the differences.

| Canonical concept | Unity / Meta SDK | WebXR equivalent used here | Notes |
|---|---|---|---|
| Compositor passthrough | OVRPassthroughLayer | `immersive-ar` session, `environmentBlendMode = alpha-blend`, renderer clears to alpha 0 | Passthrough is composited by the browser; the app cannot read it |
| Passthrough Camera API | PCA (v74+) | Not available in the Quest browser | On device, physical objects are Tier E. The simulator supplies a `CameraFrameSource` so the clean-plate pipeline is real code |
| Depth API / occlusion | OVR environment depth, DepthAPI shaders | `depth-sensing` feature, `gpu-optimized`, three.js `renderer.xr` depth mesh | 320x320 per eye; edge quality limited; treated as an untrusted signal with age tracking |
| Scene / MRUK | OVRSceneManager, MRUK anchors with labels | `plane-detection`, `mesh-detection` with `semanticLabel` | Labels: floor, ceiling, wall, table, desk, couch, shelf, bed, screen, lamp, plant, door, window, wall art, storage, global mesh |
| Spatial anchors | OVRSpatialAnchor | `anchors` (`frame.createAnchor`, persistent handles) | Keep anchors within 3 m of content |
| Hands | OVRHand / Interaction SDK | `hand-tracking`, `XRHand` joints | Pinch derived from thumb tip to index tip distance with hysteresis |
| Passthrough windows | OVRPassthroughLayer surface geometry | Any mesh drawn with alpha 0 and depth write | Region carve-outs are alpha holes |
| Runtime Optimizer targets | 14.2 ms | Same target for the quality manager | Emulator numbers are indicative only |
| App SpaceWarp | OVRManager ASW | Not available in WebXR | Baseline never depended on it |
| Foveation | OVRManager FFR | `renderer.xr.setFoveation()` | Fixed foveation only |

## What is real on device today

- Passthrough, hands, controllers, planes, meshes, anchors, hit test, depth occlusion.
- Spawned and imported objects with full editing (Tier A by construction).
- Physical objects as placement proxies (Tier E). They cannot be deleted because no background
  evidence can be gathered without camera access. The interaction resolver explains this to the
  user instead of lying.

## What the simulator adds

- A synthetic physical world from real Quest room captures (Meta IWER SEM).
- A camera frame source with colour and depth so guided clean-plate capture, coverage fields,
  provenance, and verification sweeps exercise the actual pipeline end to end.
- Programmatic head, hand, and controller control for Playwright scenarios.

If Meta ships WebXR raw camera access in the Quest browser, `src/app/main.ts` can plug it in as
a `CameraFrameSource` and physical objects graduate to Tiers A to C with no other changes.
