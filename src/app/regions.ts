/**
 * Wires the per-region state machine (src/core/regions.ts) into the scene
 * store. Nothing here mutates snapshots directly - every change goes through
 * `store.dispatch` with `registerRegion` / `removeRegion` / `setRegionState`
 * so the resolver, undo history (regions are not undoable), and every other
 * subscriber stay consistent.
 *
 * Region lifecycle:
 *  - `onSurfaceRegistered` / `onSurfaceRemoved` (call from a store.subscribe
 *    listener keyed off the applied intent) create/update/remove one region
 *    per tracked surface (horizontal table/desk/shelf/couch/bed/storage/floor,
 *    or vertical wall).
 *  - `tick(...)`, called once per rendered frame, drives every existing
 *    region through the state machine: obstruction evidence (hand/head
 *    inside the region), the depth/tracking watchdog, and the desired
 *    baseline (CAPTURED while the app is in captured-shell mode and quality
 *    allows it, LIVE otherwise).
 *  - `reportObstructionAt(point, ...)` is the one-shot version used by
 *    `AppHandle.reportObstruction` (tests, voice): "a person crossed here".
 */
import type {
  Aabb,
  Intent,
  Millis,
  QualityDecision,
  Region,
  RuntimeConditions,
  SceneSnapshot,
  Surface,
  Vec3,
  VisualMode,
} from '@/core/types';
import type { RegionStateMachine, SceneStore } from '@/core/api';
import { aabbContains, aabbExpand } from '@/core/math';

/** Horizontal surfaces that get a region; everything else is ignored except walls (vertical). */
const HORIZONTAL_REGION_LABELS = new Set(['table', 'desk', 'shelf', 'couch', 'bed', 'storage', 'floor']);
const REGION_EXPAND_M = 0.25;
const FLOOR_EXPAND_UP_M = 0.5;

export function regionIdForSurface(surfaceId: string): string {
  return `region:${surfaceId}`;
}

function shouldTrackSurface(surface: Surface): boolean {
  if (surface.orientation === 'vertical') return surface.label === 'wall';
  if (surface.orientation === 'horizontal') return HORIZONTAL_REGION_LABELS.has(surface.label);
  return false;
}

function boundsForSurface(surface: Surface): Aabb {
  const expanded = aabbExpand(surface.aabb, REGION_EXPAND_M);
  if (surface.label === 'floor') {
    return { ...expanded, max: { ...expanded.max, y: surface.aabb.max.y + FLOOR_EXPAND_UP_M } };
  }
  return expanded;
}

