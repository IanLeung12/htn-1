/**
 * PointerInputAdapter: mouse/touch on the overlay canvas -> the same
 * `InputState` (src/xr/input.ts) that hand tracking produces, so the
 * unchanged `InteractionController` (src/app/interaction.ts) drives hover,
 * grab, move, and two-hand scale/yaw through the resolver.
 *
 * Mapping (see docs/general-camera/architecture.md, "InputAdapter"):
 *  - The primary pointer is the RIGHT hand. Its ray is the pointer ray
 *    through the camera; its "grab point" rides that ray at the depth of the
 *    object under the pointer (or the ground / a default depth otherwise).
 *  - Pressing = pinch. `selectStart`/`selectEnd` are true for exactly one
 *    `update()` call each, like real pinch edges. Pointer events are queued
 *    and drained one PHASE per update (down | moves | up), so a flick whose
 *    down, move and up all arrive within one frame still produces a grab, a
 *    moved preview, and a committed release over three updates.
 *  - While pressed, the grab point follows what the ESTIMATED DEPTH sees
 *    under the pointer when a `depthPick` is supplied (so a dragged object
 *    glides over the desk/bed the camera looks at). Without a depth hit it
 *    slides along the horizontal plane at the grab height (plus a
 *    wheel-driven lift), with runaway guards: a plane hit at a grazing angle
 *    is clamped to 1.5x the grab distance and to MAX_DRAG_DISTANCE_M, and
 *    the point moves at most MAX_STEP_M per update.
 *  - A second touch is the LEFT hand, pinching, on the same plane: the
 *    controller's two-hand mode then turns finger distance/angle into
 *    scale/yaw exactly as it does for two real hands.
 *
 * `InteractionController` raycasts hover with a 3 m reach (hand-sized
 * distances make sense for a headset). A webcam looks at objects several
 * metres away, so the virtual hand's ray ORIGIN is moved forward along the
 * pointer ray to within `REACH_M` of the hit point; the direction is
 * unchanged so hit tests are identical.
 */
import * as THREE from 'three';
import type { SceneStore } from '@/core/api';
import { raycastProxies } from '@/core';
import type { Vec3 } from '@/core/types';
import type { HandState, InputState } from '@/xr/input';

export interface PointerRay {
  origin: Vec3;
  direction: Vec3;
}

/** Given a pointer position in normalized device coordinates (-1..1, y up), return the world ray. */
export type RayFromNdc = (ndcX: number, ndcY: number, out: PointerRay) => void;

/** World point the estimated depth sees at an NDC position (snapped to the surface below), or null. */
export type DepthPick = (ndcX: number, ndcY: number) => Vec3 | null;

export interface PointerInputOptions {
  /** Element that receives pointer events (the overlay canvas). */
  element: HTMLElement;
  store: SceneStore;
  rayFromNdc: RayFromNdc;
  depthPick?: DepthPick;
  /**
   * Extra elements whose pointer events also drive the adapter (the app passes the container so
   * events dispatched to the passthrough video / stereo display canvas under the overlay count).
   * Coordinates are always taken relative to `element`; events that already hit `element` are
   * handled once.
   */
  extraTargets?: HTMLElement[];
  /** Depth (m) along the ray for the grab point when nothing is under the pointer. */
  defaultDepthM?: number;
  /** Metres of lift per wheel notch (100 delta units). */
  wheelLiftPerNotchM?: number;
  /**
   * A primary-pointer press released within `TAP_MAX_NDC` / `TAP_MAX_MS` of where it started
   * (a click, not a drag), reported after the release edge was queued. The app decides what
   * a tap on empty space means (click-to-detect a real object).
   */
  onTap?: (ndcX: number, ndcY: number) => void;
}

/** A press that ends this close (NDC) and this soon after it began is a tap. */
const TAP_MAX_NDC = 0.03;
const TAP_MAX_MS = 700;

/** The controller hovers within 3 m of the ray origin; keep the origin well inside that. */
const REACH_M = 1.0;
const HOVER_MAX_DISTANCE_M = 30;
const DEFAULT_DEPTH_M = 2.5;
const WHEEL_LIFT_PER_NOTCH_M = 0.05;
const MAX_LIFT_M = 2.5;
/** Drag guards (owner report: a grazing plane hit sent a cube to z = -8.6 m). */
const MAX_DRAG_DISTANCE_M = 6;
const DRAG_DISTANCE_FACTOR = 1.5;
const MAX_STEP_M = 0.5;

