/**
 * Reality Editor - shared core contract.
 *
 * Pure TypeScript. No DOM, no three.js. Everything the renderer, XR layer,
 * capture pipeline, and simulator agree on lives here. Keep it boring:
 * plain data, versioned snapshots, explicit provenance.
 */

// ---------------------------------------------------------------------------
// Math primitives (plain data so snapshots can be structured-cloned/persisted)
// ---------------------------------------------------------------------------

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export interface Pose { position: Vec3; rotation: Quat }
export interface Aabb { min: Vec3; max: Vec3 }

export const IDENTITY_QUAT: Readonly<Quat> = { x: 0, y: 0, z: 0, w: 1 };
export const ZERO_VEC3: Readonly<Vec3> = { x: 0, y: 0, z: 0 };

/**
 * Id of the single room-scale persistent anchor managed by `src/xr/anchors.ts`.
 * Objects that should be rejected (anchor_lost) when the room anchor isn't
 * currently localized carry this as their `EditableObject.anchorId`. Lives in
 * core (not src/xr) because src/capture and src/app also need to stamp it
 * onto objects without creating a dependency on the XR layer.
 */
export const ROOM_ANCHOR_ID = 'room-anchor';

// ---------------------------------------------------------------------------
// Time / freshness contract
// ---------------------------------------------------------------------------

/** Milliseconds on the monotonic clock used by the app (performance.now()). */
export type Millis = number;

/** Every async subsystem publishes results stamped like this. */
export interface Stamped<T> {
  value: T;
  /** When the source produced this value. */
  timestamp: Millis;
  /** Scene version the value was computed against (0 = independent). */
  sceneVersion: number;
  /** 0..1 confidence; consumers may ignore low-confidence results. */
  confidence: number;
}

export type Subsystem =
  | 'headPose'
  | 'physics'
  | 'sceneSnapshot'
  | 'handPose'
  | 'environmentDepth'
  | 'lighting'
  | 'segmentation'
  | 'reconstruction'
  | 'assetGeneration';

// ---------------------------------------------------------------------------
// Editability tiers, background coverage, provenance
// ---------------------------------------------------------------------------

/** From reality-editor-capture-and-editability.md. */
export type EditTier = 'A' | 'B' | 'C' | 'D' | 'E';

export type BackgroundProvenance =
  | 'observed_clean_plate'
  | 'multi_view_observed'
  | 'constrained_surface'
  | 'synthetic_completion'
  | 'unavailable';

export type BackgroundVersionTag = 'observed_v1' | 'fused_v2' | 'completed_v3' | 'invalidated';

export type EditAction =
  | 'move' | 'delete' | 'restore' | 'undo' | 'replace' | 'spawn' | 'scale' | 'rotate';

/** Which actions each tier permits. Single source of truth for the resolver. */
export const TIER_CAPABILITIES: Record<EditTier, ReadonlySet<EditAction>> = {
  A: new Set<EditAction>(['move', 'delete', 'restore', 'undo', 'replace', 'rotate', 'scale']),
  B: new Set<EditAction>(['move', 'delete', 'restore', 'undo', 'rotate']),
  C: new Set<EditAction>(['move', 'restore', 'undo', 'rotate']),
  D: new Set<EditAction>(['move', 'restore', 'undo']),
  E: new Set<EditAction>(['restore', 'undo']),
};

/** Viewpoint envelope in which an edit has been verified to look right. */
export interface ViewpointEnvelope {
  /** Centre of the verified capture path. */
  center: Vec3;
  /** Max head distance from center (m) where the edit is trusted. */
  radius: number;
  /** Max angular deviation (rad) from the capture heading. */
  maxAngle: number;
}

// ---------------------------------------------------------------------------
// Object package
// ---------------------------------------------------------------------------

export type ObjectOrigin = 'physical' | 'spawned' | 'imported';

export type SemanticLabel =
  | 'desk' | 'couch' | 'floor' | 'ceiling' | 'wall' | 'door' | 'window' | 'table'
  | 'shelf' | 'bed' | 'screen' | 'lamp' | 'plant' | 'wall art' | 'storage'
  | 'global mesh' | 'other';

