import { describe, expect, it } from 'vitest';
import { createProxyPhysics } from '@/core/physics';
import { makeObject, makeSnapshot, makeSurface } from '@/core/fixtures';
import type { EditableObject, SceneSnapshot } from '@/core/types';

const STEP_MS = 1000 / 60;

function box(id: string, y: number, opts?: Partial<EditableObject>): EditableObject {
  return makeObject({
    id,
    origin: 'spawned',
    originalPose: { position: { x: 0, y, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    currentPose: { position: { x: 0, y, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    interactionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    collisionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    occlusionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    physical: { massKg: 1, friction: 0.5, restitution: 0.1, kinematic: false },
    approved: true,
    visible: true,
    ...opts,
  });
}

/** Run physics forward, committing each call's moves into the working snapshot, as the bridge would. */
function advance(
  physics: ReturnType<typeof createProxyPhysics>,
  snapshot: SceneSnapshot,
  totalMs: number,
  stepMs = STEP_MS,
) {
  let current = snapshot;
  let now = 0;
  let lastResult = physics.step(current, 0, now);
  const steps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < steps; i += 1) {
    now += stepMs;
    const result = physics.step(current, stepMs, now);
    lastResult = result;
    if (result.moves.length > 0) {
      const objects = { ...current.objects };
      for (const move of result.moves) {
        const existing = objects[move.objectId];
        if (existing) objects[move.objectId] = { ...existing, currentPose: move.pose };
      }
      current = { ...current, objects };
    }
  }
  return { snapshot: current, lastResult };
}

describe('createProxyPhysics', () => {
  it('supports an object whose footprint sits just past an estimated table edge (support margin)', () => {
    // A depth-camera desk box ends at the last observed point (z = -0.4 here, the sensor's
    // minimum range); a cube spawned at z = -0.33 overhangs that edge by 3 cm and must still
    // rest on the desk instead of falling through to the floor.
    const table = makeSurface({
      id: 'desk',
      label: 'table',
      orientation: 'horizontal',
      aabb: { min: { x: -1, y: 0.7, z: -2 }, max: { x: 1, y: 0.71, z: -0.4 } },
    });
    const obj = box('cube', 0.9);
    obj.currentPose.position.z = -0.33;
    obj.originalPose.position.z = -0.33;
    const snapshot = makeSnapshot({ objects: { cube: obj }, surfaces: { desk: table } });
    const { snapshot: final } = advance(createProxyPhysics(), snapshot, 1000);
    expect((final.objects.cube as EditableObject).currentPose.position.y).toBeCloseTo(0.81, 2);
    // Well past the margin it falls to the floor as before.
    const far = box('far', 0.9);
    far.currentPose.position.z = -0.1;
    far.originalPose.position.z = -0.1;
    const { snapshot: final2 } = advance(createProxyPhysics(), makeSnapshot({ objects: { far }, surfaces: { desk: table } }), 1000);
    expect((final2.objects.far as EditableObject).currentPose.position.y).toBeCloseTo(0.1, 2);
  });

  it('settles a dropped object onto a table top within 1s and then sleeps', () => {
    const table = makeSurface({
      id: 'table',
      label: 'table',
      orientation: 'horizontal',
      aabb: { min: { x: -1, y: 0.4, z: -1 }, max: { x: 1, y: 0.5, z: 1 } },
    });
    // Dropped 0.3m above the table top: bottom at 0.5 + 0.3 = 0.8, center = bottom + halfExtent.
    const obj = box('lamp', 0.9);
    const snapshot = makeSnapshot({ objects: { lamp: obj }, surfaces: { table } });

    const physics = createProxyPhysics();
    const { snapshot: final } = advance(physics, snapshot, 1000);

    const finalObj = final.objects.lamp as EditableObject;
    expect(finalObj.currentPose.position.y).toBeCloseTo(0.6, 2); // table top (0.5) + halfExtent (0.1)
    expect(physics.isSleeping('lamp')).toBe(true);
  });

  it('falls to the floor when released beside the table edge (outside its footprint)', () => {
    const table = makeSurface({
      id: 'table',
      label: 'table',
      orientation: 'horizontal',
      aabb: { min: { x: -1, y: 0.4, z: -1 }, max: { x: 1, y: 0.5, z: 1 } },
    });
    const floor = makeSurface({
      id: 'floor',
      label: 'floor',
      orientation: 'horizontal',
      aabb: { min: { x: -5, y: -0.05, z: -5 }, max: { x: 5, y: 0, z: 5 } },
    });
    // x = 2 is well outside the table's [-1, 1] footprint.
    const obj = box('ball', 0.9, { originalPose: { position: { x: 2, y: 0.9, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, currentPose: { position: { x: 2, y: 0.9, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
    const snapshot = makeSnapshot({ objects: { ball: obj }, surfaces: { table, floor } });

    const physics = createProxyPhysics();
    const { snapshot: final } = advance(physics, snapshot, 2000);

    const finalObj = final.objects.ball as EditableObject;
    expect(finalObj.currentPose.position.y).toBeCloseTo(0.1, 2); // floor (0) + halfExtent (0.1)
    expect(physics.isSleeping('ball')).toBe(true);
  });

  it('falls to y=0 when there is no floor surface at all', () => {
    const obj = box('ball', 0.5);
    const snapshot = makeSnapshot({ objects: { ball: obj }, surfaces: {} });

    const physics = createProxyPhysics();
    const { snapshot: final } = advance(physics, snapshot, 1000);

    const finalObj = final.objects.ball as EditableObject;
    expect(finalObj.currentPose.position.y).toBeCloseTo(0.1, 2);
  });

  it('separates two overlapping boxes resting on the floor', () => {
    const floor = makeSurface({
      id: 'floor',
      label: 'floor',
      orientation: 'horizontal',
      aabb: { min: { x: -5, y: -0.05, z: -5 }, max: { x: 5, y: 0, z: 5 } },
    });
    const a = box('a', 0.1, { originalPose: { position: { x: 0, y: 0.1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, currentPose: { position: { x: 0, y: 0.1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
    const b = box('b', 0.1, { originalPose: { position: { x: 0.15, y: 0.1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, currentPose: { position: { x: 0.15, y: 0.1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
    const snapshot = makeSnapshot({ objects: { a, b }, surfaces: { floor } });

    const physics = createProxyPhysics();
    const { snapshot: final } = advance(physics, snapshot, 500);

    const fa = final.objects.a as EditableObject;
    const fb = final.objects.b as EditableObject;
    const separation = Math.abs(fb.currentPose.position.x - fa.currentPose.position.x);
    expect(separation).toBeGreaterThanOrEqual(0.2 - 1e-3); // sum of half-extents: no longer overlapping
  });

  it('never moves a kinematic object', () => {
    const obj = box('anchor', 0.9, { physical: { massKg: 5, friction: 0.5, restitution: 0.1, kinematic: true } });
    const snapshot = makeSnapshot({ objects: { anchor: obj } });

    const physics = createProxyPhysics();
    const { snapshot: final, lastResult } = advance(physics, snapshot, 1000);

    expect(final.objects.anchor?.currentPose.position).toEqual({ x: 0, y: 0.9, z: 0 });
    expect(lastResult.moves.find((m) => m.objectId === 'anchor')).toBeUndefined();
    expect(physics.isSleeping('anchor')).toBe(false);
  });

  it('skips an object that is currently previewed/grabbed', () => {
    const obj = box('held', 0.9);
    const snapshot = makeSnapshot({
      objects: { held: obj },
      preview: { objectId: 'held', pose: obj.currentPose, action: 'move' },
    });

    const physics = createProxyPhysics();
    const result = physics.step(snapshot, STEP_MS, STEP_MS);

    expect(result.moves).toEqual([]);
    expect(result.awake).not.toContain('held');
    expect(result.sleeping).not.toContain('held');
  });

  it('resets velocity when an object is moved externally by more than 1mm', () => {
    const obj = box('lamp', 0.9);
    const snapshot = makeSnapshot({ objects: { lamp: obj } });
    const physics = createProxyPhysics();

    // Let it build up meaningful falling velocity first.
    const { snapshot: fallen } = advance(physics, snapshot, 10 * STEP_MS);
    const fallenObj = fallen.objects.lamp as EditableObject;

    // Simulate a user grab-and-place far from where physics left it (> 1mm).
    const movedPose = { position: { x: 0, y: fallenObj.currentPose.position.y + 0.5, z: 0 }, rotation: fallenObj.currentPose.rotation };
    const movedObj = { ...fallenObj, currentPose: movedPose };
    const movedSnapshot = { ...fallen, objects: { ...fallen.objects, lamp: movedObj } };

    const result = physics.step(movedSnapshot, STEP_MS, 0);
    const move = result.moves.find((m) => m.objectId === 'lamp');
    expect(move).toBeDefined();
    const dy = (move as { pose: { position: { y: number } } }).pose.position.y - movedPose.position.y;
    // Fresh fall from rest for one substep: dy = -g*dt^2, not the much larger
    // displacement accumulated velocity would have produced.
    expect(dy).toBeCloseTo(-9.81 * (1 / 60) * (1 / 60), 3);
  });

  it('reports a move only when the pose changes by more than 0.5mm', () => {
    const obj = box('lamp', 0.101); // essentially already resting on the floor
    const snapshot = makeSnapshot({ objects: { lamp: obj } });
    const physics = createProxyPhysics();

    const result = physics.step(snapshot, STEP_MS, STEP_MS);
    if (result.moves.length > 0) {
      expect(Math.abs(result.moves[0]!.pose.position.y - obj.currentPose.position.y)).toBeGreaterThan(0.0005);
    }
  });

  it('sleeping objects produce no further moves', () => {
    const obj = box('lamp', 0.5);
    const snapshot = makeSnapshot({ objects: { lamp: obj } });
    const physics = createProxyPhysics();

    const { snapshot: settled } = advance(physics, snapshot, 1000);
    expect(physics.isSleeping('lamp')).toBe(true);

    const result = physics.step(settled, STEP_MS, 2000);
    expect(result.moves).toEqual([]);
    expect(result.sleeping).toContain('lamp');
  });

  it('is deterministic: identical inputs produce identical outputs', () => {
    const build = (): SceneSnapshot => makeSnapshot({ objects: { lamp: box('lamp', 0.9) } });

    const physicsA = createProxyPhysics();
    const physicsB = createProxyPhysics();
    const { snapshot: finalA } = advance(physicsA, build(), 500);
    const { snapshot: finalB } = advance(physicsB, build(), 500);

    expect(finalA.objects.lamp?.currentPose).toEqual(finalB.objects.lamp?.currentPose);
  });

  it('caps substeps so a huge dt cannot make the object explode through the floor', () => {
    const obj = box('lamp', 5);
    const snapshot = makeSnapshot({ objects: { lamp: obj } });
    const physics = createProxyPhysics(); // default maxSubsteps = 4, stepMs = 1000/60

    const result = physics.step(snapshot, 1000, 1000); // a full second in one call
    const move = result.moves.find((m) => m.objectId === 'lamp');
    expect(move).toBeDefined();
    const dy = (move as { pose: { position: { y: number } } }).pose.position.y - 5;
    // At most 4 substeps of ~1/60s should run, not the ~60 a naive integrator would take.
    expect(Math.abs(dy)).toBeLessThan(0.05);
    expect(Number.isFinite(dy)).toBe(true);
  });
});
