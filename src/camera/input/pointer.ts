/**
 * PointerInputAdapter: mouse/touch on the overlay canvas -> the same
 * `InputState` (src/xr/input.ts) that hand tracking produces, so the
 * unchanged `InteractionController` (src/app/interaction.ts) drives hover,
 * grab, move, and two-hand scale/yaw through the resolver.
 *
 * Mapping (see docs/general-camera/architecture.md, "InputAdapter"):
 *  - The primary pointer is the RIGHT hand. Its ray is the pointer ray
 *    through the camera; its "grab point" rides that ray at the depth of the
 *    object under the pointer (or a default depth when nothing is hit).
 *  - Pressing = pinch. `selectStart`/`selectEnd` are true for exactly one
 *    `update()` call each, like real pinch edges.
 *  - While pressed, the grab point slides along the HORIZONTAL plane at the
 *    height it was grabbed at (plus a wheel-driven lift), so a dragged object
 *    glides over the floor/table it sits on instead of flying along the ray.
 *  - A second touch is the LEFT hand, pinching, also on that plane: the
 *    controller's two-hand mode then turns finger distance/angle into
 *    scale/yaw exactly as it does for two real hands.
 *
 * `InteractionController` raycasts hover with a 3 m reach (hand-sized
 * distances make sense for a headset). A webcam looks at objects several
 * metres away, so the virtual hand's ray ORIGIN is moved forward along the
 * pointer ray to within `REACH_M` of the hit point; the direction is
 * unchanged so hit tests are identical. Hover for objects further than the
 * controller's reach would otherwise be impossible.
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

export interface PointerInputOptions {
  /** Element that receives pointer events (the overlay canvas). */
  element: HTMLElement;
  store: SceneStore;
  rayFromNdc: RayFromNdc;
  /** Depth (m) along the ray for the grab point when nothing is under the pointer. */
  defaultDepthM?: number;
  /** Metres of lift per wheel notch (100 delta units). */
  wheelLiftPerNotchM?: number;
}

/** The controller hovers within 3 m of the ray origin; keep the origin well inside that. */
const REACH_M = 1.0;
const HOVER_MAX_DISTANCE_M = 30;
const DEFAULT_DEPTH_M = 2.5;
const WHEEL_LIFT_PER_NOTCH_M = 0.05;
const MAX_LIFT_M = 2.5;

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

interface PointerTrack {
  pointerId: number;
  ndcX: number;
  ndcY: number;
  down: boolean;
  /** Edge flags consumed by the next update(). */
  pendingDown: boolean;
  pendingUp: boolean;
  /** Height of the drag plane while pressed (world y), null while hovering. */
  planeY: number | null;
  /** Depth along the ray used when the plane cannot be hit. */
  fallbackDepth: number;
  /** Touch pointers vanish on lift (no hover); a mouse keeps hovering. */
  touch: boolean;
}

