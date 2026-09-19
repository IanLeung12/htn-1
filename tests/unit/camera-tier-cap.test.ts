import { describe, expect, it } from 'vitest';
import type { BackgroundPlate, EditableObject, Pose } from '@/core/types';
import { quatFromAxisAngle } from '@/core/math';
import type { CameraFrame } from '@/capture/contract';
import { projectPoint } from '@/capture/geom';
import { bearingSpread, capTierForEstimatedDepth, multiViewAgreement } from '@/camera/tier-cap';

const W = 64;
const H = 48;
const FOV = (50 * Math.PI) / 180;

const plate: BackgroundPlate = {
  id: 'p',
  provenance: 'observed_clean_plate',
  version: 'observed_v1',
  region: { min: { x: -0.3, y: -0.005, z: -2.3 }, max: { x: 0.3, y: 0.005, z: -1.7 } },
  coverage: 0.95,
  envelope: { center: { x: 0, y: 0, z: -2 }, radius: 2, maxAngle: 1 },
};

const object = { tier: 'A', tierConfidence: 0.95 } as EditableObject;

/** A camera on a circle around the region centre looking at it, with exact depth of the y=0 plane. */
function frameAt(bearingRad: number, depthSource: CameraFrame['depthSource'], noiseM = 0): CameraFrame {
  const c = plate.envelope.center;
  const r = 2;
  const position = { x: c.x + Math.sin(bearingRad) * r, y: 1.2, z: c.z + Math.cos(bearingRad) * r };
  // yaw to face the centre, then pitch down.
  const yaw = Math.atan2(position.x - c.x, position.z - c.z);
  const pitch = -Math.atan2(position.y - c.y, r);
  const q = mul(quatFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw), quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitch));
  const pose: Pose = { position, rotation: q };
  const depth = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Depth of the plane y=0 at this pixel (via a coarse search: project grid points back). Simpler: leave 0 and fill below.
      depth[y * W + x] = 0;
    }
  }
  // Fill by projecting a dense set of plane points into the frame.
  for (let gz = -4; gz <= 0; gz += 0.02) {
    for (let gx = -2; gx <= 2; gx += 0.02) {
      const proj = projectPoint({ x: gx, y: 0, z: gz }, pose, FOV, W / H, W, H);
      if (!proj) continue;
      const px = Math.floor(proj.x);
      const py = Math.floor(proj.y);
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      depth[py * W + px] = proj.depth + noiseM;
    }
  }
  return { width: W, height: H, rgba: new Uint8ClampedArray(W * H * 4), depth, pose, fovY: FOV, aspect: W / H, timestamp: 0, depthSource };
}

function mul(a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

describe('tier caps for estimated depth', () => {
  it('sensor depth keeps the verified tier', () => {
    const r = capTierForEstimatedDepth(plate, object, [frameAt(0, undefined)]);
    expect(r.cap).toBe('none');
    expect(r.tier).toBe('A');
  });

  it('plane-prior depth caps at C and downgrades provenance', () => {
    const r = capTierForEstimatedDepth(plate, object, [frameAt(0, 'plane-prior')]);
    expect(r.cap).toBe('C');
    expect(r.tier).toBe('C');
    expect(r.plate.provenance).toBe('constrained_surface');
  });

  it('monocular depth from one static viewpoint caps at B', () => {
    const r = capTierForEstimatedDepth(plate, object, [frameAt(0, 'monocular')]);
    expect(r.cap).toBe('B');
    expect(r.tier).toBe('B');
    expect(r.plate.provenance).toBe('multi_view_observed');
  });

  it('monocular depth with agreeing multi-view frames keeps tier A', () => {
    const frames = [frameAt(-0.4, 'monocular'), frameAt(0, 'monocular'), frameAt(0.4, 'monocular')];
    expect(bearingSpread(frames)).toBeGreaterThan((15 * Math.PI) / 180);
    expect(multiViewAgreement(plate, frames)).toBe(true);
    const r = capTierForEstimatedDepth(plate, object, frames);
    expect(r.cap).toBe('none');
    expect(r.tier).toBe('A');
  });

  it('disagreeing monocular frames do not pass agreement', () => {
    const frames = [frameAt(-0.4, 'monocular', 0.3), frameAt(0, 'monocular'), frameAt(0.4, 'monocular', -0.3)];
    expect(multiViewAgreement(plate, frames)).toBe(false);
    expect(capTierForEstimatedDepth(plate, object, frames).tier).toBe('B');
  });

  it('a tripod (no bearing spread) never reaches tier A even with three frames', () => {
    const frames = [frameAt(0, 'monocular'), frameAt(0.01, 'monocular'), frameAt(0.02, 'monocular')];
    expect(multiViewAgreement(plate, frames)).toBe(false);
  });
});
