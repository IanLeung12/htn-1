/**
 * Captured-shell "wow mode" room reconstruction: turns the room-orbit frames
 * captured by `AppHandle.captureRoomShell` (src/app/room-shell.ts's viewpoint
 * plan) into a baked, spatially tiled textured mesh, per
 * reality-editor-canonical-architecture.md's "Representation choices: Room"
 * ("a baked spatially tiled textured mesh, partitioned so it can be carved
 * into live regions").
 *
 * Pipeline, run once whenever the set of room-shell frames changes (never
 * per rendered frame - see `update()`):
 *
 *  1. For each room frame, get its full (unfiltered) depth-mesh geometry via
 *     `getDepthMeshGeometry` (render/depth-mesh.ts) - the same per-pixel
 *     RGB-D unprojection BackgroundHull uses, just without a `keepInsideBox`
 *     filter, since here we want the whole frame, not one object's box.
 *  2. Triangles whose centroid falls inside a carved object's original
 *     occlusion box (a hidden/moved physical object, same rule as
 *     render/shell.ts's global-mesh carve) are dropped, so the shell never
 *     bakes in an object that is no longer really there.
 *  3. Surviving triangles are bucketed by centroid into 1.5m x 1.5m XZ tiles
 *     (`TILE_SIZE_M`) - independent of which frame they came from, so a tile
 *     can later be hidden/shown as a unit when the region(s) over it change
 *     state, without touching any other tile.
 *  4. Room-orbit viewpoints deliberately overlap in coverage, so several
 *     frames often see the same tile; for each tile the one frame with the
 *     MOST surviving triangles there wins and becomes that tile's single
 *     `THREE.Mesh` (unlit, direct-UV, see `createUnlitTextureMaterial` in
 *     render/projective.ts), `renderOrder = 0`, `depthWrite = true` - same
 *     draw-order contract as every other shell tile (see render/shell.ts's
 *     header comment: shell draws before the XR depth occlusion mesh and
 *     before editable objects). Rendering every overlapping frame at once
 *     instead would z-fight (two reconstructions of the same physical
 *     surface a few millimetres apart from per-pixel depth noise/
 *     subsampling) and read as visual static, not a clean baked tile.
 *
 * Memory budget (see reality-editor-runtime-budget.md): total vertices
 * across every tile/frame mesh is capped at `MAX_TOTAL_VERTICES`; when the
 * raw per-pixel reconstruction would exceed it, triangles are subsampled
 * (a deterministic stride, not a random drop) so the cap always holds.
 *
 * Visibility: on every `update()` (which IS called every rendered frame,
 * unlike the (re)build above) each tile is shown only when every region
 * whose bounds overlap the tile's XZ footprint is CAPTURED or HYBRID - a
 * FALLBACK/LIVE/TRANSITION region carves its footprint out of the shell so
 * live passthrough shows through there instead (the "carved into live
 * regions" requirement). A tile with no overlapping region at all (most of
 * a room's walls/ceiling have no tracked surface) defaults to visible.
 */
import * as THREE from 'three';
import type { Region, SceneSnapshot } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import { getDepthMeshGeometry } from './depth-mesh';
import { createUnlitTextureMaterial, setUnlitMaterialFrame } from './projective';

/** XZ grid size a room frame's triangles are bucketed into. */
export const TILE_SIZE_M = 1.5;

/** Total vertex budget across every tile/frame mesh (see runtime-budget.md). */
export const MAX_TOTAL_VERTICES = 1_200_000;

export interface CarveBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface RoomShellStats {
  tiles: number;
  vertices: number;
  texturesMB: number;
}

/** Stable "ix,iz" key for a tile at grid coordinates `ix`,`iz`. */
export function tileKey(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

/** Grid coordinate a world XZ point falls into. */
export function tileCoordFor(x: number, z: number): { ix: number; iz: number } {
  return { ix: Math.floor(x / TILE_SIZE_M), iz: Math.floor(z / TILE_SIZE_M) };
}

/** World-space XZ bounds of tile `ix`,`iz`. */
export function tileBoundsFor(ix: number, iz: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return { minX: ix * TILE_SIZE_M, maxX: (ix + 1) * TILE_SIZE_M, minZ: iz * TILE_SIZE_M, maxZ: (iz + 1) * TILE_SIZE_M };
}

function insideAnyCarveBox(x: number, y: number, z: number, boxes: CarveBox[]): boolean {
  for (const box of boxes) {
    if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z && y > box.min.y && y <= box.max.y) {
      return true;
    }
  }
  return false;
}

