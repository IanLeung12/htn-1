/**
 * Room shell tiles built from detected surfaces (planes) and the raw global
 * mesh from scene-understanding. Two roles, chosen per surface's owning
 * Region state:
 *
 *  - LIVE/FALLBACK/TRANSITION regions: the shell tile is an invisible
 *    occluder/collider only (colorWrite disabled, depthWrite enabled) so
 *    passthrough shows the real surface but spawned objects still correctly
 *    go behind real furniture even when the XR depth-sensing API is absent
 *    (see xr/depth.ts for how this composes with the depth-sensing mesh
 *    when it *is* present).
 *  - CAPTURED/HYBRID regions: the tile renders visibly (textured if a plate
 *    is available, else a neutral material), i.e. captured-shell mode.
 *
 * Rendering order: shell tiles are drawn before the XR depth occlusion mesh
 * (see xr/depth.ts comment) so our own static geometry is never fighting the
 * lower-resolution/laggier depth-sensing estimate for the same real surface.
 */
import * as THREE from 'three';
import type { EditableObject, Region, SceneSnapshot, Surface, Vec3 } from '@/core/types';
import type { RawGlobalMesh } from '@/xr/scene-understanding';
import type { CameraFrame } from '@/capture/contract';
import type { FrameStore } from '@/capture/frame-store';
import { ROOM_SHELL_FRAME_ID } from '@/capture/frame-store';
import { inFrame, projectPoint } from '@/capture/geom';
import { quatRotateVec3 } from '@/core/math';
import { createProjectiveMaterial, setMaterialFrame } from './projective';

/** Padding added around a carved object's original box, except downward (never eats the floor). */
const CARVE_EXPAND_M = 0.03;

/** True for a physical object that should have its original footprint carved out of the global mesh: hidden, or displaced from where it was captured. */
function isCarved(obj: EditableObject): boolean {
  if (obj.origin !== 'physical') return false;
  if (!obj.visible) return true;
  const a = obj.originalPose.position;
  const b = obj.currentPose.position;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0.005;
}

interface CarveBox {
  min: Vec3;
  max: Vec3;
}

/** World-space carve box for a physical object's ORIGINAL occlusion proxy, expanded 3cm (never below its bottom face). */
function carveBoxFor(obj: EditableObject): CarveBox | undefined {
  const proxy = obj.occlusionProxy;
  if (proxy.kind !== 'box') return undefined;
  const c = obj.originalPose.position;
  const he = proxy.halfExtents;
  return {
    min: { x: c.x - he.x - CARVE_EXPAND_M, y: c.y - he.y, z: c.z - he.z - CARVE_EXPAND_M },
    max: { x: c.x + he.x + CARVE_EXPAND_M, y: c.y + he.y + CARVE_EXPAND_M, z: c.z + he.z + CARVE_EXPAND_M },
  };
}

/** Stable signature for a set of carved object ids, so the filtered index is only rebuilt when the set actually changes. */
function carveSignature(ids: string[]): string {
  return ids.slice().sort().join(',');
}

/** Returns a new index dropping triangles whose centroid falls inside any carve box (above its bottom face), or null if nothing was removed. */
function carveGlobalMeshIndex(mesh: THREE.Mesh, boxes: CarveBox[]): THREE.BufferAttribute | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position || boxes.length === 0) return null;
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : position.count / 3;
  const keep: number[] = [];
  const v = new THREE.Vector3();
  const c = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  let removed = 0;
  for (let t = 0; t < triCount; t++) {
    const a = index ? index.getX(t * 3) : t * 3;
    const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const d = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    c.set(0, 0, 0);
    for (const i of [a, b, d]) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      c.add(v);
    }
    c.multiplyScalar(1 / 3);
    let inside = false;
    for (const box of boxes) {
      if (
        c.x >= box.min.x && c.x <= box.max.x &&
        c.z >= box.min.z && c.z <= box.max.z &&
        c.y > box.min.y && c.y <= box.max.y
      ) {
        inside = true;
        break;
      }
    }
    if (inside) {
      removed++;
      continue;
    }
    keep.push(a, b, d);
  }
  if (removed === 0) return null;
  return new THREE.BufferAttribute(new Uint32Array(keep), 1);
}

