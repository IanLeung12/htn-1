// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createSceneStore } from '@/core';
import type { EditableObject, Pose, RuntimeConditions } from '@/core/types';
import { InteractionController } from '@/app/interaction';
import { clampDistance, clampStep, intersectPlaneY, PointerInputAdapter, type PointerRay } from '@/camera/input/pointer';

/** Minimal element stand-in: the adapter only needs listeners, a rect, and a style bag. */
function fakeElement(width = 800, height = 600) {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  return {
    style: {} as Record<string, string>,
    addEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    setPointerCapture() {
      /* noop */
    },
    listeners,
  };
}

/** Camera at (0, 1.1, 0) pitched down: a simple pinhole so tests can reason about rays. */
const CAM = { x: 0, y: 1.1, z: 0 };
const PITCH = -0.35;
const TAN_HALF = Math.tan(((50 * Math.PI) / 180) / 2);
function rayFromNdc(ndcX: number, ndcY: number, out: PointerRay): void {
  const aspect = 800 / 600;
  const lx = ndcX * TAN_HALF * aspect;
  const ly = ndcY * TAN_HALF;
  const lz = -1;
  // rotate about X by PITCH
  const c = Math.cos(PITCH);
  const s = Math.sin(PITCH);
  const y = ly * c - lz * s;
  const z = ly * s + lz * c;
  const len = Math.hypot(lx, y, z);
  out.origin.x = CAM.x;
  out.origin.y = CAM.y;
  out.origin.z = CAM.z;
  out.direction.x = lx / len;
  out.direction.y = y / len;
  out.direction.z = z / len;
}

function pixelForWorld(p: { x: number; y: number; z: number }): { x: number; y: number } {
  // Search the screen for the pixel whose ray passes nearest the point (coarse then fine).
  const ray: PointerRay = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };
  let best = { x: 0, y: 0, d: Infinity };
  for (let py = 0; py < 600; py += 2) {
    for (let px = 0; px < 800; px += 2) {
      rayFromNdc((px / 800) * 2 - 1, -((py / 600) * 2 - 1), ray);
      const hit = intersectPlaneY(ray, p.y);
      if (!hit) continue;
      const d = Math.hypot(hit.x - p.x, hit.z - p.z);
      if (d < best.d) best = { x: px, y: py, d };
    }
  }
  return best;
}

