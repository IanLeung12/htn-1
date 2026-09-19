/**
 * Proxy physics: simple, believable settling and collision for editable
 * objects, using their existing proxies (never raw splats). Pure TS, no
 * DOM/three.js.
 *
 * Design (see reality-editor-canonical-architecture.md "physics uses simple,
 * believable proxies" and reality-editor-runtime-budget.md "physics clock:
 * fixed step; publish coherent snapshots"):
 *
 * - `step()` reads a SceneSnapshot and returns a batch of moves; it never
 *   touches the store. The caller (src/app/physics-bridge.ts) commits moves
 *   through the store as `{kind:'move'}` intents with source 'system'.
 * - Fixed timestep with an accumulator; at most `maxSubsteps` substeps run
 *   per call so a huge dt (e.g. a stall) cannot make objects tunnel or the
 *   simulation explode. Leftover accumulated time carries to the next call.
 * - Only non-kinematic, visible, approved objects that are not the current
 *   preview/grab target are simulated. Kinematic objects and objects whose
 *   `origin` is 'physical' (the real furniture proxies) are immovable when
 *   resolving object-vs-object collisions; a grabbed/previewed object is
 *   likewise never displaced by physics.
 * - Rotation is never touched; this is a translation-only proxy simulation.
 */
import type { EditableObject, Pose, ProxyShape, SceneSnapshot, Vec3 } from './types';
import { distance } from './math';

export interface PhysicsOptions {
  /**
   * Horizontal surfaces support an object whose footprint overlaps their box grown by this
   * margin. Estimated surface extents (depth cameras, RANSAC) stop at the last observed point,
   * e.g. a desk box ends where the sensor's minimum range starts; without a margin an object
   * placed just past that edge falls through the desk. Default 0.15 m.
   */
  supportMarginM?: number;
  /**
   * A support whose top has crept up to this far above an object's bottom (a smoothed,
   * re-estimated table plane rising a centimetre) still supports it and pushes it up, instead
   * of being skipped as "above the object" so the object falls through. Default 0.06 m.
   */
  supportPenetrationM?: number;
  /** Fixed physics step, ms. Default 1000/60. */
  stepMs?: number;
  /** Max fixed substeps run per step() call. Default 4. */
  maxSubsteps?: number;
  /** m/s^2. Default 9.81. */
  gravity?: number;
  /** Speed (m/s) below which a step counts toward the sleep streak. Default 0.02. */
  sleepSpeedThreshold?: number;
  /** Consecutive low-speed steps required to sleep. Default 10. */
  sleepSteps?: number;
  /** Position delta (m) beyond which an externally-changed currentPose resets velocity/sleep. Default 0.001 (1mm). */
  wakeMoveEpsilonM?: number;
  /** Position delta (m) beyond which a move is reported from a step() call. Default 0.0005 (0.5mm). */
  moveReportEpsilonM?: number;
}

export interface PhysicsMove {
  objectId: string;
  pose: Pose;
}

export interface PhysicsResult {
  moves: PhysicsMove[];
  sleeping: string[];
  awake: string[];
}

export interface ProxyPhysics {
  step(snapshot: SceneSnapshot, dtMs: number, now: number): PhysicsResult;
  wake(objectId: string): void;
  reset(objectId: string): void;
  isSleeping(objectId: string): boolean;
}

interface Body {
  velocity: Vec3;
  /** Last position physics observed/produced for this object (baseline for external-move detection). */
  lastKnownPos: Vec3;
  sleeping: boolean;
  lowSpeedStreak: number;
}

interface WorkingObj {
  id: string;
  pos: Vec3;
  he: Vec3;
  /** True if this object is a gravity/settle candidate this call (isCandidate). */
  simulated: boolean;
  /** True if kinematic or origin === 'physical' (immovable furniture proxy). */
  immovable: boolean;
}

