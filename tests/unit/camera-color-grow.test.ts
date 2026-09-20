/**
 * Unit tests for the colour-grown silhouette (src/camera/edit/color-grow.ts)
 * and the SilhouetteTracker's grown-mask bookkeeping. Synthetic 320x180
 * frame: a grey desk with a mild vertical gradient, an orange ellipse at
 * 0.5 m (the object, sparse depth), and a far orange region of the same
 * colour at the top (a wall at 3 m) touching the ellipse, so only the depth
 * gate keeps the fill out of it.
 */
import { describe, expect, it } from 'vitest';
import type { EditableObject } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { growMaskByColor } from '@/camera/edit/color-grow';
import { depthFrameFromMap, SilhouetteTracker, type SilhouetteMask } from '@/camera/edit/silhouette';
import { BOX, syntheticSceneDepth } from './helpers/synthetic-scene';

const W = 320;
const H = 180;
const CX = 160;
const CY = 110;
const RX = 30;
const RY = 12;
const ORANGE = [230, 120, 30] as const;
const BLOB_DEPTH_M = 0.5;
const FAR_DEPTH_M = 3;

function inEllipse(x: number, y: number, rx: number, ry: number): boolean {
  const dx = (x + 0.5 - CX) / rx;
  const dy = (y + 0.5 - CY) / ry;
  return dx * dx + dy * dy <= 1;
}

/** Far orange region: a column above the ellipse, touching its top edge. */
function inFarOrange(x: number, y: number): boolean {
  return x >= 140 && x < 180 && y < CY - RY && !inEllipse(x, y, RX, RY);
}

interface Scene {
  rgba: Uint8ClampedArray;
  depth: Float32Array;
  ellipsePx: number;
  deskPx: number;
  farPx: number;
}

function buildScene(): Scene {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const depth = new Float32Array(W * H);
  let ellipsePx = 0;
  let deskPx = 0;
  let farPx = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (inEllipse(x, y, RX, RY)) {
        // Curved-can shading: lightness varies across the ellipse, hue does not.
        const shade = 0.8 + 0.2 * Math.cos(((x - CX) / RX) * Math.PI * 0.5);
        rgba[i] = Math.round(ORANGE[0] * shade);
        rgba[i + 1] = Math.round(ORANGE[1] * shade);
        rgba[i + 2] = Math.round(ORANGE[2] * shade);
        // Sparse stereo depth: valid only on a small patch, elsewhere missing (0).
        depth[y * W + x] = inEllipse(x, y, RX * 0.45, RY * 0.45) ? BLOB_DEPTH_M : 0;
        ellipsePx += 1;
      } else if (inFarOrange(x, y)) {
        rgba[i] = ORANGE[0];
        rgba[i + 1] = ORANGE[1];
        rgba[i + 2] = ORANGE[2];
        depth[y * W + x] = FAR_DEPTH_M;
        farPx += 1;
      } else {
        // Grey desk with a mild vertical gradient (lighter at the bottom).
        const l = 100 + Math.round((60 * y) / H);
        rgba[i] = l;
        rgba[i + 1] = l;
        rgba[i + 2] = l;
        depth[y * W + x] = 0.6 + (0.4 * (H - y)) / H;
        deskPx += 1;
      }
      rgba[i + 3] = 255;
    }
  }
  return { rgba, depth, ellipsePx, deskPx, farPx };
}

/** Sparse seed: a small central ellipse covering ~15% of the object's pixels. */
function sparseSeed(): { mask: SilhouetteMask; seedPx: number } {
  const rx = RX * 0.39;
  const ry = RY * 0.39;
  const x0 = Math.floor(CX - rx) - 1;
  const y0 = Math.floor(CY - ry) - 1;
  const x1 = Math.ceil(CX + rx) + 1;
  const y1 = Math.ceil(CY + ry) + 1;
  const width = x1 - x0;
  const height = y1 - y0;
  const alpha = new Uint8ClampedArray(width * height);
  let seedPx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inEllipse(x0 + x, y0 + y, rx, ry)) {
        alpha[y * width + x] = 255;
        seedPx += 1;
      }
    }
  }
  return { mask: { x0, y0, width, height, alpha, blobDepthM: BLOB_DEPTH_M }, seedPx };
}

