/**
 * Interaction transaction loop: turns per-frame InputState into scene
 * intents through the resolver. Runs every rendered frame; never awaits.
 */
import * as THREE from 'three';
import type { SceneStore } from '@/core/api';
import { raycastProxies, surfaceBelow } from '@/core';
import type { EditableObject, Pose, ResolveResult, RuntimeConditions } from '@/core/types';
import type { Handedness, HandState, InputState } from '@/xr/input';

const GRAB_SNAP_DIST = 0.05;
/** Largest half extent (m) an object may have and still be grabbed from inside its proxy. */
const GRASPABLE_HALF_EXTENT_M = 0.4;

function isGraspable(obj: EditableObject | undefined): boolean {
  if (!obj) return false;
  const p = obj.interactionProxy;
  if (p.kind === 'box') return Math.max(p.halfExtents.x, p.halfExtents.y, p.halfExtents.z) <= GRASPABLE_HALF_EXTENT_M;
  if (p.kind === 'sphere') return p.radius <= GRASPABLE_HALF_EXTENT_M;
  return Math.max(p.radius, p.halfHeight + p.radius) <= GRASPABLE_HALF_EXTENT_M;
}

/** Hoisted so the per-frame two-hand loop doesn't allocate a tuple + closure every call. */
const HANDS: readonly Handedness[] = ['left', 'right'];

export interface RejectionInfo {
  reason: string;
  explanation: string;
  at: number;
}

interface GrabInfo {
  objectId: string;
  hand: Handedness;
  /** Object pose relative to the hand's grab point at grab time (local offset). */
  offsetPosition: THREE.Vector3;
  offsetQuaternion: THREE.Quaternion;
}

export class InteractionController {
  hoveredId: string | null = null;
  selectedId: string | null = null;
  lastRejection: RejectionInfo | null = null;

  private readonly grabs = new Map<Handedness, GrabInfo>();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();

  constructor(private readonly store: SceneStore) {}

  /** Call once per rendered frame. */
  update(input: InputState, conditions: RuntimeConditions): void {
    for (const hand of HANDS) {
      this.updateHand(hand, input[hand], conditions);
    }
  }

  private updateHand(hand: Handedness, state: HandState, conditions: RuntimeConditions): void {
    if (!state.active) {
      if (this.grabs.has(hand)) this.release(hand, conditions);
      return;
    }

    const snapshot = this.store.current;
    const origin = { x: state.ray.origin.x, y: state.ray.origin.y, z: state.ray.origin.z };
    const dir = { x: state.ray.direction.x, y: state.ray.direction.y, z: state.ray.direction.z };
    const hits = raycastProxies(snapshot, origin, dir, 3);
    // A hand enclosed by a proxy counts as hovering only for hand-sized objects; being
    // inside a couch or table proxy must not make every pinch grab the furniture.
    let hoverId: string | null = null;
    for (const hit of hits) {
      if (!hit.originInside || isGraspable(snapshot.objects[hit.objectId])) {
        hoverId = hit.objectId;
        break;
      }
    }
    if (!this.grabs.has(hand)) {
      this.hoveredId = hoverId;
    }

    if (state.selectStart && hoverId && !this.grabs.has(hand) && !this.isGrabbedByOtherHand(hoverId, hand)) {
      this.grab(hoverId, hand, state);
    }

    const grab = this.grabs.get(hand);
    if (grab) {
      this.driveGrab(grab, state, conditions);
    }

    if (state.selectEnd) {
      this.release(hand, conditions);
    }
  }

  private isGrabbedByOtherHand(objectId: string, hand: Handedness): boolean {
    for (const [h, g] of this.grabs) {
      if (h !== hand && g.objectId === objectId) return true;
    }
    return false;
  }

  /** Programmatic grab API per app contract. */
  grab(objectId: string, hand: Handedness, state?: HandState): boolean {
    const snapshot = this.store.current;
    const obj = snapshot.objects[objectId];
    if (!obj) return false;

    const grabPos = state ? state.position : new THREE.Vector3(obj.currentPose.position.x, obj.currentPose.position.y, obj.currentPose.position.z);
    const grabQuat = state ? state.quaternion : new THREE.Quaternion();

    const objPos = new THREE.Vector3(obj.currentPose.position.x, obj.currentPose.position.y, obj.currentPose.position.z);
    const objQuat = new THREE.Quaternion(
      obj.currentPose.rotation.x,
      obj.currentPose.rotation.y,
      obj.currentPose.rotation.z,
      obj.currentPose.rotation.w,
    );

    const invGrabQuat = grabQuat.clone().invert();
    const offsetPosition = objPos.clone().sub(grabPos).applyQuaternion(invGrabQuat);
    const offsetQuaternion = invGrabQuat.clone().multiply(objQuat);

    this.grabs.set(hand, { objectId, hand, offsetPosition, offsetQuaternion });
    this.selectedId = objectId;
    return true;
  }

