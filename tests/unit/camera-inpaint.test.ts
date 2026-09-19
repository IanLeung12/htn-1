/**
 * Unit tests for the static-camera synthetic delete path: screen-space
 * silhouette inpainting (src/camera/edit/inpaint.ts), the eraser's fallback
 * to an inpainted appearance frame when no clean plate exists
 * (src/camera/edit/eraser.ts), and the resolver accepting a delete backed by
 * a synthetic_completion plate at the camera app's lowered coverage floor.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { CameraFrame } from '@/capture/contract';
import { appearanceFrameKey, createFrameStore } from '@/capture/frame-store';
import type { EditableObject } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { createResolver } from '@/core/resolver';
import { makeConditions, makeObject, makePlate, makeSnapshot } from '@/core/fixtures';
import { inpaintMask, inpaintMaskDetailed, SYNTHETIC_DELETE_MIN_DONOR_FRACTION } from '@/camera/edit/inpaint';
import { StaticCameraEraser } from '@/camera/edit/eraser';
import type { SilhouetteMask } from '@/camera/edit/silhouette';

const W = 320;
const H = 180;

/** Horizontal gradient frame: red = x/W * 255, green = y/H * 255, blue = 40. */
function gradientFrame(timestamp = 1): CameraFrame {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = Math.round((x / (W - 1)) * 255);
      rgba[i + 1] = Math.round((y / (H - 1)) * 255);
      rgba[i + 2] = 40;
      rgba[i + 3] = 255;
    }
  }
  return { width: W, height: H, rgba, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { ...IDENTITY_QUAT } }, fovY: 0.9, aspect: W / H, timestamp };
}

/** Paints a solid "object" (magenta) inside the rect so a fill is measurable. */
function paintObject(frame: CameraFrame, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * frame.width + x) * 4;
      frame.rgba[i] = 255;
      frame.rgba[i + 1] = 0;
      frame.rgba[i + 2] = 255;
    }
  }
}

function rectMask(x0: number, y0: number, width: number, height: number, blobDepthM = 1): SilhouetteMask {
  return { x0, y0, width, height, alpha: new Uint8ClampedArray(width * height).fill(255), blobDepthM };
}

describe('inpaintMask', () => {
  it('fills a rectangular mask from the ring so masked pixels take nearby gradient colours, seam-free', () => {
    const frame = gradientFrame();
    const mask = rectMask(120, 50, 60, 80);
    paintObject(frame, mask.x0, mask.y0, mask.width, mask.height);

    const result = inpaintMaskDetailed(frame, mask, 6);
    expect(result.frame.synthetic).toBe(true);
    expect(result.frame.rgba).not.toBe(frame.rgba);
    expect(result.donorFraction).toBe(1);
    expect(result.filledPx).toBeGreaterThanOrEqual(60 * 80);

    // Every masked pixel now reads as gradient-ish, never the magenta object.
    const clean = gradientFrame();
    let maxErr = 0;
    for (let y = mask.y0; y < mask.y0 + mask.height; y++) {
      for (let x = mask.x0; x < mask.x0 + mask.width; x++) {
        const i = (y * W + x) * 4;
        const r = result.frame.rgba[i] as number;
        const g = result.frame.rgba[i + 1] as number;
        const b = result.frame.rgba[i + 2] as number;
        expect(b).toBeLessThan(80); // magenta blue channel (255) is gone
        // A nearest-ring fill of a 60 px wide gap in a 0.8 unit/px gradient is within the
        // gradient span of the ring on each axis (red spans ~48 across the mask, green ~113).
        const err = Math.max(Math.abs(r - (clean.rgba[i] as number)), Math.abs(g - (clean.rgba[i + 1] as number)));
        maxErr = Math.max(maxErr, err);
      }
    }
    // Nearest-donor fill reproduces a smooth gradient to within roughly half the mask's
    // gradient span (worst case at the centre where the donor is ~30 px away in x, ~40 in y).
    expect(maxErr).toBeLessThan(60);

    // Seam-free within tolerance: after the 3x3 blur, neighbouring filled pixels never step more than
    // ~10% of full range even across the Voronoi boundary between two donor cells.
    let maxStep = 0;
    for (let y = mask.y0 + 1; y < mask.y0 + mask.height - 1; y++) {
      for (let x = mask.x0 + 1; x < mask.x0 + mask.width - 1; x++) {
        const i = (y * W + x) * 4;
        const j = i + 4;
        const k = i + W * 4;
        for (let c = 0; c < 3; c++) {
          maxStep = Math.max(maxStep, Math.abs((result.frame.rgba[i + c] as number) - (result.frame.rgba[j + c] as number)));
          maxStep = Math.max(maxStep, Math.abs((result.frame.rgba[i + c] as number) - (result.frame.rgba[k + c] as number)));
        }
      }
    }
    expect(maxStep).toBeLessThanOrEqual(24);

    // Pixels outside the dilated mask + blur reach are untouched.
    const far = ((mask.y0 - 5) * W + mask.x0 - 5) * 4;
    expect(result.frame.rgba[far]).toBe(frame.rgba[far]);
  });

  it('maps a mask expressed in a coarser depth grid onto the frame', () => {
    const frame = gradientFrame();
    // Depth grid is half resolution: mask 30x40 at (60,25) covers frame 60x80 at (120,50).
    const mask = rectMask(60, 25, 30, 40);
    paintObject(frame, 120, 50, 60, 80);
    const out = inpaintMask(frame, mask, 6, { width: W / 2, height: H / 2 });
    const centre = ((50 + 40) * W + 120 + 30) * 4;
    expect(out.rgba[centre + 2]).toBeLessThan(80);
  });

  it('reports a low donor fraction when the mask sits on the frame edge', () => {
    const frame = gradientFrame();
    const mask = rectMask(0, 0, 40, 40);
    const result = inpaintMaskDetailed(frame, mask, 6);
    expect(result.donorFraction).toBeGreaterThan(0);
    expect(result.donorFraction).toBeLessThan(1);
    expect(result.filledPx).toBeGreaterThan(0);
  });

  it('runs a 60x80 mask on a 320x180 frame in under 30 ms', () => {
    const frame = gradientFrame();
    const mask = rectMask(120, 50, 60, 80);
    inpaintMask(frame, mask, 6); // warm-up (JIT)
    const runs = 5;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) inpaintMask(frame, mask, 6);
    const perRun = (performance.now() - t0) / runs;
    expect(perRun).toBeLessThan(30);
  });
});

