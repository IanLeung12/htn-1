/**
 * Pure transaction resolver: given a snapshot, an intent envelope, and the
 * current runtime conditions, decide whether the intent may commit and
 * produce the next (structurally new) snapshot. Never mutates its inputs.
 */
import {
  TIER_CAPABILITIES,
  type BackgroundPlate,
  type BackgroundProvenance,
  type EditAction,
  type EditableObject,
  type Intent,
  type IntentEnvelope,
  type Region,
  type RejectReason,
  type ResolveResult,
  type RuntimeConditions,
  type SceneSnapshot,
} from './types';
import type { TransactionResolver } from './api';
import { pointInEnvelope } from './math';

export interface ResolverOptions {
  maxVersionLag?: number;
  minDeleteCoverage?: number;
  minMoveCoverage?: number;
}

// Higher rank = better evidence. Never let updateBackground silently
// downgrade a plate's provenance (reality-editor-capture-and-editability.md).
const PROVENANCE_RANK: Record<BackgroundProvenance, number> = {
  observed_clean_plate: 4,
  multi_view_observed: 3,
  constrained_surface: 2,
  synthetic_completion: 1,
  unavailable: 0,
};

const MUTATION_ACTIONS = new Set<Intent['kind']>(['move', 'rotate', 'scale', 'delete', 'replace', 'spawn']);

const OBJECT_ID_KINDS = new Set<Intent['kind']>([
  'move', 'rotate', 'scale', 'delete', 'restore', 'replace', 'approve', 'setTier', 'updateBackground', 'preview',
]);

const APPROVAL_REQUIRED_KINDS = new Set<Intent['kind']>(['move', 'rotate', 'scale', 'delete', 'replace']);

const ANCHOR_CHECK_KINDS = new Set<Intent['kind']>(['move', 'rotate', 'scale', 'delete']);

function intentObjectId(intent: Intent): string | undefined {
  switch (intent.kind) {
    case 'move':
    case 'rotate':
    case 'scale':
    case 'delete':
    case 'restore':
    case 'replace':
    case 'approve':
    case 'setTier':
    case 'updateBackground':
    case 'preview':
      return intent.objectId;
    default:
      return undefined;
  }
}

function tierActionFor(kind: Intent['kind']): EditAction | undefined {
  switch (kind) {
    case 'move': return 'move';
    case 'rotate': return 'rotate';
    case 'scale': return 'scale';
    case 'delete': return 'delete';
    case 'restore': return 'restore';
    case 'replace': return 'replace';
    default: return undefined;
  }
}

function explain(objectName: string, tier: string, verb: string): string {
  return `Cannot ${verb} '${objectName}': its background was never observed (tier ${tier}). Try a guided recapture.`;
}

function findPlateFor(
  object: EditableObject,
  headPose: RuntimeConditions['headPose'],
  minCoverage: number,
): { ok: true } | { ok: false; reason: 'no_background_evidence' | 'outside_envelope' } {
  const candidates = object.background.filter(
    (p) => p.provenance !== 'unavailable' && p.coverage >= minCoverage && p.version !== 'invalidated',
  );
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_background_evidence' };
  }
  const inEnvelope = candidates.some((p: BackgroundPlate) => pointInEnvelope(headPose, p.envelope));
  if (!inEnvelope) {
    return { ok: false, reason: 'outside_envelope' };
  }
  return { ok: true };
}

function regionInFallbackAt(snapshot: SceneSnapshot, position: EditableObject['currentPose']['position']): Region | undefined {
  return Object.values(snapshot.regions).find((r) => {
    if (r.state !== 'FALLBACK') return false;
    const { min, max } = r.bounds;
    return (
      position.x >= min.x && position.x <= max.x &&
      position.y >= min.y && position.y <= max.y &&
      position.z >= min.z && position.z <= max.z
    );
  });
}

