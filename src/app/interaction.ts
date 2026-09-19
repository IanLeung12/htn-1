/**
 * Interaction transaction loop: turns per-frame InputState into scene
 * intents through the resolver. Runs every rendered frame; never awaits.
 */
import * as THREE from 'three';
import type { SceneStore } from '@/core/api';
import { raycastProxies, surfaceBelow } from '@/core';
import { quatFromAxisAngle, quatMultiply } from '@/core/math';
import { TIER_CAPABILITIES, type EditableObject, type Pose, type Quat, type ResolveResult, type RuntimeConditions, type Vec3 } from '@/core/types';
import type { Handedness, HandState, InputState } from '@/xr/input';
import { clampTwoHandScale, computeTwoHandDelta, quatAngleDeg, ROTATE_COMMIT_EPSILON_DEG, SCALE_COMMIT_EPSILON } from './two-hand';

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

/** Midpoint between two hands, as plain data for `computeTwoHandDelta`. */
function twoHandMidpoint(leftState: HandState, rightState: HandState): Vec3 {
  return {
    x: (leftState.position.x + rightState.position.x) / 2,
    y: (leftState.position.y + rightState.position.y) / 2,
    z: (leftState.position.z + rightState.position.z) / 2,
  };
}

/** Vector from the left hand to the right hand, as plain data for `computeTwoHandDelta`. */
function twoHandVector(leftState: HandState, rightState: HandState): Vec3 {
  return {
    x: rightState.position.x - leftState.position.x,
    y: rightState.position.y - leftState.position.y,
    z: rightState.position.z - leftState.position.z,
  };
}

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

/**
 * State for an in-progress two-hand grab: entered when a second hand pinches
 * while hovering the object the other hand already holds (see `enterTwoHand`).
 * `lastPosition`/`lastRotation`/`lastScale` are refreshed every frame by
 * `driveTwoHand` and are what `exitTwoHand` commits on release.
 */
interface TwoHandInfo {
  objectId: string;
  initialMidpoint: Vec3;
  /** Vector from the left hand to the right hand at grab-start; `driveTwoHand` always samples in this order. */
  initialVector: Vec3;
  initialPosition: Vec3;
  initialRotation: Quat;
  /** Whether this object's tier permits 'rotate'/'scale' (checked once, at grab-start). */
  allowRotate: boolean;
  allowScale: boolean;
  lastPosition: Vec3;
  lastRotation: Quat;
  /** Cumulative scale factor relative to grab-start (1 = unchanged), clamped to [0.25, 4]. */
  lastScale: number;
}

export class InteractionController {
  hoveredId: string | null = null;
  selectedId: string | null = null;

  /** Select without grabbing (click-to-detect selects the object it just registered). */
  select(objectId: string | null): void {
    this.selectedId = objectId;
  }
  lastRejection: RejectionInfo | null = null;

  private readonly grabs = new Map<Handedness, GrabInfo>();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private twoHand: TwoHandInfo | null = null;

  /** Extra reach around every proxy for hover/grab (metres); pointer backends set ~0.04 for small real objects. */
  pickPadM = 0;

  constructor(private readonly store: SceneStore) {}

  /** Call once per rendered frame. */
  update(input: InputState, conditions: RuntimeConditions): void {
    this.updateHandEdges('left', input.left, input.right, 'right', conditions);
    this.updateHandEdges('right', input.right, input.left, 'left', conditions);

    if (this.twoHand) {
      this.driveTwoHand(conditions, input.left, input.right);
    } else {
      for (const hand of HANDS) {
        const grab = this.grabs.get(hand);
        if (grab) this.driveGrab(grab, input[hand], conditions);
      }
    }
  }