export type ProxyShape =
  | { kind: 'box'; halfExtents: Vec3 }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; radius: number; halfHeight: number };

export interface PhysicalParams {
  massKg: number;
  friction: number;
  restitution: number;
  /** True if the object should stay where placed (no gravity settling). */
  kinematic: boolean;
}

export interface VisualAssetRef {
  /** primitive renders from proxy; gltf loads url; baked uses a capture atlas. */
  kind: 'primitive' | 'gltf' | 'baked';
  url?: string;
  color?: number;
}

export interface BackgroundPlate {
  id: string;
  provenance: BackgroundProvenance;
  version: BackgroundVersionTag;
  /** Region of the support surface this plate covers, in world space. */
  region: Aabb;
  /** 0..1 fraction of the region actually observed. */
  coverage: number;
  /** Where a baked plate texture lives (sim: data URL / blob key). */
  textureRef?: string;
  envelope: ViewpointEnvelope;
}

export interface CaptureProvenance {
  method: 'scene_volume' | 'guided_clean_plate' | 'multi_view' | 'spawned' | 'imported';
  capturedAt: Millis;
  /** Head poses used during capture, for envelope checks. */
  capturePath: Pose[];
  notes?: string;
}

/** The full object package described in the canonical architecture. */
export interface EditableObject {
  id: string;
  label: SemanticLabel;
  userName: string;
  origin: ObjectOrigin;
  originalPose: Pose;
  currentPose: Pose;
  anchorId?: string;
  visual: VisualAssetRef;
  interactionProxy: ProxyShape;
  collisionProxy: ProxyShape;
  occlusionProxy: ProxyShape;
  /** Ids of surfaces (planes) this object rests on. */
  supportSurfaces: string[];
  background: BackgroundPlate[];
  provenance: CaptureProvenance;
  tier: EditTier;
  tierConfidence: number;
  envelope: ViewpointEnvelope;
  physical: PhysicalParams;
  /** True once the user approved it in candidate discovery. */
  approved: boolean;
  /** Runtime visibility; false after delete. */
  visible: boolean;
  /** Which asset currently substitutes for a replaced object, if any. */
  replacedBy?: string;
}

// ---------------------------------------------------------------------------
// Room shell / regions
// ---------------------------------------------------------------------------

export type RegionState = 'LIVE' | 'CAPTURED' | 'HYBRID' | 'TRANSITION' | 'FALLBACK';

export type FallbackReason =
  | 'depth_stale'
  | 'tracking_lost'
  | 'registration_drift'
  | 'dynamic_obstruction'
  | 'budget'
  | 'thermal'
  | 'evidence_expired'
  | 'user'
  | 'none';

export interface Region {
  id: string;
  bounds: Aabb;
  state: RegionState;
  reason: FallbackReason;
  /** Surface ids (planes/meshes) that form this region's static shell. */
  surfaces: string[];
  /** Object ids whose edits touch this region. */
  objects: string[];
  since: Millis;
}

export interface Surface {
  id: string;
  label: SemanticLabel;
  orientation: 'horizontal' | 'vertical' | 'mesh';
  pose: Pose;
  /** Polygon in surface-local XZ plane (planes); empty for meshes. */
  polygon: { x: number; z: number }[];
  aabb: Aabb;
  lastChanged: Millis;
}

export type VisualMode = 'live-overlay' | 'captured-shell';

// ---------------------------------------------------------------------------
// Scene snapshot (what the renderer draws)
// ---------------------------------------------------------------------------

export interface SceneSnapshot {
  version: number;
  committedAt: Millis;
  mode: VisualMode;
  objects: Record<string, EditableObject>;
  surfaces: Record<string, Surface>;
  regions: Record<string, Region>;
  /** Id of the object being previewed (ghost), if any. */
  preview?: { objectId: string; pose: Pose; action: EditAction; scale?: number };
}

// ---------------------------------------------------------------------------
// Interaction transactions
// ---------------------------------------------------------------------------

