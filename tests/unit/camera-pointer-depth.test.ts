// @vitest-environment node
/**
 * The pointer adapter over every depth source: its `depthPick` is the app's
 * pickWorld (pick.ts on the newest DepthMap), so a stereo map, a monocular map
 * and a sensor (ZED SDK) map must all set pointerWorld on hover, and a proxy
 * under the pointer must hover regardless of the map. Also covers the
 * container as an extra event target (events dispatched to the display canvas
 * under the overlay still drive the adapter, once).
 */
import { describe, expect, it } from 'vitest';
import { createSceneStore } from '@/core';
import type { EditableObject, Pose } from '@/core/types';
import { PointerInputAdapter, type PointerRay } from '@/camera/input/pointer';
import { pickFromMapRobust } from '@/camera/pick';
import type { DepthMap, DepthSource } from '@/camera/contract';

const W = 800;
const H = 600;
const FOV_Y = Math.PI / 2;
const CAM_Y = 0.5;

function fakeElement(width = W, height = H) {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const el = {
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
    dispatch(type: string, e: Record<string, unknown>) {
      for (const fn of listeners.get(type) ?? []) fn({ target: el, composedPath: () => [el], preventDefault() {}, ...e });
    },
    listeners,
  };
  return el;
}

/** Level camera at (0, CAM_Y, 0), 90 degree vertical FOV, 4:3 - the same pinhole the depth maps use. */
function rayFromNdc(ndcX: number, ndcY: number, out: PointerRay): void {
  const tanHalf = Math.tan(FOV_Y / 2);
  const dir = { x: ndcX * tanHalf * (W / H), y: ndcY * tanHalf, z: -1 };
  const len = Math.hypot(dir.x, dir.y, dir.z);
  out.origin.x = 0;
  out.origin.y = CAM_Y;
  out.origin.z = 0;
  out.direction.x = dir.x / len;
  out.direction.y = dir.y / len;
  out.direction.z = dir.z / len;
}

/** Depth of a plane at y = 0 seen from that camera, with a textureless hole (stereo) or full coverage. */
function planeMap(source: DepthSource, width: number, height: number, hole: boolean): DepthMap {
  const metric = new Float32Array(width * height);
  const weight = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const ndcY = 1 - (2 * (y + 0.5)) / height;
    for (let x = 0; x < width; x++) {
      if (ndcY >= -0.02) continue;
      const inHole = hole && Math.abs(x - width / 2) < width * 0.05 && Math.abs(y - height * 0.8) < height * 0.05;
      metric[y * width + x] = inHole ? 0 : CAM_Y / -ndcY;
      weight[y * width + x] = inHole ? 0 : 1;
    }
  }
  const map: DepthMap = { width, height, metric, confidence: 0.7, source, pose: { position: { x: 0, y: CAM_Y, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, fovY: FOV_Y, aspect: width / height, timestamp: 1000 };
  if (source === 'stereo') map.weight = weight;
  return map;
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
    anchorId: 'room-anchor',
    tier: 'A',
    tierConfidence: 1,
    envelope: { center: pose.position, radius: 3, maxAngle: Math.PI },
    physical: { massKg: 0.3, friction: 0.5, restitution: 0.2, kinematic: true },
    approved: true,
    visible: true,
  } as EditableObject;
}

/** The app's depthPick: NDC -> map pixel -> pick.ts, identical for every source. */
function depthPickFor(map: DepthMap) {
  return (ndcX: number, ndcY: number) => {
    const px = Math.min(map.width - 1, Math.floor((ndcX * 0.5 + 0.5) * map.width));
    const py = Math.min(map.height - 1, Math.floor((0.5 - ndcY * 0.5) * map.height));
    return pickFromMapRobust(map, px, py, null);
  };
}