  release(hand: Handedness, conditions: RuntimeConditions): void {
    const grab = this.grabs.get(hand);
    this.grabs.delete(hand);
    if (!grab) return;

    const snapshot = this.store.current;
    const obj = snapshot.objects[grab.objectId];
    if (!obj || !obj.visible) {
      // Deleted mid-grab: nothing to commit, just drop the preview.
      this.store.dispatch(
        { intent: { kind: 'clearPreview' }, source: 'hand', issuedAt: conditions.now, basedOnVersion: snapshot.version },
        conditions,
      );
      return;
    }

    // Commit the previewed pose (the object followed the hand during the grab);
    // fall back to the current pose if no preview was ever published.
    let pose = snapshot.preview?.objectId === grab.objectId ? snapshot.preview.pose : obj.currentPose;
    const surface = surfaceBelow(snapshot, pose.position);
    if (surface && Math.abs(surface.aabb.max.y - pose.position.y) <= GRAB_SNAP_DIST) {
      pose = { position: { ...pose.position, y: surface.aabb.max.y }, rotation: pose.rotation };
    }

    const result: ResolveResult = this.store.dispatch(
      { intent: { kind: 'move', objectId: grab.objectId, pose }, source: 'hand', issuedAt: conditions.now, basedOnVersion: snapshot.version },
      conditions,
    );
    this.handleResult(result, conditions);
    this.store.dispatch(
      { intent: { kind: 'clearPreview' }, source: 'hand', issuedAt: conditions.now, basedOnVersion: this.store.current.version },
      conditions,
    );
  }

  private driveGrab(grab: GrabInfo, state: HandState, conditions: RuntimeConditions): void {
    this.tmpPos.copy(grab.offsetPosition).applyQuaternion(state.quaternion).add(state.position);
    this.tmpQuat.copy(state.quaternion).multiply(grab.offsetQuaternion);

    const pose: Pose = {
      position: { x: this.tmpPos.x, y: this.tmpPos.y, z: this.tmpPos.z },
      rotation: { x: this.tmpQuat.x, y: this.tmpQuat.y, z: this.tmpQuat.z, w: this.tmpQuat.w },
    };

    const snapshot = this.store.current;
    const result = this.store.dispatch(
      { intent: { kind: 'preview', objectId: grab.objectId, pose, action: 'move' }, source: 'hand', issuedAt: conditions.now, basedOnVersion: snapshot.version },
      conditions,
    );
    this.handleResult(result, conditions);
  }

  private handleResult(result: ResolveResult, conditions: RuntimeConditions): void {
    if (!result.ok) {
      this.lastRejection = { reason: result.reason, explanation: result.explanation, at: conditions.now };
    }
  }

  /** Delete the currently selected object, if any. */
  deleteSelected(conditions: RuntimeConditions): void {
    if (!this.selectedId) return;
    const result = this.store.dispatch(
      { intent: { kind: 'delete', objectId: this.selectedId }, source: 'ui', issuedAt: conditions.now, basedOnVersion: this.store.current.version },
      conditions,
    );
    this.handleResult(result, conditions);
  }

  restoreSelected(conditions: RuntimeConditions): void {
    if (!this.selectedId) return;
    const result = this.store.dispatch(
      { intent: { kind: 'restore', objectId: this.selectedId }, source: 'ui', issuedAt: conditions.now, basedOnVersion: this.store.current.version },
      conditions,
    );
    this.handleResult(result, conditions);
  }

  spawn(object: EditableObject, conditions: RuntimeConditions): void {
    const result = this.store.dispatch(
      { intent: { kind: 'spawn', object }, source: 'ui', issuedAt: conditions.now, basedOnVersion: this.store.current.version },
      conditions,
    );
    this.handleResult(result, conditions);
  }
}
