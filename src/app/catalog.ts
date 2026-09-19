/**
 * Spawnable 3D asset catalog. Pure TypeScript - no DOM, no three.js. Assets
 * themselves live in `public/assets/*.glb` (see public/assets/LICENSES.md
 * for source/author/license per file); this module only knows their catalog
 * metadata (name, aliases, rough physical footprint) and how to turn one
 * into a fully-populated `EditableObject` ready to `spawn` through the
 * store.
 *
 * Per reality-editor-canonical-architecture.md ("Explicitly out of scope"),
 * this is asset *selection* from a pre-authored, pre-approved library, not
 * text-to-3D generation - every entry here was downloaded and vetted ahead
 * of time (license + size), same as any other spawned primitive.
 *
 * `approxHalfExtents` are rough guesses used only until the glTF finishes
 * loading; `src/app/catalog-fit.ts` (`fitProxiesToBounds`) recomputes the
 * three proxies from the model's real bounding box once it is measured, so
 * physics/interaction/occlusion always match what is actually drawn.
 */
import type { EditableObject, Pose, ProxyShape, Quat, Vec3 } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';

export interface CatalogEntry {
  id: string;
  name: string;
  /** Alternate names/synonyms voice commands may use to refer to this entry. */
  aliases: string[];
  /** URL the GLTFLoader fetches (served from public/assets/, see LICENSES.md). */
  url: string;
  /** Rough half-extents (m) of the model's bounding box, upright, before it has loaded. */
  approxHalfExtents: Vec3;
  massKg: number;
  /** Extra rotation applied so the model sits upright/forward-facing if its authored orientation needs it. */
  uprightRotation?: Quat;
  /** Uniform scale applied on spawn if the model's authored units are not ~1 unit = 1 m for this use. */
  scale?: number;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'chair',
    name: 'Chair',
    aliases: ['chair', 'seat', 'damask chair', 'armchair'],
    url: '/assets/ChairDamaskPurplegold.glb',
    approxHalfExtents: { x: 0.3, y: 0.45, z: 0.3 },
    massKg: 6,
  },
  {
    id: 'vase',
    name: 'Vase',
    aliases: ['vase', 'flower vase', 'flowers', 'glass vase'],
    url: '/assets/GlassVaseFlowers.glb',
    approxHalfExtents: { x: 0.1, y: 0.15, z: 0.1 },
    massKg: 0.8,
  },
  {
    id: 'lamp',
    name: 'Lamp',
    aliases: ['lamp', 'candle holder', 'candle', 'hurricane lamp'],
    url: '/assets/GlassHurricaneCandleHolder.glb',
    approxHalfExtents: { x: 0.12, y: 0.2, z: 0.12 },
    massKg: 1.2,
  },
  {
    id: 'basket',
    name: 'Basket',
    aliases: ['basket', 'wicker basket', 'wicker ball', 'storage basket'],
    url: '/assets/ClearcoatWicker.glb',
    approxHalfExtents: { x: 0.15, y: 0.15, z: 0.15 },
    massKg: 0.5,
  },
  {
    id: 'sunglasses',
    name: 'Sunglasses',
    aliases: ['sunglasses', 'glasses', 'shades'],
    url: '/assets/SunglassesKhronos.glb',
    approxHalfExtents: { x: 0.08, y: 0.03, z: 0.03 },
    massKg: 0.03,
  },
  {
    id: 'fox',
    name: 'Fox figurine',
    aliases: ['fox', 'fox figurine', 'toy fox'],
    url: '/assets/Fox.glb',
    approxHalfExtents: { x: 0.15, y: 0.2, z: 0.3 },
    massKg: 0.3,
    // The Fox sample asset is authored in centimeter-ish units (~100 units tall); scale
    // down to a small figurine footprint matching approxHalfExtents.
    scale: 0.01,
  },
];

/**
 * Case-insensitive lookup by id, exact/alias name, or unambiguous alias
 * prefix. Returns undefined when nothing matches (caller treats that as
 * "unrecognized", same as the rest of the voice grammar).
 */
export function findCatalogEntry(text: string): CatalogEntry | undefined {
  const q = text.trim().toLowerCase();
  if (!q) return undefined;

  const byId = CATALOG.find((e) => e.id.toLowerCase() === q);
  if (byId) return byId;

  const byExactAlias = CATALOG.find(
    (e) => e.name.toLowerCase() === q || e.aliases.some((a) => a.toLowerCase() === q),
  );
  if (byExactAlias) return byExactAlias;

  // Prefix match, only when it uniquely identifies one entry.
  const prefixMatches = CATALOG.filter(
    (e) => e.name.toLowerCase().startsWith(q) || e.aliases.some((a) => a.toLowerCase().startsWith(q)),
  );
  if (prefixMatches.length === 1) return prefixMatches[0];

  return undefined;
}

let spawnCounter = 0;

/**
 * Build a fully-populated EditableObject for a catalog entry at `pose`, with
 * a placeholder proxy sized from `approxHalfExtents` (refined later by
 * `fitProxiesToBounds` once the glTF's real bounds are known). Tier A / fully
 * approved / physical, same as `spawnPrimitive` in src/app/main.ts.
 */
export function buildCatalogObject(entry: CatalogEntry, pose: Pose, id?: string, now = 0): EditableObject {
  spawnCounter += 1;
  const objectId = id ?? `catalog-${entry.id}-${spawnCounter}-${Date.now()}`;
  const proxy: ProxyShape = { kind: 'box', halfExtents: { ...entry.approxHalfExtents } };
  const rotation: Quat = entry.uprightRotation
    ? { ...entry.uprightRotation }
    : { ...pose.rotation };
  const finalPose: Pose = { position: { ...pose.position }, rotation };

  return {
    id: objectId,
    label: 'other',
    userName: entry.name,
    origin: 'spawned',
    originalPose: finalPose,
    currentPose: finalPose,
    visual: { kind: 'gltf', url: entry.url },
    interactionProxy: proxy,
    collisionProxy: { ...proxy, halfExtents: { ...proxy.halfExtents } },
    occlusionProxy: { ...proxy, halfExtents: { ...proxy.halfExtents } },
    supportSurfaces: [],
    background: [],
    provenance: { method: 'spawned', capturedAt: now, capturePath: [finalPose] },
    tier: 'A',
    tierConfidence: 1,
    envelope: { center: finalPose.position, radius: 3, maxAngle: Math.PI },
    physical: { massKg: entry.massKg, friction: 0.5, restitution: 0.15, kinematic: false },
    approved: true,
    visible: true,
  };
}

export default CATALOG;