function proxyHalfExtents(proxy: ProxyShape): Vec3 {
  if (proxy.kind === 'box') return proxy.halfExtents;
  if (proxy.kind === 'sphere') return { x: proxy.radius, y: proxy.radius, z: proxy.radius };
  return { x: proxy.radius, y: proxy.halfHeight + proxy.radius, z: proxy.radius };
}

export function createProxyPhysics(opts?: PhysicsOptions): ProxyPhysics {
  const stepMs = opts?.stepMs ?? 1000 / 60;
  const maxSubsteps = opts?.maxSubsteps ?? 4;
  const gravity = opts?.gravity ?? 9.81;
  const sleepSpeedThreshold = opts?.sleepSpeedThreshold ?? 0.02;
  const sleepSteps = opts?.sleepSteps ?? 10;
  const wakeMoveEpsilonM = opts?.wakeMoveEpsilonM ?? 0.001;
  const moveReportEpsilonM = opts?.moveReportEpsilonM ?? 0.0005;
  const supportMarginM = opts?.supportMarginM ?? 0.15;
  const supportPenetrationM = opts?.supportPenetrationM ?? 0.06;

  const bodies = new Map<string, Body>();
  let accumulatorMs = 0;

  function wake(objectId: string): void {
    const b = bodies.get(objectId);
    if (b) {
      b.sleeping = false;
      b.lowSpeedStreak = 0;
    }
  }

  function reset(objectId: string): void {
    bodies.delete(objectId);
  }

  function isSleeping(objectId: string): boolean {
    return bodies.get(objectId)?.sleeping ?? false;
  }

  function isCandidate(o: EditableObject, snapshot: SceneSnapshot): boolean {
    return o.visible && o.approved && !o.physical.kinematic && snapshot.preview?.objectId !== o.id;
  }

  function step(snapshot: SceneSnapshot, dtMs: number, _now: number): PhysicsResult {
    void _now;
    if (dtMs > 0) accumulatorMs += dtMs;

    const objects = Object.values(snapshot.objects).filter((o) => o.visible);
    const candidates = objects.filter((o) => isCandidate(o, snapshot));

    const working = new Map<string, WorkingObj>();
    for (const o of objects) {
      working.set(o.id, {
        id: o.id,
        pos: { ...o.currentPose.position },
        he: proxyHalfExtents(o.collisionProxy),
        simulated: isCandidate(o, snapshot),
        immovable: o.physical.kinematic || o.origin === 'physical',
      });
    }

    // Reconcile body state: create fresh, or detect an external move (the
    // user moved the object outside of physics) and reset velocity/sleep.
    for (const o of candidates) {
      let body = bodies.get(o.id);
      if (!body) {
        body = { velocity: { x: 0, y: 0, z: 0 }, lastKnownPos: { ...o.currentPose.position }, sleeping: false, lowSpeedStreak: 0 };
        bodies.set(o.id, body);
      } else if (distance(o.currentPose.position, body.lastKnownPos) > wakeMoveEpsilonM) {
        body.velocity = { x: 0, y: 0, z: 0 };
        body.sleeping = false;
        body.lowSpeedStreak = 0;
        body.lastKnownPos = { ...o.currentPose.position };
      }
    }

    // Floor: the largest 'floor' surface's top, else y=0.
    let floorY = 0;
    let floorArea = -Infinity;
    for (const s of Object.values(snapshot.surfaces)) {
      if (s.label !== 'floor') continue;
      const area = (s.aabb.max.x - s.aabb.min.x) * (s.aabb.max.z - s.aabb.min.z);
      if (area > floorArea) {
        floorArea = area;
        floorY = s.aabb.max.y;
      }
    }

    let substeps = 0;
    while (accumulatorMs >= stepMs && substeps < maxSubsteps) {
      runSubstep(stepMs / 1000, snapshot, candidates, working, floorY);
      accumulatorMs -= stepMs;
      substeps += 1;
    }

    const moves: PhysicsMove[] = [];
    const sleeping: string[] = [];
    const awake: string[] = [];

    for (const o of candidates) {
      const body = bodies.get(o.id);
      const w = working.get(o.id);
      if (!body || !w) continue;

      if (body.sleeping) sleeping.push(o.id);
      else awake.push(o.id);

      const moved = distance(o.currentPose.position, w.pos) > moveReportEpsilonM;
      if (moved) {
        moves.push({ objectId: o.id, pose: { position: { ...w.pos }, rotation: o.currentPose.rotation } });
      }
      body.lastKnownPos = { ...w.pos };
    }

    return { moves, sleeping, awake };
  }

  function runSubstep(
    dt: number,
    snapshot: SceneSnapshot,
    candidates: EditableObject[],
    working: Map<string, WorkingObj>,
    floorY: number,
  ): void {
    const startBottom = new Map<string, number>();
    for (const o of candidates) {
      const w = working.get(o.id);
      if (w) startBottom.set(o.id, w.pos.y - w.he.y);
    }

    // 1. Gravity integration for awake candidates.
    for (const o of candidates) {
      const body = bodies.get(o.id);
      const w = working.get(o.id);
      if (!body || !w || body.sleeping) continue;
      body.velocity.y -= gravity * dt;
      w.pos.x += body.velocity.x * dt;
      w.pos.y += body.velocity.y * dt;
      w.pos.z += body.velocity.z * dt;
    }

    // 2. Support / settle onto the highest surface or object top below the footprint.
    for (const o of candidates) {
      const body = bodies.get(o.id);
      const w = working.get(o.id);
      if (!body || !w || body.sleeping) continue;

      const before = startBottom.get(o.id) ?? w.pos.y - w.he.y;
      const minX = w.pos.x - w.he.x;
      const maxX = w.pos.x + w.he.x;
      const minZ = w.pos.z - w.he.z;
      const maxZ = w.pos.z + w.he.z;

      let supportY = -Infinity;

      for (const s of Object.values(snapshot.surfaces)) {
        if (s.orientation !== 'horizontal') continue;
        if (s.aabb.max.y > before + supportPenetrationM) continue; // must already be at/below the object (small creep allowed)
        const m = s.label === 'floor' ? 0 : supportMarginM;
        if (minX > s.aabb.max.x + m || maxX < s.aabb.min.x - m || minZ > s.aabb.max.z + m || maxZ < s.aabb.min.z - m) continue;
        if (s.aabb.max.y > supportY) supportY = s.aabb.max.y;
      }

      for (const other of working.values()) {
        if (other.id === o.id) continue;
        const otherTop = other.pos.y + other.he.y;
        if (otherTop > before + supportPenetrationM) continue;
        const oMinX = other.pos.x - other.he.x;
        const oMaxX = other.pos.x + other.he.x;
        const oMinZ = other.pos.z - other.he.z;
        const oMaxZ = other.pos.z + other.he.z;
        if (minX > oMaxX || maxX < oMinX || minZ > oMaxZ || maxZ < oMinZ) continue;
        if (otherTop > supportY) supportY = otherTop;
      }

      const newBottom = w.pos.y - w.he.y;
      if (supportY > -Infinity && newBottom <= supportY + 1e-6) {
        w.pos.y = supportY + w.he.y;
        const obj = snapshot.objects[o.id] as EditableObject;
        const impactSpeed = Math.max(0, -body.velocity.y);
        let vy = impactSpeed * obj.physical.restitution;
        if (vy < sleepSpeedThreshold) vy = 0;
        body.velocity.y = vy;
        const frictionKeep = 1 - Math.min(1, Math.max(0, obj.physical.friction));
        body.velocity.x *= frictionKeep;
        body.velocity.z *= frictionKeep;
      }

      const clampedBottom = w.pos.y - w.he.y;
      if (clampedBottom < floorY - 1e-9) {
        w.pos.y = floorY + w.he.y;
        body.velocity.y = 0;
      }
    }

    // 3. Object-vs-object AABB collision resolution (single pass; simple and stable, not exact).
    const ids = Array.from(working.keys());
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = working.get(ids[i] as string);
        const b = working.get(ids[j] as string);
        if (a && b) resolvePair(a, b, snapshot);
      }
    }

    // 4. Sleep bookkeeping.
    for (const o of candidates) {
      const body = bodies.get(o.id);
      if (!body || body.sleeping) continue;
      const speed = Math.sqrt(body.velocity.x ** 2 + body.velocity.y ** 2 + body.velocity.z ** 2);
      if (speed < sleepSpeedThreshold) {
        body.lowSpeedStreak += 1;
        if (body.lowSpeedStreak >= sleepSteps) {
          body.sleeping = true;
          body.velocity = { x: 0, y: 0, z: 0 };
        }
      } else {
        body.lowSpeedStreak = 0;
      }
    }
  }

  function resolvePair(a: WorkingObj, b: WorkingObj, snapshot: SceneSnapshot): void {
    const aMin: Vec3 = { x: a.pos.x - a.he.x, y: a.pos.y - a.he.y, z: a.pos.z - a.he.z };
    const aMax: Vec3 = { x: a.pos.x + a.he.x, y: a.pos.y + a.he.y, z: a.pos.z + a.he.z };
    const bMin: Vec3 = { x: b.pos.x - b.he.x, y: b.pos.y - b.he.y, z: b.pos.z - b.he.z };
    const bMax: Vec3 = { x: b.pos.x + b.he.x, y: b.pos.y + b.he.y, z: b.pos.z + b.he.z };

    const overlaps =
      aMin.x <= bMax.x && aMax.x >= bMin.x &&
      aMin.y <= bMax.y && aMax.y >= bMin.y &&
      aMin.z <= bMax.z && aMax.z >= bMin.z;
    if (!overlaps) return;

    // Grabbed/previewed and kinematic/physical-origin objects are immovable.
    const movableA = a.simulated && !a.immovable;
    const movableB = b.simulated && !b.immovable;
    if (!movableA && !movableB) return;

    const penX = Math.min(aMax.x, bMax.x) - Math.max(aMin.x, bMin.x);
    const penY = Math.min(aMax.y, bMax.y) - Math.max(aMin.y, bMin.y);
    const penZ = Math.min(aMax.z, bMax.z) - Math.max(aMin.z, bMin.z);

    let axis: keyof Vec3 = 'x';
    let pen = penX;
    if (penY < pen) {
      axis = 'y';
      pen = penY;
    }
    if (penZ < pen) {
      axis = 'z';
      pen = penZ;
    }
    pen += 1e-4; // fully separate, avoid re-triggering next substep

    const dir = a.pos[axis] <= b.pos[axis] ? -1 : 1;

    const objA = snapshot.objects[a.id] as EditableObject;
    const objB = snapshot.objects[b.id] as EditableObject;
    const massA = Math.max(0.001, objA.physical.massKg);
    const massB = Math.max(0.001, objB.physical.massKg);

    let pushA = 0;
    let pushB = 0;
    if (movableA && movableB) {
      const total = massA + massB;
      pushA = pen * (massB / total); // lighter object yields more
      pushB = pen * (massA / total);
    } else if (movableA) {
      pushA = pen;
    } else if (movableB) {
      pushB = pen;
    }

    if (movableA && pushA > 0) {
      a.pos[axis] += dir * pushA;
      const bodyA = bodies.get(a.id);
      if (bodyA) {
        bodyA.velocity[axis] = 0;
        wake(a.id);
      }
    }
    if (movableB && pushB > 0) {
      b.pos[axis] += -dir * pushB;
      const bodyB = bodies.get(b.id);
      if (bodyB) {
        bodyB.velocity[axis] = 0;
        wake(b.id);
      }
    }
  }

  return { step, wake, reset, isSleeping };
}

export default createProxyPhysics;