function coverage(mask: SilhouetteMask, predicate: (x: number, y: number) => boolean, minAlpha = 128): number {
  let n = 0;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if ((mask.alpha[y * mask.width + x] as number) < minAlpha) continue;
      if (predicate(mask.x0 + x, mask.y0 + y)) n += 1;
    }
  }
  return n;
}

describe('growMaskByColor', () => {
  it('grows a sparse seed over the whole ellipse but not the desk or the far same-colour region', () => {
    const scene = buildScene();
    const { mask: seed, seedPx } = sparseSeed();
    expect(seedPx / scene.ellipsePx).toBeGreaterThan(0.1);
    expect(seedPx / scene.ellipsePx).toBeLessThan(0.2);

    const t0 = performance.now();
    const grown = growMaskByColor(scene.rgba, W, H, seed, scene.depth);
    const elapsed = performance.now() - t0;

    const onEllipse = coverage(grown, (x, y) => inEllipse(x, y, RX, RY));
    const onDesk = coverage(grown, (x, y) => !inEllipse(x, y, RX, RY) && !inFarOrange(x, y));
    const onFar = coverage(grown, inFarOrange);
    expect(onEllipse / scene.ellipsePx).toBeGreaterThanOrEqual(0.85);
    expect(onDesk / scene.deskPx).toBeLessThan(0.03);
    expect(onFar).toBe(0);
    expect(grown.blobDepthM).toBe(BLOB_DEPTH_M);
    expect(elapsed).toBeLessThan(20);
  });

  it('keeps the seed alpha and stays within the frame', () => {
    const scene = buildScene();
    const { mask: seed } = sparseSeed();
    const grown = growMaskByColor(scene.rgba, W, H, seed, scene.depth);
    expect(grown.x0).toBeGreaterThanOrEqual(0);
    expect(grown.y0).toBeGreaterThanOrEqual(0);
    expect(grown.x0 + grown.width).toBeLessThanOrEqual(W);
    expect(grown.y0 + grown.height).toBeLessThanOrEqual(H);
    for (let y = 0; y < seed.height; y++) {
      for (let x = 0; x < seed.width; x++) {
        const a = seed.alpha[y * seed.width + x] as number;
        if (a === 0) continue;
        const gx = seed.x0 + x - grown.x0;
        const gy = seed.y0 + y - grown.y0;
        expect(grown.alpha[gy * grown.width + gx]).toBeGreaterThanOrEqual(a);
      }
    }
  });

  it('without depth, the far same-colour region is only held off by the growth bound', () => {
    const scene = buildScene();
    const { mask: seed } = sparseSeed();
    // A tiny growth bound: the fill cannot leave the seed bbox neighbourhood.
    const grown = growMaskByColor(scene.rgba, W, H, seed, undefined, { maxGrowPx: 2 });
    expect(coverage(grown, inFarOrange)).toBe(0);
    expect(grown.width).toBeLessThanOrEqual(seed.width + 2 * 2 + 2 * 2);
  });

  it('maps between a frame and a smaller depth grid', () => {
    const scene = buildScene();
    const { mask: seed } = sparseSeed();
    // Depth grid at half resolution: seed and depth in 160x90, frame at 320x180.
    const gw = 160;
    const gh = 90;
    const depthHalf = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) depthHalf[y * gw + x] = scene.depth[y * 2 * W + x * 2] as number;
    const halfSeed: SilhouetteMask = {
      x0: Math.floor(seed.x0 / 2),
      y0: Math.floor(seed.y0 / 2),
      width: Math.ceil(seed.width / 2),
      height: Math.ceil(seed.height / 2),
      alpha: new Uint8ClampedArray(Math.ceil(seed.width / 2) * Math.ceil(seed.height / 2)),
      blobDepthM: BLOB_DEPTH_M,
    };
    for (let y = 0; y < halfSeed.height; y++) {
      for (let x = 0; x < halfSeed.width; x++) {
        halfSeed.alpha[y * halfSeed.width + x] = seed.alpha[y * 2 * seed.width + x * 2] as number;
      }
    }
    const grown = growMaskByColor(scene.rgba, W, H, halfSeed, depthHalf, { depthWidth: gw, depthHeight: gh });
    expect(grown.x0 + grown.width).toBeLessThanOrEqual(gw);
    expect(grown.y0 + grown.height).toBeLessThanOrEqual(gh);
    const onEllipse = coverage(grown, (x, y) => inEllipse(x * 2, y * 2, RX, RY));
    const onFar = coverage(grown, (x, y) => inFarOrange(x * 2, y * 2));
    expect(onEllipse / (scene.ellipsePx / 4)).toBeGreaterThan(0.8);
    expect(onFar).toBe(0);
  });
});

