/**
 * Synthetic support-plate completion (general-camera backend).
 *
 * A single fixed camera can never observe what is *under* a real object -
 * the user cannot lift it out of frame and look. So a plate for the
 * object's footprint cannot be a `clean_plate`/`multi_view`/`constrained`
 * observation (src/capture/plates.ts): none of those exist for this
 * footprint in this session. What we *can* do honestly is inpaint the
 * footprint from the same live frame: every texel inside the footprint
 * takes the colour of the nearest point on the same support-surface plane
 * that the frame actually saw, just outside the footprint (a ring around
 * it). That is nearest-neighbour inpainting, not observation - it is
 * labelled `synthetic_completion` / `completed_v3` and capped at tier D
 * (reality-editor-capture-and-editability.md, "Editability tiers": tier D
 * is "speculative: generative completion only; move/restore/undo; clearly
 * labelled").
 *
 * Texel <-> world mapping matches `src/capture/plates.ts`'s
 * `sampleGridPoints`/texture bake (and what `src/render/plates.ts` expects
 * when it draws `plate.textureRef` over `plate.region`): texel column 0..N
 * maps to world x from `region.min.x`..`region.max.x`, texel row 0..N maps
 * to world z from `region.min.z`..`region.max.z`.
 */
import type { Aabb, BackgroundPlate, EditTier, EditableObject, Vec3 } from '@/core/types';
import type { CameraFrame, PlateTextureRegistry } from '@/capture/contract';
import { inFrame, projectPoint, sampleDepthNearest, sampleNearest } from '@/capture/geom';
import { FILLED_ALPHA } from '@/capture/plates';

export interface SynthesizePlateOptions {
  /** Output texture is textureSize x textureSize. Default 128. */
  textureSize?: number;
  /** How far outside the footprint (m) to look for donor texels. Default 0.25. */
  ringM?: number;
  registry: PlateTextureRegistry;
  now?: () => number;
}

/** A donor sample: a point on the support plane the frame actually saw, plus its colour. */
interface Donor {
  x: number;
  z: number;
  r: number;
  g: number;
  b: number;
}

const DEFAULT_TEXTURE_SIZE = 128;
const DEFAULT_RING_M = 0.25;
const MIN_DONOR_SPACING_M = 0.004;
const DEFAULT_DEPTH_TOLERANCE_M = 0.05;

function donorGridSpacing(region: Aabb, textureSize: number): number {
  const width = region.max.x - region.min.x;
  const depth = region.max.z - region.min.z;
  return Math.max(MIN_DONOR_SPACING_M, Math.max(width, depth) / textureSize);
}

function insideFootprint(x: number, z: number, region: Aabb): boolean {
  return x >= region.min.x && x <= region.max.x && z >= region.min.z && z <= region.max.z;
}

/**
 * Sample candidate donor points on a grid over the ring `[region expanded by
 * ringM] minus region`, at plane y = region's centre y, keeping only the
 * ones the frame actually observed (in-frame, and depth-consistent with the
 * plane when the frame carries depth - so a donor is really on the support
 * plane and not on some other object floating above/below it).
 */
function sampleDonors(
  region: Aabb,
  ringM: number,
  textureSize: number,
  frame: CameraFrame,
): { donors: Donor[]; sampled: number } {
  const spacing = donorGridSpacing(region, textureSize);
  const minX = region.min.x - ringM;
  const maxX = region.max.x + ringM;
  const minZ = region.min.z - ringM;
  const maxZ = region.max.z + ringM;
  const y = (region.min.y + region.max.y) / 2;
  const cols = Math.max(1, Math.round((maxX - minX) / spacing));
  const rows = Math.max(1, Math.round((maxZ - minZ) / spacing));
  const tolerance = frame.depthToleranceM ?? DEFAULT_DEPTH_TOLERANCE_M;

  const donors: Donor[] = [];
  let sampled = 0;

  for (let row = 0; row <= rows; row++) {
    const z = minZ + (row / rows) * (maxZ - minZ);
    for (let col = 0; col <= cols; col++) {
      const x = minX + (col / cols) * (maxX - minX);
      if (insideFootprint(x, z, region)) continue;
      sampled++;

      const point: Vec3 = { x, y, z };
      const proj = projectPoint(point, frame.pose, frame.fovY, frame.aspect, frame.width, frame.height);
      if (!proj || !inFrame(proj, frame.width, frame.height)) continue;

      if (frame.depth) {
        const sampledDepth = sampleDepthNearest(frame.depth, frame.width, frame.height, proj.x, proj.y);
        if (sampledDepth === undefined || Math.abs(sampledDepth - proj.depth) > tolerance) continue;
      }

      const [r, g, b] = sampleNearest(frame.rgba, frame.width, frame.height, proj.x, proj.y);
      donors.push({ x, z, r, g, b });
    }
  }

  return { donors, sampled };
}

/** Spatial hash grid over donors' XZ positions, for fast nearest-neighbour lookup. */
function buildDonorIndex(donors: Donor[], bucketSize: number): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (let i = 0; i < donors.length; i++) {
    const donor = donors[i];
    if (!donor) continue;
    const key = bucketKey(Math.floor(donor.x / bucketSize), Math.floor(donor.z / bucketSize));
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(i);
    } else {
      map.set(key, [i]);
    }
  }
  return map;
}

function bucketKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/** Nearest donor to (x, z) in plane XZ, searching outward ring-by-ring through the bucket grid. */
function nearestDonor(
  x: number,
  z: number,
  donors: Donor[],
  index: Map<string, number[]>,
  bucketSize: number,
): Donor | undefined {
  const cx0 = Math.floor(x / bucketSize);
  const cz0 = Math.floor(z / bucketSize);
  let best: Donor | undefined;
  let bestDistSq = Infinity;
  let foundAtRing = -1;
  const maxRing = 2048;

  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      const onXEdge = dx === -ring || dx === ring;
      for (let dz = -ring; dz <= ring; dz++) {
        if (ring > 0 && !onXEdge && dz !== -ring && dz !== ring) continue;
        const bucket = index.get(bucketKey(cx0 + dx, cz0 + dz));
        if (!bucket) continue;
        for (const idx of bucket) {
          const donor = donors[idx];
          if (!donor) continue;
          const distSq = (donor.x - x) * (donor.x - x) + (donor.z - z) * (donor.z - z);
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = donor;
          }
        }
      }
    }
    if (best && foundAtRing === -1) foundAtRing = ring;
    // Once a candidate is found, search one extra ring (a diagonal donor in
    // that ring can be closer than one already found on-axis) then stop.
    if (foundAtRing !== -1 && ring >= foundAtRing + 1) break;
  }

  return best;
}

export function tierForSyntheticPlate(): 'D' {
  return 'D';
}

export const SYNTHETIC_PLATE_NOTE = 'synthetic completion from one live frame; move only';

export interface SynthesizePlateResult {
  plate: BackgroundPlate;
  donorFraction: number;
}

/**
 * Build a synthetic support plate for `region` (an object's exposed
 * footprint on its support surface) from a single live `frame`: every
 * footprint texel takes the colour of the nearest donor texel sampled from
 * the ring just outside the footprint that the frame actually observed.
 *
 * Honestly labelled: `provenance: 'synthetic_completion'`,
 * `version: 'completed_v3'`, every written texel uses `FILLED_ALPHA` (never
 * 255 - never claims to be observed), `coverage` is the fraction of *ring*
 * donor candidates the frame actually saw (not footprint coverage - the
 * footprint itself was never seen, by construction). The envelope is
 * deliberately tight (radius 1m, ~34deg) because a nearest-plane inpaint is
 * only plausible from close to the pose it was synthesized under; move away
 * and the ruse falls apart.
 */
export function synthesizeSupportPlate(
  object: EditableObject,
  region: Aabb,
  frame: CameraFrame,
  opts: SynthesizePlateOptions,
): SynthesizePlateResult {
  const textureSize = opts.textureSize ?? DEFAULT_TEXTURE_SIZE;
  const ringM = opts.ringM ?? DEFAULT_RING_M;

  const { donors, sampled } = sampleDonors(region, ringM, textureSize, frame);
  const donorFraction = sampled > 0 ? donors.length / sampled : 0;

  const center: Vec3 = {
    x: (region.min.x + region.max.x) / 2,
    y: (region.min.y + region.max.y) / 2,
    z: (region.min.z + region.max.z) / 2,
  };

  if (donors.length === 0) {
    const plate: BackgroundPlate = {
      id: `plate:${object.id}:invalidated`,
      provenance: 'unavailable',
      version: 'invalidated',
      region,
      coverage: 0,
      envelope: { center, radius: 1.0, maxAngle: 0.6 },
    };
    return { plate, donorFraction: 0 };
  }

  const bucketSize = donorGridSpacing(region, textureSize);
  const index = buildDonorIndex(donors, bucketSize);

  const rgba = new Uint8ClampedArray(textureSize * textureSize * 4);
  for (let row = 0; row < textureSize; row++) {
    const z = region.min.z + ((row + 0.5) / textureSize) * (region.max.z - region.min.z);
    for (let col = 0; col < textureSize; col++) {
      const x = region.min.x + ((col + 0.5) / textureSize) * (region.max.x - region.min.x);
      const donor = nearestDonor(x, z, donors, index, bucketSize);
      const outIdx = (row * textureSize + col) * 4;
      if (donor) {
        rgba[outIdx] = donor.r;
        rgba[outIdx + 1] = donor.g;
        rgba[outIdx + 2] = donor.b;
        rgba[outIdx + 3] = FILLED_ALPHA;
      } else {
        rgba[outIdx] = 0;
        rgba[outIdx + 1] = 0;
        rgba[outIdx + 2] = 0;
        rgba[outIdx + 3] = 0;
      }
    }
  }

  const textureRef = `plate:${object.id}:completed_v3`;
  opts.registry.put(textureRef, { width: textureSize, height: textureSize, rgba });

  const plate: BackgroundPlate = {
    id: textureRef,
    provenance: 'synthetic_completion',
    version: 'completed_v3',
    region,
    coverage: donorFraction,
    textureRef,
    envelope: { center, radius: 1.0, maxAngle: 0.6 },
  };

  return { plate, donorFraction };
}

// Kept for callers that want to assert the tier a synthesized plate implies
// without importing TIER_CAPABILITIES machinery.
export type { EditTier };