function regionForSurface(snapshot: SceneSnapshot, surfaceId: string): Region | undefined {
  for (const region of Object.values(snapshot.regions)) {
    if (region.surfaces.includes(surfaceId)) return region;
  }
  return undefined;
}

function isVisibleShellState(region: Region | undefined): boolean {
  if (!region) return false;
  return region.state === 'CAPTURED' || region.state === 'HYBRID';
}

/**
 * Best room-shell frame for a surface: must see the surface centre in-frame,
 * and among those, the one whose view direction is most head-on to the
 * surface (dot(forward, normal) most negative).
 */
function pickBestFrame(frames: CameraFrame[], centre: Vec3, normal: Vec3): CameraFrame | undefined {
  let best: CameraFrame | undefined;
  let bestScore = -Infinity;
  for (const frame of frames) {
    const proj = projectPoint(centre, frame.pose, frame.fovY, frame.aspect, frame.width, frame.height);
    if (!proj || !inFrame(proj, frame.width, frame.height)) continue;
    const forward = quatRotateVec3(frame.pose.rotation, { x: 0, y: 0, z: -1 });
    const score = -(forward.x * normal.x + forward.y * normal.y + forward.z * normal.z);
    if (score > bestScore) {
      bestScore = score;
      best = frame;
    }
  }
  return best;
}

interface GlobalMeshEntry {
  mesh: THREE.Mesh;
  /** Full, uncarved index as received from scene understanding. */
  originalIndex: THREE.BufferAttribute;
  /** Signature (see carveSignature) the currently-applied index was built from; '' means uncarved. */
  appliedCarveSignature: string;
}

interface SurfaceEntry {
  mesh: THREE.Mesh;
  lastChanged: number;
  flatMaterial: THREE.MeshStandardMaterial;
  projMaterial: THREE.ShaderMaterial;
  usingProjective: boolean;
  selectedFrame: CameraFrame | undefined;
}

export class ShellRenderer {
  /** Occluder-only meshes: colorWrite off, depthWrite on. Render FIRST. */
  readonly occluderGroup = new THREE.Group();
  /** Visible captured-shell meshes. Also rendered as part of the first pass. */
  readonly visibleGroup = new THREE.Group();

  private readonly surfaceEntries = new Map<string, SurfaceEntry>();
  private readonly globalMeshEntries = new Map<string, GlobalMeshEntry>();
  private lastVersion = -1;
  /** Recomputed only when `version` changes; the carved object id set drives both the global-mesh index cache and hiding an object's own surface tile. */
  private carvedObjectIds = new Set<string>();
  private carveBoxes: CarveBox[] = [];
  private carveSignatureValue = '';

  constructor(private readonly frameStore?: FrameStore) {}

  update(snapshot: SceneSnapshot, globalMeshes: RawGlobalMesh[]): void {
    // Regions live inside the snapshot (see core/types SceneSnapshot.regions), so
    // any region-state transition already bumps `version` like every other
    // committed intent; when the version is unchanged there is nothing new to
    // place, so skip re-deriving visibility (previously this ran every frame,
    // allocating `Object.values(snapshot.regions)` per surface for no reason).
    if (snapshot.version !== this.lastVersion) {
      this.lastVersion = snapshot.version;
      this.carvedObjectIds.clear();
      this.carveBoxes = [];
      for (const obj of Object.values(snapshot.objects)) {
        if (!isCarved(obj)) continue;
        this.carvedObjectIds.add(obj.id);
        const box = carveBoxFor(obj);
        if (box) this.carveBoxes.push(box);
      }
      this.carveSignatureValue = carveSignature(Array.from(this.carvedObjectIds));
      this.syncSurfaces(snapshot);
    }
    this.syncGlobalMeshes(globalMeshes, snapshot.mode);
  }