function physicalObject(overrides: Partial<EditableObject> = {}): EditableObject {
  const pos = { x: 0, y: 0.1, z: -1 };
  const half = { x: 0.05, y: 0.1, z: 0.05 };
  return {
    id: 'obj:can',
    label: 'other',
    userName: 'can',
    origin: 'physical',
    originalPose: { position: pos, rotation: IDENTITY_QUAT },
    currentPose: { position: pos, rotation: IDENTITY_QUAT },
    visual: { kind: 'baked' },
    interactionProxy: { kind: 'box', halfExtents: half },
    collisionProxy: { kind: 'box', halfExtents: half },
    occlusionProxy: { kind: 'box', halfExtents: half },
    supportSurfaces: ['desk'],
    background: [],
    provenance: { method: 'guided_clean_plate', capturedAt: 0, capturePath: [] },
    tier: 'B',
    tierConfidence: 0.5,
    envelope: { center: pos, radius: 1.5, maxAngle: 1.0 },
    physical: { massKg: 0.3, friction: 0.6, restitution: 0.1, kinematic: true },
    approved: true,
    visible: false,
    ...overrides,
  };
}

describe('StaticCameraEraser synthetic path', () => {
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 10);
  camera.position.set(0, 1, 0);

  function setup(synthetic: boolean) {
    const frameStore = createFrameStore();
    const older = gradientFrame(10);
    const newest = gradientFrame(20);
    paintObject(newest, 120, 50, 60, 80);
    frameStore.put(appearanceFrameKey('obj:can'), [older, newest]);
    const eraser = new StaticCameraEraser(frameStore, { synthetic: () => synthetic });
    const obj = physicalObject();
    const snapshot = makeSnapshot({ objects: { [obj.id]: obj } });
    const masks = new Map<string, SilhouetteMask>([[obj.id, rectMask(120, 50, 60, 80)]]);
    return { frameStore, eraser, snapshot, masks };
  }

  it('composites an inpainted copy of the newest appearance frame when no clean plate exists', () => {
    const { eraser, snapshot, masks } = setup(true);
    const n = eraser.update(snapshot, masks, 0, W, H, camera);
    expect(n).toBe(1);
    expect(eraser.isActive('obj:can')).toBe(true);
    expect(eraser.isSynthetic('obj:can')).toBe(true);
    expect(eraser.syntheticCount).toBe(1);
    const mesh = eraser.group.children[0] as THREE.Mesh;
    expect(mesh.visible).toBe(true);
    const tex = (mesh.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
    const data = tex.image.data as Uint8ClampedArray;
    // The cutout texture is the mask-sized crop of the inpainted frame: no magenta remains.
    let maxBlue = 0;
    for (let i = 0; i < data.length; i += 4) maxBlue = Math.max(maxBlue, data[i + 2] as number);
    expect(maxBlue).toBeLessThan(80);
    expect(tex.image.width).toBe(60);
    expect(tex.image.height).toBe(80);
  });

  it('caches the inpainted frame across updates and rebuilds only when the source frame changes', () => {
    const { frameStore, eraser, snapshot, masks } = setup(true);
    eraser.update(snapshot, masks, 0, W, H, camera);
    const meshA = eraser.group.children[0] as THREE.Mesh;
    const texA = (meshA.material as THREE.MeshBasicMaterial).map;
    eraser.update(snapshot, masks, 0, W, H, camera);
    expect((meshA.material as THREE.MeshBasicMaterial).map).toBe(texA);
    const frames = frameStore.get(appearanceFrameKey('obj:can')) ?? [];
    frameStore.put(appearanceFrameKey('obj:can'), [...frames, gradientFrame(30)]);
    eraser.update(snapshot, masks, 0, W, H, camera);
    expect((meshA.material as THREE.MeshBasicMaterial).map).not.toBe(texA);
  });

  it('does nothing without a clean plate when the synthetic option is off', () => {
    const { eraser, snapshot, masks } = setup(false);
    expect(eraser.update(snapshot, masks, 0, W, H, camera)).toBe(0);
    expect(eraser.isSynthetic('obj:can')).toBe(false);
  });

  it('prefers a real clean-plate frame over the synthetic fill', () => {
    const { frameStore, eraser, snapshot, masks } = setup(true);
    frameStore.put('obj:can', [gradientFrame(99)]);
    expect(eraser.update(snapshot, masks, 0, W, H, camera)).toBe(1);
    expect(eraser.isSynthetic('obj:can')).toBe(false);
  });
});