function makeHandState(): HandState {
  return {
    active: false,
    confidence: 0,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    pinching: false,
    selectStart: false,
    selectEnd: false,
    ray: { origin: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, -1) },
    source: 'none',
    wristPosition: new THREE.Vector3(),
    wristQuaternion: new THREE.Quaternion(),
    palmNormal: new THREE.Vector3(),
  };
}

interface PointerEventRecord {
  kind: 'down' | 'move' | 'up';
  ndcX: number;
  ndcY: number;
}

interface PointerTrack {
  pointerId: number;
  /** NDC applied on the last update. */
  ndcX: number;
  ndcY: number;
  /** Queued events, drained one phase per update. */
  queue: PointerEventRecord[];
  down: boolean;
  /** Height of the drag plane while pressed (world y), null while hovering. */
  planeY: number | null;
  /** Distance camera->grab point at grab start; drag hits are clamped relative to it. */
  grabDistance: number;
  /** Depth along the ray used when the plane cannot be hit. */
  fallbackDepth: number;
  /** Last grab point handed to the controller (for the per-update step clamp). */
  lastPoint: Vec3 | null;
  /** Height of the grab point above the surface the depth saw under it at grab start. */
  grabOffsetY: number;
  /** Touch pointers vanish on lift (no hover); a mouse keeps hovering. */
  touch: boolean;
  /** True once the track saw its 'up' and has no more queued events. */
  finished: boolean;
  /** Where/when the press began (tap detection). */
  downNdcX: number;
  downNdcY: number;
  downAt: number;
}

function makeTrack(pointerId: number, touch: boolean): PointerTrack {
  return { pointerId, ndcX: 0, ndcY: 0, queue: [], down: false, planeY: null, grabDistance: DEFAULT_DEPTH_M, fallbackDepth: DEFAULT_DEPTH_M, lastPoint: null, grabOffsetY: 0, touch, finished: false, downNdcX: 0, downNdcY: 0, downAt: 0 };
}

/**
 * Where the pointer ray meets the horizontal plane `y = planeY`, or null if the
 * ray is parallel to it or the plane is behind the camera. Exported for tests.
 */
export function intersectPlaneY(ray: PointerRay, planeY: number): Vec3 | null {
  const dy = ray.direction.y;
  if (Math.abs(dy) < 1e-6) return null;
  const t = (planeY - ray.origin.y) / dy;
  if (t <= 0) return null;
  return {
    x: ray.origin.x + ray.direction.x * t,
    y: planeY,
    z: ray.origin.z + ray.direction.z * t,
  };
}

/** Clamp `point` to at most `maxDist` from `origin` along the origin->point direction. Exported for tests. */
export function clampDistance(origin: Vec3, point: Vec3, maxDist: number): Vec3 {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dz = point.z - origin.z;
  const d = Math.hypot(dx, dy, dz);
  if (d <= maxDist || d < 1e-9) return point;
  const k = maxDist / d;
  return { x: origin.x + dx * k, y: origin.y + dy * k, z: origin.z + dz * k };
}

/** Limit the move from `prev` to `next` to `maxStep` metres. Exported for tests. */
export function clampStep(prev: Vec3 | null, next: Vec3, maxStep: number): Vec3 {
  if (!prev) return next;
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const dz = next.z - prev.z;
  const d = Math.hypot(dx, dy, dz);
  if (d <= maxStep) return next;
  const k = maxStep / d;
  return { x: prev.x + dx * k, y: prev.y + dy * k, z: prev.z + dz * k };
}

export class PointerInputAdapter {
  /** Extra reach around proxies for hover (metres); mirrors InteractionController.pickPadM. */
  pickPadM = 0;
  readonly state: InputState = { left: makeHandState(), right: makeHandState() };

  /** World point under the primary pointer on the last update (hit point or default depth), for spawning/diagnostics. */
  readonly pointerWorld = new THREE.Vector3();
  /** Object id under the primary pointer on the last update. */
  hoverId: string | null = null;
  /** Wheel-driven lift applied to the drag plane (m). */
  liftM = 0;
  /** NDC of the primary pointer on the last update; kept after the pointer leaves the canvas (0,0 before any event). */
  lastNdcX = 0;
  lastNdcY = 0;
  /** performance.now() of the last primary pointer event; -Infinity before any. */
  lastPointerAt = -Infinity;