function cloneSnapshotWithObject(snapshot: SceneSnapshot, id: string, updater: (obj: EditableObject) => EditableObject): SceneSnapshot {
  const existing = snapshot.objects[id] as EditableObject;
  return {
    ...snapshot,
    objects: { ...snapshot.objects, [id]: updater(existing) },
  };
}

export function createResolver(opts?: ResolverOptions): TransactionResolver {
  const maxVersionLag = opts?.maxVersionLag ?? 3;
  const minDeleteCoverage = opts?.minDeleteCoverage ?? 0.6;
  const minMoveCoverage = opts?.minMoveCoverage ?? 0.4;

  function reject(intent: Intent, reason: RejectReason, explanation: string): ResolveResult {
    return { ok: false, reason, explanation, intent };
  }

  function resolve(snapshot: SceneSnapshot, envelope: IntentEnvelope, conditions: RuntimeConditions): ResolveResult {
    const { intent, source } = envelope;

    // undo/redo are handled by the store before it ever calls the resolver.
    if (intent.kind === 'undo' || intent.kind === 'redo') {
      return reject(intent, 'invalid', 'Undo/redo must be handled by the scene store, not the resolver.');
    }

    // --- stale intent -------------------------------------------------
    const staleExempt = intent.kind === 'clearPreview' || source === 'system';
    if (!staleExempt && envelope.basedOnVersion < snapshot.version - maxVersionLag) {
      return reject(
        intent,
        'stale_intent',
        `This action was decided against an out-of-date view of the scene (v${envelope.basedOnVersion} vs v${snapshot.version}). Please retry.`,
      );
    }

    // --- unknown object -------------------------------------------------
    const objectId = intentObjectId(intent);
    let object: EditableObject | undefined;
    if (objectId !== undefined) {
      object = snapshot.objects[objectId];
      if (!object) {
        return reject(intent, 'unknown_object', `No object with id '${objectId}' exists in the current scene.`);
      }
    }

    // --- tracking ---------------------------------------------------------
    if (!conditions.trackingOk && MUTATION_ACTIONS.has(intent.kind)) {
      return reject(intent, 'tracking_lost', 'Head/controller tracking is currently lost; edits are paused until it recovers.');
    }

    // --- approval -----------------------------------------------------
    if (object && APPROVAL_REQUIRED_KINDS.has(intent.kind) && !object.approved) {
      return reject(intent, 'not_approved', `'${object.userName}' has not been approved for editing yet.`);
    }

    // --- tier capability ------------------------------------------------
    if (object) {
      const action = tierActionFor(intent.kind);
      if (action && !TIER_CAPABILITIES[object.tier].has(action)) {
        return reject(
          intent,
          'tier_forbids',
          explain(object.userName, object.tier, action),
        );
      }
    }

    // --- anchor -----------------------------------------------------------
    if (object && ANCHOR_CHECK_KINDS.has(intent.kind) && object.anchorId && !conditions.localizedAnchors.has(object.anchorId)) {
      return reject(intent, 'anchor_lost', `'${object.userName}' is anchored to '${object.anchorId}', which is not currently localized.`);
    }

    // --- region fallback ----------------------------------------------
    if (object && (intent.kind === 'move' || intent.kind === 'delete')) {
      const fallbackRegion = regionInFallbackAt(snapshot, object.currentPose.position);
      if (fallbackRegion) {
        return reject(
          intent,
          'region_fallback',
          `The region around '${object.userName}' has fallen back to live passthrough and cannot accept edits right now.`,
        );
      }
    }

    // --- delete-specific plate/envelope checks --------------------------
    // Only physical objects reveal a background when hidden; spawned/imported
    // objects can always be deleted (their tier still gates via TIER_CAPABILITIES).
    if (intent.kind === 'delete' && object && object.origin === 'physical') {
      const plateCheck = findPlateFor(object, conditions.headPose, minDeleteCoverage);
      if (!plateCheck.ok) {
        if (plateCheck.reason === 'no_background_evidence') {
          return reject(
            intent,
            'no_background_evidence',
            `Cannot delete '${object.userName}': its background was never observed with enough coverage. Try a guided recapture.`,
          );
        }
        return reject(
          intent,
          'outside_envelope',
          `Cannot delete '${object.userName}' from this viewpoint: move back within its verified viewing range.`,
        );
      }
    }

    // --- move-specific plate check (physical objects, tier A/B/C only) --
    if (intent.kind === 'move' && object) {
      const needsPlate = object.origin === 'physical' && (object.tier === 'A' || object.tier === 'B' || object.tier === 'C');
      if (needsPlate) {
        const plateCheck = findPlateFor(object, conditions.headPose, minMoveCoverage);
        if (!plateCheck.ok) {
          if (plateCheck.reason === 'no_background_evidence') {
            return reject(
              intent,
              'no_background_evidence',
              `Cannot move '${object.userName}': the surface behind it was never observed with enough coverage. Try a guided recapture.`,
            );
          }
          return reject(
            intent,
            'outside_envelope',
            `Cannot move '${object.userName}' from this viewpoint: move back within its verified viewing range.`,
          );
        }
      }
    }

    // --- apply ------------------------------------------------------------
    return apply(snapshot, envelope, conditions);
  }

  function apply(snapshot: SceneSnapshot, envelope: IntentEnvelope, conditions: RuntimeConditions): ResolveResult {
    const { intent } = envelope;
    const version = snapshot.version + 1;
    const committedAt = conditions.now;

    switch (intent.kind) {
      case 'move': {
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({ ...o, currentPose: intent.pose }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'rotate': {
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({
          ...o,
          currentPose: { ...o.currentPose, rotation: intent.rotation },
        }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'scale': {
        const factor = intent.factor;
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({
          ...o,
          interactionProxy: scaleProxy(o.interactionProxy, factor),
          collisionProxy: scaleProxy(o.collisionProxy, factor),
          occlusionProxy: scaleProxy(o.occlusionProxy, factor),
        }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'delete': {
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({ ...o, visible: false }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'restore': {
        const existing = snapshot.objects[intent.objectId];
        if (!existing) return reject(intent, 'unknown_object', `No object with id '${intent.objectId}' exists.`);
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({
          ...o,
          visible: true,
          currentPose: o.originalPose,
        }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'replace': {
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({
          ...o,
          visual: intent.asset,
          replacedBy: intent.asset.url ?? 'primitive',
        }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'spawn': {
        const obj: EditableObject = { ...intent.object, approved: true, origin: intent.object.origin ?? 'spawned' };
        return {
          ok: true,
          snapshot: { ...snapshot, objects: { ...snapshot.objects, [obj.id]: obj }, version, committedAt },
          applied: intent,
        };
      }
      case 'approve': {
        const existing = snapshot.objects[intent.objectId];
        if (!existing) return reject(intent, 'unknown_object', `No object with id '${intent.objectId}' exists.`);
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({ ...o, approved: intent.approved }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'setMode': {
        return { ok: true, snapshot: { ...snapshot, mode: intent.mode, version, committedAt }, applied: intent };
      }
      case 'setRegionState': {
        const region = snapshot.regions[intent.regionId];
        if (!region) return reject(intent, 'invalid', `No region with id '${intent.regionId}' exists.`);
        const nextRegion: Region = { ...region, state: intent.state, reason: intent.reason, since: conditions.now };
        return {
          ok: true,
          snapshot: { ...snapshot, regions: { ...snapshot.regions, [intent.regionId]: nextRegion }, version, committedAt },
          applied: intent,
        };
      }
      case 'registerSurface': {
        return {
          ok: true,
          snapshot: {
            ...snapshot,
            surfaces: { ...snapshot.surfaces, [intent.surface.id]: intent.surface },
            version,
            committedAt,
          },
          applied: intent,
        };
      }
      case 'removeSurface': {
        const surfaces = { ...snapshot.surfaces };
        delete surfaces[intent.surfaceId];
        return { ok: true, snapshot: { ...snapshot, surfaces, version, committedAt }, applied: intent };
      }
      case 'registerRegion': {
        return {
          ok: true,
          snapshot: {
            ...snapshot,
            regions: { ...snapshot.regions, [intent.region.id]: intent.region },
            version,
            committedAt,
          },
          applied: intent,
        };
      }
      case 'removeRegion': {
        const regions = { ...snapshot.regions };
        delete regions[intent.regionId];
        return { ok: true, snapshot: { ...snapshot, regions, version, committedAt }, applied: intent };
      }
      case 'registerObject': {
        const obj: EditableObject = { ...intent.object, approved: intent.object.approved ?? false };
        return {
          ok: true,
          snapshot: { ...snapshot, objects: { ...snapshot.objects, [obj.id]: obj }, version, committedAt },
          applied: intent,
        };
      }
      case 'updateBackground': {
        const existing = snapshot.objects[intent.objectId];
        if (!existing) return reject(intent, 'unknown_object', `No object with id '${intent.objectId}' exists.`);
        const priorPlate = existing.background.find((p) => p.id === intent.plate.id);
        if (priorPlate && PROVENANCE_RANK[intent.plate.provenance] < PROVENANCE_RANK[priorPlate.provenance]) {
          return reject(
            intent,
            'invalid',
            `Refusing to downgrade background evidence for plate '${intent.plate.id}' from ${priorPlate.provenance} to ${intent.plate.provenance}.`,
          );
        }
        const background = priorPlate
          ? existing.background.map((p) => (p.id === intent.plate.id ? intent.plate : p))
          : [...existing.background, intent.plate];
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({ ...o, background }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'setTier': {
        const existing = snapshot.objects[intent.objectId];
        if (!existing) return reject(intent, 'unknown_object', `No object with id '${intent.objectId}' exists.`);
        const next = cloneSnapshotWithObject(snapshot, intent.objectId, (o) => ({
          ...o,
          tier: intent.tier,
          tierConfidence: intent.confidence,
        }));
        return { ok: true, snapshot: { ...next, version, committedAt }, applied: intent };
      }
      case 'preview': {
        const existing = snapshot.objects[intent.objectId];
        if (!existing) return reject(intent, 'unknown_object', `No object with id '${intent.objectId}' exists.`);
        return {
          ok: true,
          snapshot: {
            ...snapshot,
            preview: { objectId: intent.objectId, pose: intent.pose, action: intent.action },
            version,
            committedAt,
          },
          applied: intent,
        };
      }
      case 'clearPreview': {
        const { preview: _drop, ...rest } = snapshot;
        return { ok: true, snapshot: { ...rest, version, committedAt }, applied: intent };
      }
      case 'undo':
      case 'redo':
        // Handled by the store before resolve()/apply() is ever reached.
        return reject(intent, 'invalid', 'Undo/redo must be handled by the scene store.');
      default: {
        const exhaustive: never = intent;
        return reject(exhaustive, 'invalid', 'Unrecognized intent.');
      }
    }
  }

  return { resolve };
}

function scaleProxy<T extends { kind: string }>(proxy: T, factor: number): T {
  const p = proxy as unknown as
    | { kind: 'box'; halfExtents: { x: number; y: number; z: number } }
    | { kind: 'sphere'; radius: number }
    | { kind: 'capsule'; radius: number; halfHeight: number };
  if (p.kind === 'box') {
    return {
      kind: 'box',
      halfExtents: { x: p.halfExtents.x * factor, y: p.halfExtents.y * factor, z: p.halfExtents.z * factor },
    } as unknown as T;
  }
  if (p.kind === 'sphere') {
    return { kind: 'sphere', radius: p.radius * factor } as unknown as T;
  }
  return { kind: 'capsule', radius: p.radius * factor, halfHeight: p.halfHeight * factor } as unknown as T;
}

export default createResolver;