export type Intent =
  | { kind: 'move'; objectId: string; pose: Pose }
  | { kind: 'rotate'; objectId: string; rotation: Quat }
  | { kind: 'scale'; objectId: string; factor: number }
  | { kind: 'delete'; objectId: string }
  | { kind: 'restore'; objectId: string }
  | { kind: 'replace'; objectId: string; asset: VisualAssetRef }
  | { kind: 'spawn'; object: EditableObject }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'approve'; objectId: string; approved: boolean }
  | { kind: 'setMode'; mode: VisualMode }
  | { kind: 'setRegionState'; regionId: string; state: RegionState; reason: FallbackReason }
  | { kind: 'registerSurface'; surface: Surface }
  | { kind: 'removeSurface'; surfaceId: string }
  | { kind: 'registerRegion'; region: Region }
  | { kind: 'removeRegion'; regionId: string }
  | { kind: 'registerObject'; object: EditableObject }
  | { kind: 'updateBackground'; objectId: string; plate: BackgroundPlate }
  | { kind: 'setTier'; objectId: string; tier: EditTier; confidence: number }
  | {
      kind: 'setProxies';
      objectId: string;
      interaction: ProxyShape;
      collision: ProxyShape;
      occlusion: ProxyShape;
    }
  | { kind: 'preview'; objectId: string; pose: Pose; action: EditAction; scale?: number }
  | { kind: 'clearPreview' };

export type IntentSource = 'hand' | 'controller' | 'voice' | 'ui' | 'system' | 'test';

export interface IntentEnvelope {
  intent: Intent;
  source: IntentSource;
  issuedAt: Millis;
  /** Snapshot version the issuer was looking at when deciding. */
  basedOnVersion: number;
}

export type RejectReason =
  | 'tier_forbids'
  | 'no_background_evidence'
  | 'outside_envelope'
  | 'tracking_lost'
  | 'anchor_lost'
  | 'unknown_object'
  | 'not_approved'
  | 'stale_intent'
  | 'nothing_to_undo'
  | 'nothing_to_redo'
  | 'physics_blocked'
  | 'region_fallback'
  | 'invalid';

export type ResolveResult =
  | { ok: true; snapshot: SceneSnapshot; applied: Intent }
  | { ok: false; reason: RejectReason; explanation: string; intent: Intent };

/** Live conditions the resolver consults before committing. */
export interface RuntimeConditions {
  now: Millis;
  headPose: Pose;
  trackingOk: boolean;
  /** Anchors currently localized. */
  localizedAnchors: ReadonlySet<string>;
  /** Age of the newest environment-depth frame in ms (Infinity if none). */
  depthAgeMs: number;
  tier: QualityTier;
}

// ---------------------------------------------------------------------------
// Quality tiers and watchdogs
// ---------------------------------------------------------------------------

/** 0 safety, 1 baseline, 2 enhanced, 3 tethered/authoring. */
export type QualityTier = 0 | 1 | 2 | 3;

export interface FrameSample {
  t: Millis;
  frameMs: number;
  /** Optional GPU estimate (ms) if available. */
  gpuMs?: number;
  /** Time spent inside the app's frame callback (input, resolver, physics, view diffs), ms. */
  appMs?: number;
  depthAgeMs: number;
  trackingOk: boolean;
  droppedFrames: number;
  thermalThrottled: boolean;
  memoryPressure: boolean;
  handConfidence: number;
  registrationErrorM: number;
}

export type DegradeReason =
  | 'frame_time'
  | 'thermal'
  | 'depth_age'
  | 'tracking'
  | 'memory'
  | 'dropped_frames'
  | 'hand_confidence'
  | 'registration'
  | 'compositor'
  | 'manual';

export interface QualityDecision {
  tier: QualityTier;
  reasons: DegradeReason[];
  /** Whether the room shell may be shown in captured-shell mode. */
  allowCapturedShell: boolean;
  /** Whether environment-depth occlusion is trusted. */
  trustDepth: boolean;
  at: Millis;
}

export interface PerfStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}
