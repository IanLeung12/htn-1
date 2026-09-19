/**
 * Refits an EditableObject's three proxies (interaction/collision/occlusion)
 * to a loaded model's actual bounding box. Catalog objects spawn with a
 * rough `approxHalfExtents` box (see src/app/catalog.ts) because the real
 * geometry loads asynchronously (src/render/objects.ts's GLTFLoader); once
 * the model is measured, this recomputes box proxies centered on the
 * bounds' local center so interaction/collision/occlusion always match what
 * is actually drawn (reality-editor-canonical-architecture.md: proxies make
 * physics cheap and must correspond to the visual asset, not a guess).
 *
 * Pure TypeScript - no DOM, no three.js: `bounds` is plain min/max data the
 * caller (src/render/objects.ts's onModelLoaded hook) computes from the
 * loaded THREE.Object3D via Box3.setFromObject().
 */
import type { Aabb, EditableObject, ProxyShape, Vec3 } from '@/core/types';

function halfExtentsFromBounds(bounds: Aabb): Vec3 {
  return {
    x: Math.max((bounds.max.x - bounds.min.x) / 2, 0.01),
    y: Math.max((bounds.max.y - bounds.min.y) / 2, 0.01),
    z: Math.max((bounds.max.z - bounds.min.z) / 2, 0.01),
  };
}

function boxProxy(halfExtents: Vec3): ProxyShape {
  return { kind: 'box', halfExtents: { ...halfExtents } };
}

/**
 * Returns a new EditableObject with interaction/collision/occlusion proxies
 * recomputed as box shapes sized from `bounds` (assumed local to the
 * object's own pose, i.e. already centered - the model's root is assumed to
 * sit at its own origin the way GLTFLoader delivers `gltf.scene`). Does not
 * mutate `object`.
 */
export function fitProxiesToBounds(object: EditableObject, bounds: Aabb): EditableObject {
  const halfExtents = halfExtentsFromBounds(bounds);
  const proxy = boxProxy(halfExtents);
  return {
    ...object,
    interactionProxy: proxy,
    collisionProxy: boxProxy(halfExtents),
    occlusionProxy: boxProxy(halfExtents),
  };
}

export default fitProxiesToBounds;
