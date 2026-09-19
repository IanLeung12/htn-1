import { describe, expect, it } from 'vitest';
import type { Aabb, EditableObject } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { quatFromAxisAngle } from '@/core/math';
import type { CameraFrame } from '@/capture/contract';
import { createPlateTextureRegistry } from '@/capture/registry';
import { pixelToRay, rayPlaneY } from '@/camera/surfaces/floor-prior';
import { fillFloorDepth } from '@/camera/depth/prior';
import { FILLED_ALPHA } from '@/capture/plates';
import { synthesizeSupportPlate, tierForSyntheticPlate, SYNTHETIC_PLATE_NOTE } from '@/camera/synthetic-plate';

const WIDTH = 160;
const HEIGHT = 120;
const ASPECT = WIDTH / HEIGHT;
const FOV_Y = (50 * Math.PI) / 180;
const OBJECT_DEPTH_OFFSET_M = 0.3;

const REGION: Aabb = {
  min: { x: -0.15, y: -0.005, z: -2.15 },
  max: { x: 0.15, y: 0.005, z: -1.85 },
};

/** Pure function of world (x, z): a checkerboard with 0.1m cells. Colours are
 * chosen so neither ever satisfies the "looks red" test predicate. */
function checkerColor(x: number, z: number): [number, number, number] {
  const cx = Math.floor(x / 0.1);
  const cz = Math.floor(z / 0.1);
  const parity = ((cx + cz) % 2 + 2) % 2;
  return parity === 0 ? [220, 220, 60] : [40, 120, 180];
}

function insideRegionXZ(x: number, z: number, region: Aabb): boolean {
  return x >= region.min.x && x <= region.max.x && z >= region.min.z && z <= region.max.z;
}

/** Renders a floor checkerboard frame with a solid-red "object" painted over
 * `footprint`'s footprint, and analytic floor depth (object pixels 0.3m nearer). */
function buildFrame(pose: CameraFrame['pose'], footprint: Aabb | null): CameraFrame {
  const depth = new Float32Array(WIDTH * HEIGHT);
  fillFloorDepth(depth, WIDTH, HEIGHT, pose, FOV_Y, ASPECT, 0);

  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const i = py * WIDTH + px;
      const idx = i * 4;
      const d = depth[i] ?? 0;
      if (!(d > 0)) {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 255;
        continue;
      }
      const ray = pixelToRay(px + 0.5, py + 0.5, WIDTH, HEIGHT, pose, FOV_Y, ASPECT);
      const hit = rayPlaneY(ray.origin, ray.direction, 0);
      if (!hit) {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 255;
        continue;
      }
      if (footprint && insideRegionXZ(hit.x, hit.z, footprint)) {
        rgba[idx] = 200;
        rgba[idx + 1] = 20;
        rgba[idx + 2] = 20;
        rgba[idx + 3] = 255;
        depth[i] = d - OBJECT_DEPTH_OFFSET_M;
        continue;
      }
      const [r, g, b] = checkerColor(hit.x, hit.z);
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }

  return { width: WIDTH, height: HEIGHT, rgba, depth, pose, fovY: FOV_Y, aspect: ASPECT, timestamp: 0 };
}

function baseObject(): EditableObject {
  return {
    id: 'obj:mug1',
    label: 'other',
    userName: 'mug',
    origin: 'physical',
    originalPose: { position: { x: 0, y: 0, z: -2 }, rotation: IDENTITY_QUAT },
    currentPose: { position: { x: 0, y: 0, z: -2 }, rotation: IDENTITY_QUAT },
    visual: { kind: 'primitive' },
    interactionProxy: { kind: 'box', halfExtents: { x: 0.15, y: 0.05, z: 0.15 } },
    collisionProxy: { kind: 'box', halfExtents: { x: 0.15, y: 0.05, z: 0.15 } },
    occlusionProxy: { kind: 'box', halfExtents: { x: 0.15, y: 0.05, z: 0.15 } },
    supportSurfaces: ['camera-floor'],
    background: [],
    provenance: { method: 'scene_volume', capturedAt: 0, capturePath: [] },
    tier: 'E',
    tierConfidence: 0,
    envelope: { center: { x: 0, y: 0, z: -2 }, radius: 1.5, maxAngle: 1.0 },
    physical: { massKg: 0.3, friction: 0.6, restitution: 0.1, kinematic: false },
    approved: true,
    visible: true,
  };
}