  /** The overlay canvas the adapter listens on (tests dispatch pointer events here, not on the video). */
  readonly element: HTMLElement;
  private readonly extraTargets: HTMLElement[];
  private readonly store: SceneStore;
  private readonly rayFromNdc: RayFromNdc;
  private readonly depthPick: DepthPick | null;
  private readonly defaultDepth: number;
  private readonly wheelLift: number;
  private readonly tracks: PointerTrack[] = [];
  private readonly ray: PointerRay = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };
  private disposed = false;

  private readonly onTap: ((ndcX: number, ndcY: number) => void) | undefined;

  constructor(opts: PointerInputOptions) {
    this.element = opts.element;
    this.onTap = opts.onTap;
    this.extraTargets = (opts.extraTargets ?? []).filter((el) => el !== opts.element);
    this.store = opts.store;
    this.rayFromNdc = opts.rayFromNdc;
    this.depthPick = opts.depthPick ?? null;
    this.defaultDepth = opts.defaultDepthM ?? DEFAULT_DEPTH_M;
    this.wheelLift = opts.wheelLiftPerNotchM ?? WHEEL_LIFT_PER_NOTCH_M;

    this.element.style.touchAction = 'none';
    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('pointermove', this.onPointerMove);
    this.element.addEventListener('pointerup', this.onPointerUp);
    this.element.addEventListener('pointercancel', this.onPointerUp);
    this.element.addEventListener('pointerleave', this.onPointerLeave);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('contextmenu', this.onContextMenu);
    for (const el of this.extraTargets) {
      el.addEventListener('pointerdown', this.onExtraDown);
      el.addEventListener('pointermove', this.onExtraMove);
      el.addEventListener('pointerup', this.onExtraUp);
      el.addEventListener('pointercancel', this.onExtraUp);
    }
  }

  /** True when the event was already handled by the overlay's own listener (it bubbled up from `element`). */
  private fromOverlay(e: Event): boolean {
    return e.target === this.element || (e.composedPath?.() ?? []).includes(this.element);
  }

  private readonly onExtraDown = (e: PointerEvent): void => {
    if (!this.fromOverlay(e)) this.onPointerDown(e);
  };

  private readonly onExtraMove = (e: PointerEvent): void => {
    if (!this.fromOverlay(e)) this.onPointerMove(e);
  };

  private readonly onExtraUp = (e: PointerEvent): void => {
    if (!this.fromOverlay(e)) this.onPointerUp(e);
  };

  /**
   * Sticky drag ("Move" in the context menu): the object follows the mouse without a held
   * button; the next press drops it (that press and its release do not start a new drag).
   */
  private sticky = false;

  beginStickyDrag(clientX: number, clientY: number): void {
    this.inject('down', clientX, clientY, 1, false);
    this.sticky = true;
  }

  get stickyDrag(): boolean {
    return this.sticky;
  }

  /** Programmatic pointer injection (tests, voice "grab that"): coordinates in CSS pixels relative to the element. */
  inject(kind: 'down' | 'move' | 'up', clientX: number, clientY: number, pointerId = 1, touch = false): void {
    const rect = this.element.getBoundingClientRect();
    this.handle(kind, pointerId, touch, clientX - rect.left, clientY - rect.top, rect.width, rect.height);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const rect = this.element.getBoundingClientRect();
    if (this.sticky) {
      // Drop the sticky-dragged object here; swallow this press (its 'up' is ignored below).
      this.sticky = false;
      this.stickyRelease = true;
      this.handle('up', 1, false, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
      e.preventDefault();
      return;
    }
    try {
      this.element.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture unsupported (or synthetic event); dragging still works while the pointer stays over the canvas.
    }
    this.handle('down', e.pointerId, e.pointerType === 'touch', e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    e.preventDefault();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.element.getBoundingClientRect();
    this.handle('move', e.pointerId, e.pointerType === 'touch', e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
  };

  private stickyRelease = false;

  private readonly onPointerUp = (e: PointerEvent): void => {
    const rect = this.element.getBoundingClientRect();
    if (this.stickyRelease) {
      this.stickyRelease = false;
      return;
    }
    this.handle('up', e.pointerId, e.pointerType === 'touch', e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    // A hovering mouse leaving the canvas stops hovering; a pressed pointer is captured and keeps dragging.
    const track = this.tracks.find((t) => t.pointerId === e.pointerId);
    if (track && !track.down && track.queue.length === 0) this.removeTrack(track);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    const primary = this.tracks[0];
    if (!primary || !primary.down) return;
    e.preventDefault();
    const notches = -e.deltaY / 100;
    this.liftM = Math.max(-MAX_LIFT_M, Math.min(MAX_LIFT_M, this.liftM + notches * this.wheelLift));
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private handle(kind: 'down' | 'move' | 'up', pointerId: number, touch: boolean, x: number, y: number, width: number, height: number): void {
    if (this.disposed || width <= 0 || height <= 0) return;
    let track = this.tracks.find((t) => t.pointerId === pointerId);
    if (!track) {
      // At most two pointers are meaningful (right hand + left hand).
      if (kind === 'up') return;
      if (this.tracks.length >= 2) return;
      track = makeTrack(pointerId, touch);
      this.tracks.push(track);
    }
    const ndcX = (x / width) * 2 - 1;
    const ndcY = -((y / height) * 2 - 1);
    if (track === this.tracks[0]) {
      this.lastNdcX = ndcX;
      this.lastNdcY = ndcY;
      this.lastPointerAt = performance.now();
    }
    if (kind === 'move') {
      // Coalesce consecutive moves so the queue never grows with mouse-move spam.
      const last = track.queue[track.queue.length - 1];
      if (last && last.kind === 'move') {
        last.ndcX = ndcX;
        last.ndcY = ndcY;
        return;
      }
    }
    track.queue.push({ kind, ndcX, ndcY });
    if (kind === 'down') {
      track.downNdcX = ndcX;
      track.downNdcY = ndcY;
      track.downAt = performance.now();
    } else if (kind === 'up' && track === this.tracks[0] && this.onTap) {
      const moved = Math.hypot(ndcX - track.downNdcX, ndcY - track.downNdcY);
      if (moved <= TAP_MAX_NDC && performance.now() - track.downAt <= TAP_MAX_MS) this.onTap(ndcX, ndcY);
    }
  }

  private removeTrack(track: PointerTrack): void {
    const i = this.tracks.indexOf(track);
    if (i >= 0) this.tracks.splice(i, 1);
  }

  /**
   * Drain ONE phase of a track's queue: a 'down' (alone), a run of 'move's
   * (collapsed to the last), or an 'up' (alone). Returns the edge produced.
   */
  private drain(track: PointerTrack): 'down' | 'up' | null {
    const first = track.queue[0];
    if (!first) return null;
    if (first.kind === 'down') {
      track.queue.shift();
      track.ndcX = first.ndcX;
      track.ndcY = first.ndcY;
      if (track.down) return null; // duplicate down
      track.down = true;
      return 'down';
    }
    if (first.kind === 'up') {
      track.queue.shift();
      track.ndcX = first.ndcX;
      track.ndcY = first.ndcY;
      if (!track.down) return null;
      track.down = false;
      return 'up';
    }
    let last = first;
    while (track.queue[0] && track.queue[0].kind === 'move') last = track.queue.shift()!;
    track.ndcX = last.ndcX;
    track.ndcY = last.ndcY;
    return null;
  }

  /** Call once per rendered frame, before `InteractionController.update(state, ...)`. */
  update(): void {
    const primary = this.tracks[0];
    const secondary = this.tracks[1];
    this.updateHand(this.state.right, primary, true);
    this.updateHand(this.state.left, secondary, false);

    // Drop released secondary pointers once their selectEnd edge has been delivered.
    for (let i = this.tracks.length - 1; i >= 1; i--) {
      const t = this.tracks[i]!;
      if (!t.down && t.queue.length === 0) this.tracks.splice(i, 1);
    }
    if (primary && !primary.down && primary.queue.length === 0) {
      // Reset the lift once a drag ends so the next grab starts on its own plane.
      this.liftM = 0;
      // A touch pointer that lifted is gone (no hover); a mouse keeps hovering.
      if (primary.touch) this.removeTrack(primary);
    }
  }

  private updateHand(hand: HandState, track: PointerTrack | undefined, primary: boolean): void {
    hand.selectStart = false;
    hand.selectEnd = false;
    if (!track) {
      hand.active = false;
      hand.pinching = false;
      hand.confidence = 0;
      hand.source = 'none';
      if (primary) this.hoverId = null;
      return;
    }

    const edge = this.drain(track);
    const ray = this.ray;
    this.rayFromNdc(track.ndcX, track.ndcY, ray);

    // Where along the ray is the grab point this frame?
    let point: Vec3 | null = null;
    let hitId: string | null = null;
    const dragging = track.down && edge !== 'down' && track.planeY !== null;
    if (dragging) {
      const maxDrag = Math.min(MAX_DRAG_DISTANCE_M, track.grabDistance * DRAG_DISTANCE_FACTOR);
      point = this.depthPick ? this.depthPick(track.ndcX, track.ndcY) : null;
      // A depth hit much farther than the grab (the pointer crossed a stereo hole and the pick
      // fell through to the floor metres away) is not where the user is dragging: keep the
      // object on its support plane instead of running away to that hit.
      if (point && Math.hypot(point.x - ray.origin.x, point.y - ray.origin.y, point.z - ray.origin.z) > maxDrag) point = null;
      if (point) {
        // Depth hit: the grab point rides at the same height above that surface as it was
        // grabbed above the surface under it, so the object glides onto a desk or bed.
        point = { x: point.x, y: point.y + track.grabOffsetY + this.liftM, z: point.z };
      } else {
        point = intersectPlaneY(ray, (track.planeY ?? 0) + this.liftM);
        if (!point) {
          point = {
            x: ray.origin.x + ray.direction.x * track.fallbackDepth,
            y: ray.origin.y + ray.direction.y * track.fallbackDepth,
            z: ray.origin.z + ray.direction.z * track.fallbackDepth,
          };
        }
        point = clampDistance(ray.origin, point, maxDrag);
      }
      point = clampStep(track.lastPoint, point, MAX_STEP_M);
    } else {
      const hits = raycastProxies(this.store.current, ray.origin, ray.direction, HOVER_MAX_DISTANCE_M, this.pickPadM);
      const hit = hits[0];
      if (hit) {
        hitId = hit.objectId;
        point = hit.point;
        track.fallbackDepth = hit.distance;
      } else {
        // Nothing under the pointer: rest the hand on what the depth sees, the ground plane, or the default depth.
        point = this.depthPick ? this.depthPick(track.ndcX, track.ndcY) : null;
        if (!point) point = intersectPlaneY(ray, 0);
        if (!point) {
          point = {
            x: ray.origin.x + ray.direction.x * this.defaultDepth,
            y: ray.origin.y + ray.direction.y * this.defaultDepth,
            z: ray.origin.z + ray.direction.z * this.defaultDepth,
          };
        }
        track.fallbackDepth = this.defaultDepth;
      }
      if (edge === 'down') {
        // Grab starts here: remember the plane the drag slides on and how far away it was.
        track.planeY = point.y;
        track.grabDistance = Math.max(0.3, Math.hypot(point.x - ray.origin.x, point.y - ray.origin.y, point.z - ray.origin.z));
        const under = this.depthPick ? this.depthPick(track.ndcX, track.ndcY) : null;
        track.grabOffsetY = Math.max(0, point.y - (under ? under.y : 0));
        track.lastPoint = null;
      }
    }
    track.lastPoint = point;

    hand.active = true;
    hand.confidence = 1;
    hand.source = 'controller';
    hand.position.set(point.x, point.y, point.z);
    hand.quaternion.identity();
    hand.pinching = track.down;
    if (edge === 'down') hand.selectStart = true;
    if (edge === 'up') {
      hand.selectEnd = true;
      track.planeY = null;
    }

    // Ray for hover tests: same direction, origin pulled forward to within the controller's reach.
    const dist = Math.hypot(point.x - ray.origin.x, point.y - ray.origin.y, point.z - ray.origin.z);
    const back = Math.max(0, dist - REACH_M);
    hand.ray.origin.set(
      ray.origin.x + ray.direction.x * back,
      ray.origin.y + ray.direction.y * back,
      ray.origin.z + ray.direction.z * back,
    );
    hand.ray.direction.set(ray.direction.x, ray.direction.y, ray.direction.z);

    if (primary) {
      this.pointerWorld.set(point.x, point.y, point.z);
      this.hoverId = hitId;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerUp);
    this.element.removeEventListener('pointerleave', this.onPointerLeave);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    for (const el of this.extraTargets) {
      el.removeEventListener('pointerdown', this.onExtraDown);
      el.removeEventListener('pointermove', this.onExtraMove);
      el.removeEventListener('pointerup', this.onExtraUp);
      el.removeEventListener('pointercancel', this.onExtraUp);
    }
    this.tracks.length = 0;
  }
}