function sameObjects(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface RegionManagerOptions {
  store: SceneStore;
  regionMachine: RegionStateMachine;
  /** Depth-sensing has no reliable "never sampled yet" story in the emulator
   * (see docs/testing.md); an infinite depth age must not, by itself, force
   * a captured region to FALLBACK the instant it becomes HYBRID. Only a
   * *finite, growing* depth age (real staleness once a sample existed)
   * should count. */
  effectiveDepthAgeMs?: (raw: number) => number;
}

export class RegionManager {
  private readonly store: SceneStore;
  private readonly regionMachine: RegionStateMachine;
  private readonly effectiveDepthAgeMs: (raw: number) => number;
  private lastObjectsVersion = -1;

  constructor(opts: RegionManagerOptions) {
    this.store = opts.store;
    this.regionMachine = opts.regionMachine;
    this.effectiveDepthAgeMs = opts.effectiveDepthAgeMs ?? ((raw) => (Number.isFinite(raw) ? raw : 0));
  }

  /** Feed this from a store.subscribe listener: reacts to registerSurface/removeSurface. */
  onCommit(applied: { intent: Intent } | null, conditions: RuntimeConditions): void {
    if (!applied) return;
    if (applied.intent.kind === 'registerSurface') {
      this.syncSurface(applied.intent.surface, conditions);
    } else if (applied.intent.kind === 'removeSurface') {
      this.removeSurfaceRegion(applied.intent.surfaceId, conditions);
    }
  }

  private syncSurface(surface: Surface, conditions: RuntimeConditions): void {
    if (!shouldTrackSurface(surface)) return;
    const id = regionIdForSurface(surface.id);
    const bounds = boundsForSurface(surface);
    const existing = this.store.current.regions[id];

    if (!existing) {
      const region: Region = {
        id,
        bounds,
        state: 'LIVE',
        reason: 'none',
        surfaces: [surface.id],
        objects: [],
        since: conditions.now,
      };
      this.dispatch({ kind: 'registerRegion', region }, conditions);
      return;
    }

    const boundsChanged = JSON.stringify(existing.bounds) !== JSON.stringify(bounds);
    if (boundsChanged) {
      this.dispatch({ kind: 'registerRegion', region: { ...existing, bounds } }, conditions);
    }
  }

  private removeSurfaceRegion(surfaceId: string, conditions: RuntimeConditions): void {
    const id = regionIdForSurface(surfaceId);
    if (!this.store.current.regions[id]) return;
    this.dispatch({ kind: 'removeRegion', regionId: id }, conditions);
  }

  /** Call once per rendered frame. `obstructionPoints` are world-space points (hands, head). */
  tick(conditions: RuntimeConditions, mode: VisualMode, quality: QualityDecision, obstructionPoints: Vec3[]): void {
    const versionAtStart = this.store.current.version;
    if (versionAtStart !== this.lastObjectsVersion) {
      this.recomputeRegionObjects(conditions);
      this.lastObjectsVersion = this.store.current.version;
    }

    const desiredBaseline = mode === 'captured-shell' && quality.allowCapturedShell && conditions.trackingOk;
    const depthAgeMs = this.effectiveDepthAgeMs(conditions.depthAgeMs);

    for (const id of Object.keys(this.store.current.regions)) {
      this.tickRegion(id, conditions, depthAgeMs, desiredBaseline, obstructionPoints);
    }
  }

  /** One-shot obstruction evidence for whichever region(s) contain `point` (tests/voice). */
  reportObstructionAt(point: Vec3, conditions: RuntimeConditions): void {
    for (const region of Object.values(this.store.current.regions)) {
      if (!aabbContains(region.bounds, point)) continue;
      const next = this.regionMachine.reportObstruction(region, conditions.now);
      if (next !== region) this.applyRegionState(region.id, next, conditions);
    }
  }

  private tickRegion(
    id: string,
    conditions: RuntimeConditions,
    depthAgeMs: number,
    desiredBaseline: boolean,
    obstructionPoints: Vec3[],
  ): void {
    let region = this.store.current.regions[id];
    if (!region) return;

    const obstructed = obstructionPoints.some((p) => aabbContains(region!.bounds, p));
    if (obstructed) {
      const next = this.regionMachine.reportObstruction(region, conditions.now);
      if (next !== region) {
        this.applyRegionState(id, next, conditions);
        region = this.store.current.regions[id] ?? region;
      }
    }

    const ticked = this.regionMachine.tick(region, conditions.now, depthAgeMs, conditions.trackingOk);
    if (ticked !== region) {
      this.applyRegionState(id, ticked, conditions);
      region = this.store.current.regions[id] ?? region;
    }

    if (desiredBaseline) {
      // Only recover automatically from our own "mode turned off" fallback
      // (reason 'user', set in the else-branch below). Every other fallback
      // reason (dynamic_obstruction, tracking_lost, depth_stale, ...) is
      // real evidence-loss and must only clear through the state machine's
      // own tick()-driven recovery (or an explicit request from elsewhere) -
      // never a blind "mode says captured-shell, so go straight back" jump.
      if (region.state === 'FALLBACK' && region.reason === 'user') {
        const toLive = this.regionMachine.request(region, 'LIVE', 'none', conditions.now);
        if (toLive !== region) {
          this.applyRegionState(id, toLive, conditions);
          region = this.store.current.regions[id] ?? region;
        }
      }
      if (region.state === 'LIVE') {
        const toCaptured = this.regionMachine.request(region, 'CAPTURED', 'none', conditions.now);
        if (toCaptured !== region) this.applyRegionState(id, toCaptured, conditions);
      }
      return;
    }

    if (region.state === 'CAPTURED' || region.state === 'HYBRID' || region.state === 'TRANSITION') {
      const toFallback = this.regionMachine.request(region, 'FALLBACK', 'user', conditions.now);
      if (toFallback !== region) {
        this.applyRegionState(id, toFallback, conditions);
        region = this.store.current.regions[id] ?? region;
        const toLive = this.regionMachine.request(region, 'LIVE', 'none', conditions.now);
        if (toLive !== region) this.applyRegionState(id, toLive, conditions);
      }
    }
  }

  /**
   * Additive (general-camera backend): once tracking is back, return regions
   * that fell back with reason 'tracking_lost' to LIVE so edits resume. The
   * core state machine's tick() never leaves that state on its own, and the
   * baseline driver above only recovers its own 'user' fallbacks; on a webcam
   * a bumped camera is routine, so the camera app calls this every frame.
   * The WebXR path does not call it (behaviour unchanged there).
   */
  recoverTrackingFallbacks(conditions: RuntimeConditions): void {
    if (!conditions.trackingOk) return;
    for (const region of Object.values(this.store.current.regions)) {
      if (region.state !== 'FALLBACK' || region.reason !== 'tracking_lost') continue;
      const toLive = this.regionMachine.request(region, 'LIVE', 'none', conditions.now);
      if (toLive !== region) this.applyRegionState(region.id, toLive, conditions);
    }
  }

  private recomputeRegionObjects(conditions: RuntimeConditions): void {
    const snapshot: SceneSnapshot = this.store.current;
    for (const region of Object.values(snapshot.regions)) {
      const ids: string[] = [];
      for (const obj of Object.values(snapshot.objects)) {
        if (!obj.visible) continue;
        if (aabbContains(region.bounds, obj.currentPose.position)) ids.push(obj.id);
      }
      if (!sameObjects(ids, region.objects)) {
        this.dispatch({ kind: 'registerRegion', region: { ...region, objects: ids } }, conditions);
      }
    }
  }

  private applyRegionState(id: string, region: Region, conditions: RuntimeConditions): void {
    this.dispatch({ kind: 'setRegionState', regionId: id, state: region.state, reason: region.reason }, conditions);
  }

  private dispatch(intent: Intent, conditions: RuntimeConditions): void {
    this.store.dispatch(
      { intent, source: 'system', issuedAt: conditions.now, basedOnVersion: this.store.current.version },
      conditions,
    );
  }
}