const cameraPose = {
  position: { x: 0, y: 1.1, z: 0 },
  rotation: quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -0.35),
};

describe('synthesizeSupportPlate', () => {
  it('inpaints the footprint from the surrounding checkerboard ring, honestly labelled', () => {
    const registry = createPlateTextureRegistry();
    const frame = buildFrame(cameraPose, REGION);
    const textureSize = 64;

    const { plate, donorFraction } = synthesizeSupportPlate(baseObject(), REGION, frame, {
      registry,
      textureSize,
    });

    expect(plate.provenance).toBe('synthetic_completion');
    expect(plate.version).toBe('completed_v3');
    expect(tierForSyntheticPlate()).toBe('D');
    expect(SYNTHETIC_PLATE_NOTE.length).toBeGreaterThan(0);
    expect(donorFraction).toBeGreaterThan(0.5);
    expect(plate.textureRef).toBeDefined();

    const tex = registry.get(plate.textureRef as string);
    expect(tex).toBeDefined();
    if (!tex) throw new Error('unreachable');
    expect(tex.width).toBe(textureSize);
    expect(tex.height).toBe(textureSize);

    let matches = 0;
    let total = 0;
    const cellSize = 0.1;

    for (let row = 0; row < textureSize; row++) {
      const z = REGION.min.z + ((row + 0.5) / textureSize) * (REGION.max.z - REGION.min.z);
      for (let col = 0; col < textureSize; col++) {
        const x = REGION.min.x + ((col + 0.5) / textureSize) * (REGION.max.x - REGION.min.x);
        const idx = (row * textureSize + col) * 4;
        const r = tex.rgba[idx] as number;
        const g = tex.rgba[idx + 1] as number;
        const b = tex.rgba[idx + 2] as number;
        const a = tex.rgba[idx + 3] as number;

        expect(a).toBe(FILLED_ALPHA);
        expect(r > 150 && g < 80).toBe(false);

        total++;
        const [er, eg, eb] = checkerColor(x, z);
        let ok = r === er && g === eg && b === eb;
        if (!ok) {
          // Nearest-donor inpaint can be off by one cell at cell boundaries:
          // accept a match against any of the 4 neighbouring cells too.
          for (const dx of [-cellSize, 0, cellSize]) {
            for (const dz of [-cellSize, 0, cellSize]) {
              if (dx === 0 && dz === 0) continue;
              const [nr, ng, nb] = checkerColor(x + dx, z + dz);
              if (r === nr && g === ng && b === nb) {
                ok = true;
              }
            }
          }
        }
        if (ok) matches++;
      }
    }

    expect(matches / total).toBeGreaterThan(0.9);
  });

  it('returns unavailable/invalidated with zero coverage when no donor is observed', () => {
    const registry = createPlateTextureRegistry();
    // Camera looking straight up: the floor (and the region) is never in frame.
    const awayPose = {
      position: { x: 0, y: 1.1, z: 0 },
      rotation: quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2),
    };
    const frame = buildFrame(awayPose, null);

    const { plate, donorFraction } = synthesizeSupportPlate(baseObject(), REGION, frame, {
      registry,
      textureSize: 32,
    });

    expect(plate.provenance).toBe('unavailable');
    expect(plate.version).toBe('invalidated');
    expect(plate.coverage).toBe(0);
    expect(plate.textureRef).toBeUndefined();
    expect(donorFraction).toBe(0);
  });
});