const SOURCES: { source: DepthSource; width: number; height: number; hole: boolean }[] = [
  { source: 'stereo', width: 336, height: 189, hole: true },
  { source: 'monocular', width: 252, height: 189, hole: false },
  { source: 'sensor', width: 320, height: 180, hole: false },
];

describe('pointer hover over each depth source', () => {
  for (const { source, width, height, hole } of SOURCES) {
    it(`${source} ${width}x${height}: hover sets pointerWorld from the depth and a proxy under the pointer hovers`, () => {
      const map = planeMap(source, width, height, hole);
      const store = createSceneStore();
      // A cube on the plane 1 m ahead; pixel for it: ray through its top face centre.
      const pose: Pose = { position: { x: 0, y: 0.08, z: -1 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
      store.dispatch({ intent: { kind: 'spawn', object: cube('cube', pose) }, source: 'test', issuedAt: 0, basedOnVersion: store.current.version }, { now: 0, headPose: { position: { x: 0, y: CAM_Y, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, trackingOk: true, localizedAnchors: new Set(['room-anchor']), depthAgeMs: 0, tier: 1 });
      expect(Object.keys(store.current.objects)).toContain('cube');
      const el = fakeElement();
      const adapter = new PointerInputAdapter({ element: el as unknown as HTMLElement, store, rayFromNdc, depthPick: depthPickFor(map) });

      // Empty plane far to the right at the bottom: pointerWorld comes from the depth map (y = 0 plane).
      adapter.inject('move', W * 0.85, H * 0.9);
      adapter.update();
      const p = adapter.pointerWorld;
      expect(Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(0.1);
      expect(Math.abs(p.y)).toBeLessThan(0.03);
      expect(adapter.hoverId).toBeNull();

      // Over the cube: hover hits the proxy whatever the depth source.
      const ndcY = Math.atan2(0.16 - CAM_Y, 1) / Math.tan(FOV_Y / 2); // small-angle: dir.y/dir.z
      adapter.inject('move', W * 0.5, (0.5 - ndcY * 0.5) * H);
      adapter.update();
      expect(adapter.hoverId).toBe('cube');

      // The stereo hole under the pointer: depthPick is null there, the hand rests on the ground ray instead of (0,0,0).
      if (hole) {
        adapter.inject('move', W * 0.5, H * 0.8);
        adapter.update();
        const q = adapter.pointerWorld;
        expect(Math.hypot(q.x, q.y, q.z)).toBeGreaterThan(0.1);
      }
      adapter.dispose();
    });
  }

  it('events dispatched to an extra target (the display canvas under the overlay) drive the adapter once', () => {
    const map = planeMap('stereo', 336, 189, false);
    const store = createSceneStore();
    const overlay = fakeElement();
    const container = fakeElement();
    const display = { target: 'display' };
    const adapter = new PointerInputAdapter({ element: overlay as unknown as HTMLElement, extraTargets: [container as unknown as HTMLElement], store, rayFromNdc, depthPick: depthPickFor(map) });
    // Bubbled from the display canvas: target is not the overlay -> handled.
    for (const fn of container.listeners.get('pointermove') ?? []) fn({ target: display, composedPath: () => [display, container], pointerId: 1, pointerType: 'mouse', clientX: W * 0.85, clientY: H * 0.9, preventDefault() {} });
    adapter.update();
    expect(Math.hypot(adapter.pointerWorld.x, adapter.pointerWorld.y, adapter.pointerWorld.z)).toBeGreaterThan(0.1);
    expect(adapter.lastNdcX).toBeCloseTo(0.7, 5);
    // Bubbled from the overlay itself: ignored by the container listener (the overlay's own listener handled it).
    for (const fn of container.listeners.get('pointermove') ?? []) fn({ target: overlay, composedPath: () => [overlay, container], pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0, preventDefault() {} });
    expect(adapter.lastNdcX).toBeCloseTo(0.7, 5);
    adapter.dispose();
    expect((container.listeners.get('pointermove') ?? []).length).toBe(0);
  });
});