  private syncSurfaces(snapshot: SceneSnapshot): void {
    const seen = new Set<string>();
    for (const surface of Object.values(snapshot.surfaces)) {
      seen.add(surface.id);
      this.syncSurface(surface, snapshot);
    }
    for (const [id, entry] of this.surfaceEntries) {
      if (!seen.has(id)) {
        this.occluderGroup.remove(entry.mesh);
        this.visibleGroup.remove(entry.mesh);
        this.surfaceEntries.delete(id);
      }
    }
  }

  private buildGeometry(surface: Surface): THREE.BufferGeometry {
    if (surface.polygon.length >= 3) {
      const shape = new THREE.Shape(surface.polygon.map((p) => new THREE.Vector2(p.x, p.z)));
      const geometry = new THREE.ShapeGeometry(shape);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
    const width = Math.max(surface.aabb.max.x - surface.aabb.min.x, 0.01);
    const depth = Math.max(surface.aabb.max.z - surface.aabb.min.z, 0.01);
    const geometry = new THREE.PlaneGeometry(width, depth);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  }

  private syncSurface(surface: Surface, snapshot: SceneSnapshot): void {
    let entry = this.surfaceEntries.get(surface.id);
    if (!entry || entry.lastChanged !== surface.lastChanged) {
      const geometry = this.buildGeometry(surface);
      const flatMaterial = new THREE.MeshStandardMaterial({ color: 0x778899 });
      const mesh = new THREE.Mesh(geometry, flatMaterial);
      // renderOrder 0: shell draws first so it claims the depth buffer before
      // the XR depth occlusion mesh (renderOrder 1, see xr/depth.ts) and
      // editable objects (renderOrder 2, see render/objects.ts).
      mesh.renderOrder = 0;
      mesh.position.set(surface.pose.position.x, surface.pose.position.y, surface.pose.position.z);
      mesh.quaternion.set(
        surface.pose.rotation.x,
        surface.pose.rotation.y,
        surface.pose.rotation.z,
        surface.pose.rotation.w,
      );
      if (entry) {
        this.occluderGroup.remove(entry.mesh);
        this.visibleGroup.remove(entry.mesh);
      }
      entry = {
        mesh,
        lastChanged: surface.lastChanged,
        flatMaterial,
        projMaterial: createProjectiveMaterial(),
        usingProjective: false,
        selectedFrame: undefined,
      };
      this.surfaceEntries.set(surface.id, entry);
    }
    this.placeSurface(surface, entry, snapshot);
  }

  private placeSurface(surface: Surface, entry: SurfaceEntry, snapshot: SceneSnapshot): void {
    this.occluderGroup.remove(entry.mesh);
    this.visibleGroup.remove(entry.mesh);

    // A physical object's own shell tile (its "box" surface, keyed by the
    // same id - see src/render/objects.ts's `entry.appearanceGroup` for the
    // corresponding live-overlay treatment) must disappear while the object
    // is hidden or moved: the background plate/hull already covers the
    // exposed region behind/around it in both modes, so leaving this tile
    // rendered would draw the object's old shell box right on top of that.
    if (this.carvedObjectIds.has(surface.id)) return;

    const region = regionForSurface(snapshot, surface.id);
    const visible = isVisibleShellState(region);

    if (visible) {
      // CAPTURED/HYBRID: texture from the nearest room-shell viewpoint that
      // actually sees this surface, if one was ever captured (see
      // AppHandle.captureRoomShell); otherwise fall back to the flat tile.
      const roomFrames = this.frameStore?.get(ROOM_SHELL_FRAME_ID);
      const centre: Vec3 = {
        x: (surface.aabb.min.x + surface.aabb.max.x) / 2,
        y: (surface.aabb.min.y + surface.aabb.max.y) / 2,
        z: (surface.aabb.min.z + surface.aabb.max.z) / 2,
      };
      const normal = quatRotateVec3(surface.pose.rotation, { x: 0, y: 1, z: 0 });
      const best = roomFrames && roomFrames.length > 0 ? pickBestFrame(roomFrames, centre, normal) : undefined;

      if (best) {
        if (entry.mesh.material !== entry.projMaterial || entry.selectedFrame !== best) {
          setMaterialFrame(entry.projMaterial, best);
          entry.mesh.material = entry.projMaterial;
          entry.usingProjective = true;
          entry.selectedFrame = best;
        }
      } else {
        entry.mesh.material = entry.flatMaterial;
        entry.usingProjective = false;
        entry.selectedFrame = undefined;
      }

      const material = entry.mesh.material as THREE.Material;
      material.colorWrite = true;
      material.depthWrite = true;
      this.visibleGroup.add(entry.mesh);
    } else {
      // Invisible occluder/collider: still write depth so it participates in
      // z-testing against spawned objects, but never contributes color.
      // Always the flat material here - no point paying for the shader when
      // nothing is drawn.
      entry.mesh.material = entry.flatMaterial;
      entry.usingProjective = false;
      entry.flatMaterial.colorWrite = false;
      entry.flatMaterial.depthWrite = true;
      this.occluderGroup.add(entry.mesh);
    }
  }

  private syncGlobalMeshes(globalMeshes: RawGlobalMesh[], mode: SceneSnapshot['mode']): void {
    const seen = new Set<string>();
    const signature = this.carveSignatureValue;
    for (const gm of globalMeshes) {
      seen.add(gm.id);
      let entry = this.globalMeshEntries.get(gm.id);
      if (!entry) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(gm.vertices, 3));
        const originalIndex = new THREE.BufferAttribute(gm.indices, 1);
        geometry.setIndex(originalIndex);
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: 0x556677 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 0;
        entry = { mesh, originalIndex, appliedCarveSignature: '' };
        this.globalMeshEntries.set(gm.id, entry);
        this.occluderGroup.add(mesh);
      }
      const mesh = entry.mesh;
      mesh.position.set(gm.pose.position.x, gm.pose.position.y, gm.pose.position.z);
      mesh.quaternion.set(gm.pose.rotation.x, gm.pose.rotation.y, gm.pose.rotation.z, gm.pose.rotation.w);

      // Captured-shell carve: drop triangles belonging to a hidden/moved
      // physical object's original footprint (expanded 3cm, never below its
      // bottom face) so the global mesh doesn't keep drawing an object that
      // is no longer really there (see STATE.md's former "Known
      // limitations" entry on this). Rebuilt only when the carved-object set
      // actually changes for this mesh, not every frame/version.
      if (entry.appliedCarveSignature !== signature) {
        entry.appliedCarveSignature = signature;
        const filtered = this.carveBoxes.length > 0 ? carveGlobalMeshIndex(mesh, this.carveBoxes) : null;
        mesh.geometry.setIndex(filtered ?? entry.originalIndex);
      }

      const material = mesh.material as THREE.MeshStandardMaterial;
      // Global mesh is always occlusion/collision-only in live-overlay mode;
      // in captured-shell mode it can serve as the visible fallback shell
      // where no semantic plane exists yet.
      material.colorWrite = mode === 'captured-shell';
    }
    for (const [id, entry] of this.globalMeshEntries) {
      if (!seen.has(id)) {
        this.occluderGroup.remove(entry.mesh);
        this.globalMeshEntries.delete(id);
      }
    }
  }

  dispose(): void {
    this.occluderGroup.clear();
    this.visibleGroup.clear();
    this.surfaceEntries.clear();
    this.globalMeshEntries.clear();
  }
}