describe('resolver: delete with a synthetic plate', () => {
  function env(intent: Parameters<ReturnType<typeof createResolver>['resolve']>[1]['intent']) {
    return { intent, source: 'ui' as const, issuedAt: 0, basedOnVersion: 1 };
  }

  it('accepts a delete when the camera app lowers the synthetic_completion coverage floor', () => {
    const plate = makePlate({ provenance: 'synthetic_completion', version: 'completed_v3', coverage: 0.05 });
    const object = makeObject({ id: 'o1', origin: 'physical', tier: 'B', approved: true, background: [plate] });
    const snapshot = makeSnapshot({ version: 1, objects: { o1: object } });
    const conditions = makeConditions();

    const strict = createResolver();
    const rejected = strict.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), conditions);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe('no_background_evidence');

    const lenient = createResolver({ minDeleteCoverageByProvenance: { synthetic_completion: SYNTHETIC_DELETE_MIN_DONOR_FRACTION } });
    const accepted = lenient.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), conditions);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.snapshot.objects.o1?.visible).toBe(false);

    // The per-provenance floor does not loosen observed plates.
    const thin = makePlate({ provenance: 'observed_clean_plate', coverage: 0.05 });
    const snap2 = makeSnapshot({ version: 1, objects: { o1: makeObject({ id: 'o1', origin: 'physical', tier: 'B', approved: true, background: [thin] }) } });
    expect(lenient.resolve(snap2, env({ kind: 'delete', objectId: 'o1' }), conditions).ok).toBe(false);
  });

  it('still rejects a synthetic plate below the floor', () => {
    const plate = makePlate({ provenance: 'synthetic_completion', version: 'completed_v3', coverage: 0.01 });
    const object = makeObject({ id: 'o1', origin: 'physical', tier: 'B', approved: true, background: [plate] });
    const snapshot = makeSnapshot({ version: 1, objects: { o1: object } });
    const lenient = createResolver({ minDeleteCoverageByProvenance: { synthetic_completion: SYNTHETIC_DELETE_MIN_DONOR_FRACTION } });
    expect(lenient.resolve(snapshot, env({ kind: 'delete', objectId: 'o1' }), makeConditions()).ok).toBe(false);
  });
});
