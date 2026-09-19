/**
 * Spawns a catalog asset (src/app/catalog.ts) into the scene store, mirroring
 * `spawnPrimitive` in src/app/main.ts but for gltf-backed catalog objects.
 *
 * Placement: 0.7 m in front of the head (head's forward direction, projected
 * onto the horizontal plane is *not* applied here - this follows the exact
 * head forward vector, same as `spawnPrimitive`), at head height minus 0.3 m.
 * That is deliberately below eye level and unsupported; proxy physics
 * (src/core/physics.ts via src/app/physics-bridge.ts) drops it the rest of
 * the way onto the nearest surface once its box proxy starts colliding, same
 * as any other non-kinematic spawned object - see STATE.md "Proxy physics
 * drops mid-air objects".
 */
import type { SceneStore } from '@/core/api';
import type { IntentSource, Pose, RuntimeConditions } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { add, quatRotateVec3, scale } from '@/core/math';
import { buildCatalogObject, findCatalogEntry, type CatalogEntry } from './catalog';

const FORWARD_DISTANCE_M = 0.7;
const HEIGHT_DROP_M = 0.3;

/**
 * Build and dispatch a `spawn` intent for `entry` in front of `headPose`.
 * Returns the new object's id, or `null` if the resolver rejected the spawn
 * (e.g. stale intent / tracking lost - `spawn` itself has no tier/approval
 * gate, so rejection here is rare but still possible per the resolver).
 */
export function spawnCatalogObject(
  store: SceneStore,
  entry: CatalogEntry,
  headPose: Pose,
  conditions: RuntimeConditions,
  source: IntentSource = 'voice',
): string | null {
  const forward = quatRotateVec3(headPose.rotation, { x: 0, y: 0, z: -1 });
  const position = add(headPose.position, scale(forward, FORWARD_DISTANCE_M));
  position.y = headPose.position.y - HEIGHT_DROP_M;

  const pose: Pose = {
    position,
    rotation: entry.uprightRotation ? { ...entry.uprightRotation } : { ...IDENTITY_QUAT },
  };

  const object = buildCatalogObject(entry, pose, undefined, conditions.now);
  const result = store.dispatch(
    { intent: { kind: 'spawn', object }, source, issuedAt: conditions.now, basedOnVersion: store.current.version },
    conditions,
  );
  return result.ok ? object.id : null;
}

/**
 * Convenience wrapper resolving a catalog entry by id/name first (see
 * `findCatalogEntry`); this is what `AppHandle.spawnAsset` (src/app/spawn.ts
 * consumer in src/app/main.ts) should call directly. Returns `null` when the
 * entry id is unrecognized or the spawn was rejected.
 */
export function spawnAsset(
  store: SceneStore,
  entryId: string,
  headPose: Pose,
  conditions: RuntimeConditions,
  source: IntentSource = 'voice',
): string | null {
  const entry = findCatalogEntry(entryId);
  if (!entry) return null;
  return spawnCatalogObject(store, entry, headPose, conditions, source);
}

export default spawnCatalogObject;