const BOX_CENTER = {
  x: (BOX.min.x + BOX.max.x) / 2,
  y: (BOX.min.y + BOX.max.y) / 2,
  z: (BOX.min.z + BOX.max.z) / 2,
};
const BOX_HALF_EXTENTS = {
  x: (BOX.max.x - BOX.min.x) / 2,
  y: (BOX.max.y - BOX.min.y) / 2,
  z: (BOX.max.z - BOX.min.z) / 2,
};

function boxObject(): EditableObject {
  return {
    id: 'obj:can',
    label: 'other',
    userName: 'can',
    origin: 'physical',
    originalPose: { position: BOX_CENTER, rotation: IDENTITY_QUAT },
    currentPose: { position: BOX_CENTER, rotation: IDENTITY_QUAT },
    visual: { kind: 'baked' },
    interactionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    collisionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    occlusionProxy: { kind: 'box', halfExtents: BOX_HALF_EXTENTS },
    supportSurfaces: ['camera-floor'],
    background: [],
    provenance: { method: 'guided_clean_plate', capturedAt: 0, capturePath: [] },
    tier: 'D',
    tierConfidence: 0.6,
    envelope: { center: BOX_CENTER, radius: 1.5, maxAngle: 1.0 },
    physical: { massKg: 0.3, friction: 0.6, restitution: 0.1, kinematic: false },
    approved: true,
    visible: true,
  };
}

describe('SilhouetteTracker grown masks', () => {
  it('peek returns the grown mask until the next depth update changes the depth mask', () => {
    const tracker = new SilhouetteTracker();
    const map = syntheticSceneDepth(true);
    const df = depthFrameFromMap(map);
    const obj = boxObject();

    expect(tracker.needsGrow('obj:can')).toBe(false);
    const depthMask = tracker.update('obj:can', df, obj);
    expect(depthMask).toBeDefined();
    expect(tracker.needsGrow('obj:can')).toBe(true);
    expect(tracker.hasGrown('obj:can')).toBe(false);

    const grown: SilhouetteMask = {
      x0: depthMask!.x0 - 4,
      y0: depthMask!.y0 - 4,
      width: depthMask!.width + 8,
      height: depthMask!.height + 8,
      alpha: new Uint8ClampedArray((depthMask!.width + 8) * (depthMask!.height + 8)).fill(255),
      blobDepthM: depthMask!.blobDepthM,
    };
    tracker.setGrown('obj:can', grown);
    expect(tracker.hasGrown('obj:can')).toBe(true);
    expect(tracker.needsGrow('obj:can')).toBe(false);
    expect(tracker.peek('obj:can')).toBe(grown);
    expect(tracker.peekDepthOnly('obj:can')!.width).toBe(depthMask!.width);

    // Identical frames only jitter the median: the grown mask stays valid.
    tracker.update('obj:can', df, obj);
    expect(tracker.peek('obj:can')).toBe(grown);

    // A depth frame that reads the object differently (a shifted, noisier depth
    // map) changes the median mask materially: back to the depth-only mask.
    const shifted = { ...map, metric: new Float32Array(map.metric) };
    for (let i = 0; i < shifted.metric.length; i++) {
      const d = shifted.metric[i] as number;
      if (d > 0 && (i % 3 === 0)) shifted.metric[i] = d + 0.3;
    }
    const shiftedDf = depthFrameFromMap(shifted);
    for (let i = 0; i < 5; i++) tracker.update('obj:can', shiftedDf, obj);
    expect(tracker.needsGrow('obj:can')).toBe(true);
    expect(tracker.hasGrown('obj:can')).toBe(false);
    const after = tracker.peek('obj:can');
    expect(after).toBeDefined();
    expect(after).not.toBe(grown);

    // A frame without the object freezes the last mask; clear forgets everything.
    tracker.setGrown('obj:can', grown);
    tracker.update('obj:can', depthFrameFromMap(syntheticSceneDepth(false)), obj);
    tracker.clear('obj:can');
    expect(tracker.peek('obj:can')).toBeUndefined();
    expect(tracker.hasGrown('obj:can')).toBe(false);
  });
});