function makeTrack(pointerId: number, touch: boolean): PointerTrack {
  return { pointerId, ndcX: 0, ndcY: 0, down: false, pendingDown: false, pendingUp: false, planeY: null, fallbackDepth: DEFAULT_DEPTH_M, touch };
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

export class PointerInputAdapter {
  readonly state: InputState = { left: makeHandState(), right: makeHandState() };

  /** World point under the primary pointer on the last update (hit point or default depth), for spawning/diagnostics. */
  readonly pointerWorld = new THREE.Vector3();
  /** Object id under the primary pointer on the last update. */
  hoverId: string | null = null;
  /** Wheel-driven lift applied to the drag plane (m). */
  liftM = 0;
  /** NDC of the primary pointer on the last update (0,0 before any event). */
  lastNdcX = 0;
  lastNdcY = 0;

  private readonly element: HTMLElement;
  private readonly store: SceneStore;
  private readonly rayFromNdc: RayFromNdc;
  private readonly defaultDepth: number;
  private readonly wheelLift: number;
  private readonly tracks: PointerTrack[] = [];
  private readonly ray: PointerRay = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };
  private disposed = false;

  constructor(opts: PointerInputOptions) {
    this.element = opts.element;
    this.store = opts.store;
    this.rayFromNdc = opts.rayFromNdc;
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
  }

  /** Programmatic pointer injection (tests, voice "grab that"): coordinates in CSS pixels relative to the element. */
  inject(kind: 'down' | 'move' | 'up', clientX: number, clientY: number, pointerId = 1, touch = false): void {
    const rect = this.element.getBoundingClientRect();
    this.handle(kind, pointerId, touch, clientX - rect.left, clientY - rect.top, rect.width, rect.height);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const rect = this.element.getBoundingClientRect();
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

  private readonly onPointerUp = (e: PointerEvent): void => {
    const rect = this.element.getBoundingClientRect();
    this.handle('up', e.pointerId, e.pointerType === 'touch', e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    // A hovering mouse leaving the canvas stops hovering; a pressed pointer is captured and keeps dragging.
    const track = this.tracks.find((t) => t.pointerId === e.pointerId);
    if (track && !track.down) this.removeTrack(track);
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
    track.ndcX = (x / width) * 2 - 1;
    track.ndcY = -((y / height) * 2 - 1);
    if (kind === 'down') {
      if (!track.down) {
        track.down = true;
        track.pendingDown = true;
      }
    } else if (kind === 'up') {
      if (track.down) {
        track.down = false;
        track.pendingUp = true;
      }
    }
  }

  private removeTrack(track: PointerTrack): void {
    const i = this.tracks.indexOf(track);
    if (i >= 0) this.tracks.splice(i, 1);
  }

  /** Call once per rendered frame, before `InteractionController.update(state, ...)`. */
  update(): void {
    const primary = this.tracks[0];
    const secondary = this.tracks[1];
    this.updateHand(this.state.right, primary, true);
    this.updateHand(this.state.left, secondary, false);

    // Drop released secondary pointers once their selectEnd edge has been delivered.
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const t = this.tracks[i]!;
      if (!t.down && !t.pendingUp && !t.pendingDown && i > 0) this.tracks.splice(i, 1);
    }
    if (primary && !primary.down && !primary.pendingUp && !primary.pendingDown) {
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

    const ray = this.ray;
    this.rayFromNdc(track.ndcX, track.ndcY, ray);

    // Where along the ray is the grab point this frame?
    let point: Vec3 | null = null;
    let hitId: string | null = null;
    if (track.down && track.planeY !== null) {
      point = intersectPlaneY(ray, track.planeY + this.liftM);
      if (!point) {
        point = {
          x: ray.origin.x + ray.direction.x * track.fallbackDepth,
          y: ray.origin.y + ray.direction.y * track.fallbackDepth,
          z: ray.origin.z + ray.direction.z * track.fallbackDepth,
        };
      }
    } else {
      const hits = raycastProxies(this.store.current, ray.origin, ray.direction, HOVER_MAX_DISTANCE_M);
      const hit = hits[0];
      if (hit) {
        hitId = hit.objectId;
        point = hit.point;
        track.fallbackDepth = hit.distance;
      } else {
        // Nothing under the pointer: rest the hand on the floor plane if the ray reaches it, else at the default depth.
        point = intersectPlaneY(ray, 0);
        if (!point) {
          point = {
            x: ray.origin.x + ray.direction.x * this.defaultDepth,
            y: ray.origin.y + ray.direction.y * this.defaultDepth,
            z: ray.origin.z + ray.direction.z * this.defaultDepth,
          };
        }
        track.fallbackDepth = this.defaultDepth;
      }
      if (track.pendingDown) {
        // Grab starts here: remember the plane the drag slides on.
        track.planeY = point.y;
      }
    }

    hand.active = true;
    hand.confidence = 1;
    hand.source = 'controller';
    hand.position.set(point.x, point.y, point.z);
    hand.quaternion.identity();
    hand.pinching = track.down;
    if (track.pendingDown) {
      hand.selectStart = true;
      track.pendingDown = false;
    }
    if (track.pendingUp) {
      hand.selectEnd = true;
      track.pendingUp = false;
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
      this.lastNdcX = track.ndcX;
      this.lastNdcY = track.ndcY;
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
    this.tracks.length = 0;
  }
}