/**
 * One triangle (3 source-geometry vertex indices) surviving the carve
 * filter, tagged with the tile it belongs to. Built once per frame in
 * `collectTriangles` below.
 */
interface Tri {
  ix: number;
  iz: number;
  a: number;
  b: number;
  c: number;
}

/** Every surviving triangle of `frame`'s full depth mesh, tagged by tile, carve-filtered. */
function collectTriangles(frame: CameraFrame, carveBoxes: CarveBox[]): { geometry: THREE.BufferGeometry; tris: Tri[] } | null {
  const geometry = getDepthMeshGeometry(frame);
  if (!geometry) return null;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!position || !index) return null;

  const tris: Tri[] = [];
  const triCount = index.count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    const cx = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const cy = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
    const cz = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
    if (carveBoxes.length > 0 && insideAnyCarveBox(cx, cy, cz, carveBoxes)) continue;
    const { ix, iz } = tileCoordFor(cx, cz);
    tris.push({ ix, iz, a, b, c });
  }
  return { geometry, tris };
}

/** Build a standalone (remapped, deduplicated) BufferGeometry for a subset of `tris` referencing `source`. */
function buildSubsetGeometry(source: THREE.BufferGeometry, tris: Tri[]): THREE.BufferGeometry {
  const srcPos = source.getAttribute('position');
  const srcUv = source.getAttribute('uv');
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const mapIndex = (i: number): number => {
    let mapped = remap.get(i);
    if (mapped !== undefined) return mapped;
    mapped = positions.length / 3;
    positions.push(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i));
    if (srcUv) uvs.push(srcUv.getX(i), srcUv.getY(i));
    remap.set(i, mapped);
    return mapped;
  };

  for (const tri of tris) {
    indices.push(mapIndex(tri.a), mapIndex(tri.b), mapIndex(tri.c));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (uvs.length > 0) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

interface TileFrameMesh {
  mesh: THREE.Mesh;
  vertexCount: number;
  ix: number;
  iz: number;
}

/** True when every region overlapping a tile's XZ footprint is CAPTURED/HYBRID; true (default-visible) when none overlap. */
export function tileVisibleForRegions(ix: number, iz: number, regions: Region[]): boolean {
  const { minX, maxX, minZ, maxZ } = tileBoundsFor(ix, iz);
  for (const region of regions) {
    const b = region.bounds;
    const overlapsXZ = b.min.x < maxX && b.max.x > minX && b.min.z < maxZ && b.max.z > minZ;
    if (!overlapsXZ) continue;
    if (region.state !== 'CAPTURED' && region.state !== 'HYBRID') return false;
  }
  return true; // no overlapping region (or all are CAPTURED/HYBRID): visible
}

export class RoomShellRenderer {
  readonly group = new THREE.Group();

  private tileFrameMeshes: TileFrameMesh[] = [];
  private textureBytesMB = 0;
  /** Frame array identity + carve signature this build was made from; rebuilt only when either changes. */
  private builtFromFrames: CameraFrame[] | undefined;
  private builtCarveSignature = '';

  /** (Re)build tile meshes from `frames`, dropping triangles inside `carveBoxes`, capped at `MAX_TOTAL_VERTICES`. */
  rebuild(frames: CameraFrame[] | undefined, carveBoxes: CarveBox[], carveSignature: string): void {
    if (this.builtFromFrames === frames && this.builtCarveSignature === carveSignature) return;
    this.builtFromFrames = frames;
    this.builtCarveSignature = carveSignature;

    this.group.clear();
    this.tileFrameMeshes = [];
    this.textureBytesMB = 0;
    if (!frames || frames.length === 0) return;

    const perFrame: Array<{ frame: CameraFrame; geometry: THREE.BufferGeometry; tris: Tri[] }> = [];
    let totalTris = 0;
    for (const frame of frames) {
      const collected = collectTriangles(frame, carveBoxes);
      if (!collected || collected.tris.length === 0) continue;
      perFrame.push({ frame, geometry: collected.geometry, tris: collected.tris });
      totalTris += collected.tris.length;
    }
    if (totalTris === 0) return;

    // Rough vertex/triangle ratio for a grid mesh is close to 0.5-1x (shared
    // vertices), but our per-tile subset geometries re-index (no cross-tile
    // sharing), so budget conservatively as ~1 unique vertex per triangle
    // (an upper bound - a stride only needs to make the WORST case fit).
    const stride = Math.max(1, Math.ceil(totalTris / MAX_TOTAL_VERTICES));

    const byTile = new Map<string, Map<CameraFrame, Tri[]>>();
    for (const { frame, tris } of perFrame) {
      for (let i = 0; i < tris.length; i += stride) {
        const tri = tris[i]!;
        const key = tileKey(tri.ix, tri.iz);
        let byFrame = byTile.get(key);
        if (!byFrame) {
          byFrame = new Map();
          byTile.set(key, byFrame);
        }
        let list = byFrame.get(frame);
        if (!list) {
          list = [];
          byFrame.set(frame, list);
        }
        list.push(tri);
      }
    }

    const geometryByFrame = new Map<CameraFrame, THREE.BufferGeometry>();
    for (const { frame, geometry } of perFrame) geometryByFrame.set(frame, geometry);

    // Winner-take-all per tile: the room-orbit viewpoints deliberately
    // overlap in coverage (see src/app/room-shell.ts's 3-ring + centre
    // plan), so several frames often reconstruct the SAME tile from
    // slightly different angles. Rendering all of them at once would z-fight
    // (each frame's unprojection lands at a slightly different world
    // position for the same physical surface, a few mm apart from per-pixel
    // depth noise/subsampling) and read as visual static; a single "best
    // coverage" frame per tile is both cheaper and free of that artifact,
    // and is still a faithful partition of the room ("a baked spatially
    // tiled textured mesh" - each tile just has exactly one source texture).
    const usedTextures = new Set<CameraFrame>();
    for (const [key, byFrame] of byTile) {
      const [ixStr, izStr] = key.split(',');
      const ix = Number(ixStr);
      const iz = Number(izStr);
      let bestFrame: CameraFrame | undefined;
      let bestTris: Tri[] | undefined;
      for (const [frame, tris] of byFrame) {
        if (!bestTris || tris.length > bestTris.length) {
          bestFrame = frame;
          bestTris = tris;
        }
      }
      if (!bestFrame || !bestTris) continue;

      const source = geometryByFrame.get(bestFrame)!;
      const subset = buildSubsetGeometry(source, bestTris);
      const material = createUnlitTextureMaterial();
      setUnlitMaterialFrame(material, bestFrame);
      material.depthWrite = true;
      const mesh = new THREE.Mesh(subset, material);
      mesh.renderOrder = 0;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.name = `room-shell-tile:${key}:${bestFrame.timestamp}`;
      this.group.add(mesh);
      const vertexCount = subset.getAttribute('position').count;
      this.tileFrameMeshes.push({ mesh, vertexCount, ix, iz });
      usedTextures.add(bestFrame);
    }

    let textureBytes = 0;
    for (const frame of usedTextures) textureBytes += frame.width * frame.height * 4;
    this.textureBytesMB = textureBytes / (1024 * 1024);
  }

  /** Call every rendered frame: cheap visibility toggling only, no allocation/rebuild. */
  updateVisibility(snapshot: SceneSnapshot): void {
    const regions = Object.values(snapshot.regions);
    for (const tfm of this.tileFrameMeshes) {
      tfm.mesh.visible = tileVisibleForRegions(tfm.ix, tfm.iz, regions);
    }
  }

  stats(): RoomShellStats {
    const tiles = new Set(this.tileFrameMeshes.map((t) => tileKey(t.ix, t.iz))).size;
    let vertices = 0;
    for (const t of this.tileFrameMeshes) vertices += t.vertexCount;
    return { tiles, vertices, texturesMB: this.textureBytesMB };
  }

  dispose(): void {
    this.group.clear();
    this.tileFrameMeshes = [];
  }
}
