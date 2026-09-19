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
import type { Region, SceneSnapshot, Surface } from '@/core/types';
import type { RawGlobalMesh } from '@/xr/scene-understanding';

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

interface SurfaceEntry {
  mesh: THREE.Mesh;
  lastChanged: number;
}

export class ShellRenderer {
  /** Occluder-only meshes: colorWrite off, depthWrite on. Render FIRST. */
  readonly occluderGroup = new THREE.Group();
  /** Visible captured-shell meshes. Also rendered as part of the first pass. */
  readonly visibleGroup = new THREE.Group();

  private readonly surfaceEntries = new Map<string, SurfaceEntry>();
  private readonly globalMeshEntries = new Map<string, THREE.Mesh>();
  private lastVersion = -1;

  update(snapshot: SceneSnapshot, globalMeshes: RawGlobalMesh[]): void {
    // Regions live inside the snapshot (see core/types SceneSnapshot.regions), so
    // any region-state transition already bumps `version` like every other
    // committed intent; when the version is unchanged there is nothing new to
    // place, so skip re-deriving visibility (previously this ran every frame,
    // allocating `Object.values(snapshot.regions)` per surface for no reason).
    if (snapshot.version !== this.lastVersion) {
      this.lastVersion = snapshot.version;
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
      const material = new THREE.MeshStandardMaterial({ color: 0x778899 });
      const mesh = new THREE.Mesh(geometry, material);
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
      entry = { mesh, lastChanged: surface.lastChanged };
      this.surfaceEntries.set(surface.id, entry);
    }
    this.placeSurface(surface, entry, snapshot);
  }

  private placeSurface(surface: Surface, entry: SurfaceEntry, snapshot: SceneSnapshot): void {
    const region = regionForSurface(snapshot, surface.id);
    const visible = isVisibleShellState(region);
    const material = entry.mesh.material as THREE.MeshStandardMaterial;

    this.occluderGroup.remove(entry.mesh);
    this.visibleGroup.remove(entry.mesh);

    if (visible) {
      material.colorWrite = true;
      material.depthWrite = true;
      this.visibleGroup.add(entry.mesh);
    } else {
      // Invisible occluder/collider: still write depth so it participates in
      // z-testing against spawned objects, but never contributes color.
      material.colorWrite = false;
      material.depthWrite = true;
      this.occluderGroup.add(entry.mesh);
    }
  }

  private syncGlobalMeshes(globalMeshes: RawGlobalMesh[], mode: SceneSnapshot['mode']): void {
    const seen = new Set<string>();
    for (const gm of globalMeshes) {
      seen.add(gm.id);
      let mesh = this.globalMeshEntries.get(gm.id);
      if (!mesh) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(gm.vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(gm.indices, 1));
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: 0x556677 });
        mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 0;
        this.globalMeshEntries.set(gm.id, mesh);
        this.occluderGroup.add(mesh);
      }
      mesh.position.set(gm.pose.position.x, gm.pose.position.y, gm.pose.position.z);
      mesh.quaternion.set(gm.pose.rotation.x, gm.pose.rotation.y, gm.pose.rotation.z, gm.pose.rotation.w);
      const material = mesh.material as THREE.MeshStandardMaterial;
      // Global mesh is always occlusion/collision-only in live-overlay mode;
      // in captured-shell mode it can serve as the visible fallback shell
      // where no semantic plane exists yet.
      material.colorWrite = mode === 'captured-shell';
    }
    for (const [id, mesh] of this.globalMeshEntries) {
      if (!seen.has(id)) {
        this.occluderGroup.remove(mesh);
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
