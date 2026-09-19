/**
 * Emulates "the user lifted this object out of the way" inside the synthetic
 * environment so a clean-plate capture can observe the support surface beneath it.
 *
 * Hiding the labelled box/plane entity alone is not enough: the room's global scan
 * mesh still contains the object's triangles, so depth and colour would keep showing it.
 * A lift therefore does three things and a return undoes them:
 *   1. hide the entity and any co-located entity with the same label (SEM captures carry
 *      both a plane and a box for most furniture);
 *   2. carve the global mesh: drop triangles whose centroid falls inside the object's
 *      world bounding box, above its bottom face (keeping any floor/table geometry below);
 *   3. add a support patch: the surface that physically exists under the object but was
 *      never scanned because the object sat on it. It is a flat quad at the object's
 *      bottom face, coloured like the scan mesh.
 */
import * as THREE from 'three';

interface SemLike {
  objectMap: Map<string, THREE.Mesh & { nativeEntity?: { semanticLabel?: string } }>;
}

interface LiftRecord {
  hidden: THREE.Mesh[];
  carved: { mesh: THREE.Mesh; originalIndex: THREE.BufferAttribute | null }[];
  patch: THREE.Mesh | null;
}

const PATCH_COLOR = 0xd4d4d4;
const COLOCATION_M = 0.05;
const BOTTOM_MARGIN_M = 0.03;
const CARVE_PAD_M = 0.06;
const STACK_TOLERANCE_M = 0.12;

export class LiftController {
  private readonly records = new Map<string, LiftRecord>();

  constructor(private readonly sem: unknown) {}

  private get map(): SemLike['objectMap'] {
    return (this.sem as SemLike).objectMap;
  }

  isLifted(id: string): boolean {
    return this.records.has(id);
  }

  lift(id: string): boolean {
    if (this.records.has(id)) return true;
    const entity = this.map.get(id);
    if (!entity) return false;

    entity.updateMatrixWorld(true);
    const label = entity.nativeEntity?.semanticLabel;
    const worldBox = worldBoxOf(entity);
    // Scan meshes are noisy: the object's top and sides poke slightly outside the
    // labelled box, so carve a padded box (never padded downward, to keep the floor).
    const carveBox = worldBox.clone();
    carveBox.min.x -= CARVE_PAD_M;
    carveBox.min.z -= CARVE_PAD_M;
    carveBox.max.x += CARVE_PAD_M;
    carveBox.max.z += CARVE_PAD_M;
    carveBox.max.y += CARVE_PAD_M;

    const hidden: THREE.Mesh[] = [];
    const carveBoxes: THREE.Box3[] = [carveBox];
    for (const [otherId, other] of this.map) {
      if (otherId === id) {
        hidden.push(other);
        continue;
      }
      if (other.nativeEntity?.semanticLabel === 'global mesh') continue;
      const sameLabel = other.nativeEntity?.semanticLabel === label;
      if (sameLabel && other.position.distanceTo(entity.position) <= COLOCATION_M) {
        hidden.push(other);
        continue;
      }
      // Anything resting on top of the lifted object (a lamp on a table) leaves with it:
      // the guided capture asks the user to clear the cluster, not just the base object.
      other.updateMatrixWorld(true);
      const otherBox = worldBoxOf(other);
      if (isStackedOn(otherBox, worldBox)) {
        hidden.push(other);
        const padded = otherBox.clone();
        padded.expandByScalar(CARVE_PAD_M);
        padded.min.y = Math.max(padded.min.y, worldBox.max.y - CARVE_PAD_M);
        carveBoxes.push(padded);
      }
    }
    for (const h of hidden) h.visible = false;

    const carved: LiftRecord['carved'] = [];
    for (const other of this.map.values()) {
      if (other.nativeEntity?.semanticLabel !== 'global mesh') continue;
      const original = other.geometry.getIndex();
      let current: THREE.BufferAttribute | null = null;
      for (const box of carveBoxes) {
        const filtered = carveIndex(other, box);
        if (filtered) {
          other.geometry.setIndex(filtered);
          current = filtered;
        }
      }
      if (!current) continue;
      carved.push({ mesh: other, originalIndex: original });
    }

    let patch: THREE.Mesh | null = null;
    // Put the patch beside the scan mesh so it renders in both the colour and depth passes.
    const parent = carved[0]?.mesh.parent ?? entity.parent ?? null;
    if (parent) {
      const w = worldBox.max.x - worldBox.min.x;
      const d = worldBox.max.z - worldBox.min.z;
      const geometry = new THREE.PlaneGeometry(w, d);
      geometry.rotateX(-Math.PI / 2);
      patch = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: PATCH_COLOR, side: THREE.DoubleSide }));
      patch.position.set((worldBox.min.x + worldBox.max.x) / 2, worldBox.min.y + 0.002, (worldBox.min.z + worldBox.max.z) / 2);
      patch.name = `lift-patch:${id}`;
      // The parent group may carry its own transform; place the patch in world space.
      parent.worldToLocal(patch.position);
      parent.add(patch);
      patch.updateMatrixWorld(true);
    }

    this.records.set(id, { hidden, carved, patch });
    return true;
  }

  restore(id: string): boolean {
    const record = this.records.get(id);
    if (!record) {
      const entity = this.map.get(id);
      if (entity) entity.visible = true;
      return !!entity;
    }
    for (const h of record.hidden) h.visible = true;
    for (const { mesh, originalIndex } of record.carved) mesh.geometry.setIndex(originalIndex);
    if (record.patch) {
      record.patch.parent?.remove(record.patch);
      record.patch.geometry.dispose();
      (record.patch.material as THREE.Material).dispose();
    }
    this.records.delete(id);
    return true;
  }
}

/** True when `box` rests on the top face of `base` with overlapping footprint. */
function isStackedOn(box: THREE.Box3, base: THREE.Box3): boolean {
  const gap = box.min.y - base.max.y;
  if (gap < -STACK_TOLERANCE_M || gap > STACK_TOLERANCE_M) return false;
  const overlapX = Math.min(box.max.x, base.max.x) - Math.max(box.min.x, base.min.x);
  const overlapZ = Math.min(box.max.z, base.max.z) - Math.max(box.min.z, base.min.z);
  return overlapX > 0 && overlapZ > 0;
}

function worldBoxOf(entity: THREE.Mesh): THREE.Box3 {
  entity.geometry.computeBoundingBox();
  const box = (entity.geometry.boundingBox ?? new THREE.Box3()).clone();
  return box.applyMatrix4(entity.matrixWorld);
}

/** Returns a new index without the triangles inside `worldBox` (above its bottom margin), or null if nothing changed. */
function carveIndex(mesh: THREE.Mesh, worldBox: THREE.Box3): THREE.BufferAttribute | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return null;
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : position.count / 3;
  const keep: number[] = [];
  const v = new THREE.Vector3();
  const c = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  const bottom = worldBox.min.y + BOTTOM_MARGIN_M;
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
    const inside = worldBox.containsPoint(c) && c.y > bottom;
    if (inside) {
      removed++;
      continue;
    }
    keep.push(a, b, d);
  }
  if (removed === 0) return null;
  return new THREE.BufferAttribute(new Uint32Array(keep), 1);
}