function cube(id: string, pose: Pose): EditableObject {
  return {
    id,
    label: 'other',
    userName: id,
    origin: 'spawned',
    originalPose: pose,
    currentPose: pose,
    visual: { kind: 'primitive' },
    interactionProxy: { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
    collisionProxy: { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
    occlusionProxy: { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
    supportSurfaces: [],
    background: [],
    provenance: { method: 'spawned', capturedAt: 0, capturePath: [pose] },
    tier: 'A',
    tierConfidence: 1,
    envelope: { center: pose.position, radius: 5, maxAngle: Math.PI },
    physical: { massKg: 1, friction: 0.5, restitution: 0, kinematic: true },
    approved: true,
    visible: true,
  };
}

const cond = (): RuntimeConditions => ({
  now: 1000,
  headPose: { position: CAM, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  trackingOk: true,
  localizedAnchors: new Set(),
  depthAgeMs: 0,
  tier: 1,
});

describe('intersectPlaneY', () => {
  it('hits the floor in front of a downward ray and misses a plane behind the origin', () => {
    const ray: PointerRay = { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -Math.SQRT1_2, z: -Math.SQRT1_2 } };
    const hit = intersectPlaneY(ray, 0);
    expect(hit).toEqual({ x: 0, y: 0, z: -1 });
    expect(intersectPlaneY(ray, 2)).toBeNull();
    expect(intersectPlaneY({ origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: 0, z: -1 } }, 0)).toBeNull();
  });
});

describe('PointerInputAdapter + InteractionController', () => {
  it('hovers, grabs, drags along the grab plane, and commits a move on release', () => {
    const store = createSceneStore();
    const start: Pose = { position: { x: 0, y: 0.08, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    store.dispatch({ intent: { kind: 'spawn', object: cube('c', start) }, source: 'test', issuedAt: 0, basedOnVersion: 0 }, cond());

    const el = fakeElement();
    const adapter = new PointerInputAdapter({ element: el as unknown as HTMLElement, store, rayFromNdc });
    const interaction = new InteractionController(store);

    const px = pixelForWorld({ x: 0, y: 0.16, z: -2 }); // top face of the cube
    adapter.inject('move', px.x, px.y);
    adapter.update();
    interaction.update(adapter.state, cond());
    expect(adapter.hoverId).toBe('c');
    expect(interaction.hoveredId).toBe('c');
    expect(adapter.state.right.active).toBe(true);
    expect(adapter.state.right.pinching).toBe(false);

    adapter.inject('down', px.x, px.y);
    adapter.update();
    expect(adapter.state.right.selectStart).toBe(true);
    interaction.update(adapter.state, cond());
    expect(interaction.selectedId).toBe('c');

    // Drag 100 px to the right: the grab point slides along the plane at the grab height.
    const grabY = adapter.state.right.position.y;
    adapter.inject('move', px.x + 100, px.y);
    adapter.update();
    expect(adapter.state.right.selectStart).toBe(false);
    expect(adapter.state.right.position.y).toBeCloseTo(grabY, 6);
    expect(adapter.state.right.position.x).toBeGreaterThan(0.05);
    interaction.update(adapter.state, cond());
    const preview = store.current.preview;
    expect(preview?.objectId).toBe('c');
    expect(preview!.pose.position.x).toBeGreaterThan(0.05);
    expect(preview!.pose.position.y).toBeCloseTo(0.08, 3);

    adapter.inject('up', px.x + 100, px.y);
    adapter.update();
    expect(adapter.state.right.selectEnd).toBe(true);
    interaction.update(adapter.state, cond());
    const moved = store.current.objects['c']!;
    expect(moved.currentPose.position.x).toBeGreaterThan(0.05);
    expect(moved.currentPose.position.y).toBeCloseTo(0.08, 3);
    expect(store.current.preview).toBeUndefined();

    // Mouse keeps hovering after release; a second update has no edges.
    adapter.update();
    expect(adapter.state.right.active).toBe(true);
    expect(adapter.state.right.selectStart).toBe(false);
    expect(adapter.state.right.selectEnd).toBe(false);
    adapter.dispose();
  });

  it('a touch pointer disappears after lift and a second touch drives the left hand', () => {
    const store = createSceneStore();
    const el = fakeElement();
    const adapter = new PointerInputAdapter({ element: el as unknown as HTMLElement, store, rayFromNdc });
    adapter.inject('down', 400, 450, 1, true);
    adapter.inject('down', 500, 450, 2, true);
    adapter.update();
    expect(adapter.state.right.active).toBe(true);
    expect(adapter.state.left.active).toBe(true);
    expect(adapter.state.left.pinching).toBe(true);
    adapter.inject('up', 500, 450, 2, true);
    adapter.update();
    expect(adapter.state.left.selectEnd).toBe(true);
    adapter.update();
    expect(adapter.state.left.active).toBe(false);
    adapter.inject('up', 400, 450, 1, true);
    adapter.update();
    adapter.update();
    expect(adapter.state.right.active).toBe(false);
    adapter.dispose();
  });
});

describe('drag guards and flicks', () => {
  it('clamps grazing plane hits and per-update steps', () => {
    const clamped = clampDistance({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -20 }, 3);
    expect(Math.hypot(clamped.x, clamped.y - 1, clamped.z)).toBeCloseTo(3, 9);
    expect(clamped.z).toBeCloseTo(-60 / Math.hypot(1, 20), 9);
    expect(clampStep({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 0.5)).toEqual({ x: 0.5, y: 0, z: 0 });
    expect(clampStep(null, { x: 2, y: 0, z: 0 }, 0.5)).toEqual({ x: 2, y: 0, z: 0 });
  });

  it('a down/move/up within one frame still grabs, moves, and commits over three updates', () => {
    const store = createSceneStore();
    const start: Pose = { position: { x: 0, y: 0.08, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    store.dispatch({ intent: { kind: 'spawn', object: cube('c', start) }, source: 'test', issuedAt: 0, basedOnVersion: 0 }, cond());
    const el = fakeElement();
    const adapter = new PointerInputAdapter({ element: el as unknown as HTMLElement, store, rayFromNdc });
    const interaction = new InteractionController(store);
    const px = pixelForWorld({ x: 0, y: 0.16, z: -2 });
    adapter.inject('down', px.x, px.y);
    adapter.inject('move', px.x + 40, px.y);
    adapter.inject('move', px.x + 80, px.y);
    adapter.inject('up', px.x + 80, px.y);
    adapter.update();
    expect(adapter.state.right.selectStart).toBe(true);
    expect(adapter.state.right.selectEnd).toBe(false);
    interaction.update(adapter.state, cond());
    expect(interaction.selectedId).toBe('c');
    adapter.update();
    expect(adapter.state.right.selectStart).toBe(false);
    expect(adapter.state.right.pinching).toBe(true);
    interaction.update(adapter.state, cond());
    expect(store.current.preview?.objectId).toBe('c');
    adapter.update();
    expect(adapter.state.right.selectEnd).toBe(true);
    interaction.update(adapter.state, cond());
    expect(store.current.objects['c']!.currentPose.position.x).toBeGreaterThan(0.05);
    expect(store.current.preview).toBeUndefined();
    adapter.dispose();
  });

  it('a runaway plane hit cannot send the object far beyond the grab distance', () => {
    const store = createSceneStore();
    const start: Pose = { position: { x: 0, y: 0.08, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    store.dispatch({ intent: { kind: 'spawn', object: cube('c', start) }, source: 'test', issuedAt: 0, basedOnVersion: 0 }, cond());
    const el = fakeElement();
    const adapter = new PointerInputAdapter({ element: el as unknown as HTMLElement, store, rayFromNdc });
    const px = pixelForWorld({ x: 0, y: 0.16, z: -2 });
    adapter.inject('move', px.x, px.y);
    adapter.update();
    adapter.inject('down', px.x, px.y);
    adapter.update();
    // Drag the pointer up towards the horizon: the plane hit would be tens of metres away.
    for (let i = 0; i < 30; i++) {
      adapter.inject('move', px.x + 240, px.y - 50 - i * 4);
      adapter.update();
    }
    const p = adapter.state.right.position;
    const dist = Math.hypot(p.x - CAM.x, p.y - CAM.y, p.z - CAM.z);
    expect(dist).toBeLessThanOrEqual(1.5 * Math.hypot(0, 0.16 - CAM.y, -2) + 1e-6);
    expect(p.z).toBeGreaterThan(-6);
    adapter.dispose();
  });
});