  /**
   * Hover + grab-start/grab-end bookkeeping for one hand. Never drives motion
   * itself (see `update`), so it's safe to call for both hands before either
   * one's continuous drive runs this frame.
   */
  private updateHandEdges(
    hand: Handedness,
    state: HandState,
    otherState: HandState,
    otherHand: Handedness,
    conditions: RuntimeConditions,
  ): void {
    if (!state.active) {
      if (this.twoHand) {
        this.exitTwoHand(conditions, otherHand, otherState.active ? otherState : null);
      } else if (this.grabs.has(hand)) {
        this.release(hand, conditions);
      }
      return;
    }

    const snapshot = this.store.current;
    const origin = { x: state.ray.origin.x, y: state.ray.origin.y, z: state.ray.origin.z };
    const dir = { x: state.ray.direction.x, y: state.ray.direction.y, z: state.ray.direction.z };
    const hits = raycastProxies(snapshot, origin, dir, 3, this.pickPadM);
    // A hand enclosed by a proxy counts as hovering only for hand-sized objects; being
    // inside a couch or table proxy must not make every pinch grab the furniture.
    let hoverId: string | null = null;
    for (const hit of hits) {
      if (!hit.originInside || isGraspable(snapshot.objects[hit.objectId])) {
        hoverId = hit.objectId;
        break;
      }
    }
    if (!this.grabs.has(hand) && !this.twoHand) {
      this.hoveredId = hoverId;
    }

    if (state.selectStart && hoverId && !this.grabs.has(hand) && !this.twoHand) {
      const otherGrab = this.grabs.get(otherHand);
      if (otherGrab && otherGrab.objectId === hoverId) {
        // Second hand pinches the object the other hand already holds: enter
        // two-hand mode instead of the old "reject, already grabbed" rule.
        const leftState = hand === 'left' ? state : otherState;
        const rightState = hand === 'left' ? otherState : state;
        this.enterTwoHand(hoverId, otherHand, leftState, rightState);
      } else if (!otherGrab) {
        this.grab(hoverId, hand, state);
      }
    }

    if (state.selectEnd) {
      if (this.twoHand) {
        this.exitTwoHand(conditions, otherHand, otherState);
      } else if (this.grabs.has(hand)) {
        this.release(hand, conditions);
      }
    }
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

  /**
   * Enter two-hand mode for `objectId`, dropping the single-hand grab that
   * `holderHand` held (two-hand mode manages the object directly instead).
   * `leftState`/`rightState` are always in left/right order regardless of
   * which hand just started pinching, so `initialVector` has a stable sign.
   */
  private enterTwoHand(objectId: string, holderHand: Handedness, leftState: HandState, rightState: HandState): void {
    const obj = this.store.current.objects[objectId];
    if (!obj) return;

    this.grabs.delete(holderHand);

    const capabilities = TIER_CAPABILITIES[obj.tier];
    this.twoHand = {
      objectId,
      initialMidpoint: twoHandMidpoint(leftState, rightState),
      initialVector: twoHandVector(leftState, rightState),
      initialPosition: { ...obj.currentPose.position },
      initialRotation: { ...obj.currentPose.rotation },
      allowRotate: capabilities.has('rotate'),
      allowScale: capabilities.has('scale'),
      lastPosition: { ...obj.currentPose.position },
      lastRotation: { ...obj.currentPose.rotation },
      lastScale: 1,
    };
    this.selectedId = objectId;
  }

  /** Continuous per-frame drive of an active two-hand grab: publishes a `preview` intent. */
  private driveTwoHand(conditions: RuntimeConditions, leftState: HandState, rightState: HandState): void {
    const twoHand = this.twoHand;
    if (!twoHand) return;

    const snapshot = this.store.current;
    const obj = snapshot.objects[twoHand.objectId];
    if (!obj || !obj.visible) {
      this.twoHand = null;
      this.store.dispatch(
        { intent: { kind: 'clearPreview' }, source: 'hand', issuedAt: conditions.now, basedOnVersion: snapshot.version },
        conditions,
      );
      return;
    }

    const delta = computeTwoHandDelta(
      { midpoint: twoHand.initialMidpoint, vector: twoHand.initialVector },
      { midpoint: twoHandMidpoint(leftState, rightState), vector: twoHandVector(leftState, rightState) },
    );

    const position: Vec3 = {
      x: twoHand.initialPosition.x + delta.position.x,
      y: twoHand.initialPosition.y + delta.position.y,
      z: twoHand.initialPosition.z + delta.position.z,
    };

    let rotation = twoHand.initialRotation;
    if (twoHand.allowRotate && delta.yawRad !== 0) {
      rotation = quatMultiply(quatFromAxisAngle({ x: 0, y: 1, z: 0 }, delta.yawRad), twoHand.initialRotation);
    }

    const scale = twoHand.allowScale ? clampTwoHandScale(delta.scale) : 1;

    twoHand.lastPosition = position;
    twoHand.lastRotation = rotation;
    twoHand.lastScale = scale;

    const pose: Pose = { position, rotation };
    const result = this.store.dispatch(
      { intent: { kind: 'preview', objectId: twoHand.objectId, pose, action: 'move', scale }, source: 'hand', issuedAt: conditions.now, basedOnVersion: snapshot.version },
      conditions,
    );
    this.handleResult(result, conditions);
  }

  /**
   * Commit a finished two-hand grab: scale, then rotate, then move (final
   * position, snapped to `surfaceBelow` like a single-hand release). Each is
   * attempted independently, so a resolver rejection of one (e.g. tier
   * forbids scale) still lets the others commit. If the other hand is still
   * pinching, it continues in single-hand mode with a fresh offset.
   */
  private exitTwoHand(conditions: RuntimeConditions, remainingHand: Handedness, remainingState: HandState | null): void {
    const twoHand = this.twoHand;
    this.twoHand = null;
    if (!twoHand) return;

    const snapshot = this.store.current;
    const obj = snapshot.objects[twoHand.objectId];
    if (!obj || !obj.visible) {
      // Deleted mid-grab: nothing to commit, just drop the preview.
      this.store.dispatch(
        { intent: { kind: 'clearPreview' }, source: 'hand', issuedAt: conditions.now, basedOnVersion: snapshot.version },
        conditions,
      );
      return;
    }

    if (Math.abs(twoHand.lastScale - 1) > SCALE_COMMIT_EPSILON) {
      const result = this.store.dispatch(
        {
          intent: { kind: 'scale', objectId: twoHand.objectId, factor: twoHand.lastScale },
          source: 'hand',
          issuedAt: conditions.now,
          basedOnVersion: this.store.current.version,
        },
        conditions,
      );
      this.handleResult(result, conditions);
    }

    if (quatAngleDeg(twoHand.initialRotation, twoHand.lastRotation) > ROTATE_COMMIT_EPSILON_DEG) {
      const result = this.store.dispatch(
        {
          intent: { kind: 'rotate', objectId: twoHand.objectId, rotation: twoHand.lastRotation },
          source: 'hand',
          issuedAt: conditions.now,
          basedOnVersion: this.store.current.version,
        },
        conditions,
      );
      this.handleResult(result, conditions);
    }

    // Read back whatever rotation actually committed (rotate may have been
    // rejected) so the move intent - which replaces the whole pose - doesn't
    // clobber it back to the pre-grab rotation.
    const afterRotate = this.store.current.objects[twoHand.objectId];
    const rotationForMove = afterRotate ? afterRotate.currentPose.rotation : twoHand.initialRotation;

    let finalPosition = twoHand.lastPosition;
    const surface = surfaceBelow(this.store.current, finalPosition);
    if (surface && Math.abs(surface.aabb.max.y - finalPosition.y) <= GRAB_SNAP_DIST) {
      finalPosition = { ...finalPosition, y: surface.aabb.max.y };
    }

    const moveResult = this.store.dispatch(
      {
        intent: { kind: 'move', objectId: twoHand.objectId, pose: { position: finalPosition, rotation: rotationForMove } },
        source: 'hand',
        issuedAt: conditions.now,
        basedOnVersion: this.store.current.version,
      },
      conditions,
    );
    this.handleResult(moveResult, conditions);

    this.store.dispatch(
      { intent: { kind: 'clearPreview' }, source: 'hand', issuedAt: conditions.now, basedOnVersion: this.store.current.version },
      conditions,
    );

    if (remainingState && remainingState.active && remainingState.pinching) {
      this.grab(twoHand.objectId, remainingHand, remainingState);
    }
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
