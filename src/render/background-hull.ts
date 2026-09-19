/**
 * Background hull: hides a physical object that has been deleted or moved by
 * rendering its occlusion proxy, at its ORIGINAL pose, textured with the
 * nearest clean-plate viewpoint's captured frame (projective texture - see
 * render/projective.ts). A flat plate (render/plates.ts) only reads right
 * from directly above; seen from the side, a deleted table would otherwise
 * still show through passthrough as a 3D volume with nothing behind it. This
 * renders a solid stand-in that "looks like" the real background from
 * wherever the head currently is, within the object's verified capture
 * envelope - outside it we render nothing, same rule plates.ts uses.
 */
import * as THREE from 'three';
import type { EditableObject, Pose, SceneSnapshot, Vec3 } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import type { FrameStore } from '@/capture/frame-store';
import { distance } from '@/core/math';
import { insideEnvelope } from './plates';
import { createProjectiveMaterial, setMaterialFrame } from './projective';

const RESELECT_DISTANCE_M = 0.1;

function geometryForProxy(obj: EditableObject): THREE.BufferGeometry {
  const shape = obj.occlusionProxy;
  switch (shape.kind) {
    case 'box':
      return new THREE.BoxGeometry(shape.halfExtents.x * 2, shape.halfExtents.y * 2, shape.halfExtents.z * 2);
    case 'sphere':
      return new THREE.SphereGeometry(shape.radius, 16, 12);
    case 'capsule':
      return new THREE.CapsuleGeometry(shape.radius, shape.halfHeight * 2, 4, 8);
  }
}

function shouldHide(obj: EditableObject): boolean {
  if (obj.origin !== 'physical') return false;
  if (!obj.visible) return true;
  const a = obj.originalPose.position;
  const b = obj.currentPose.position;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0.005;
}

interface HullEntry {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  lastHeadPos: Vec3 | null;
  selectedFrame: CameraFrame | null;
}

export class BackgroundHull {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, HullEntry>();
  private lastVersion = -1;
  /** Objects currently hidden/moved as of `lastVersion` - rebuilt only on a version change. */
  private activeObjects: EditableObject[] = [];

  constructor(private readonly frameStore: FrameStore) {}

  /** Call once per rendered frame. */
  update(snapshot: SceneSnapshot, headPose: Pose): void {
    if (snapshot.version !== this.lastVersion) {
      this.lastVersion = snapshot.version;
      this.rebuildActiveObjects(snapshot);
    }
    for (const obj of this.activeObjects) {
      this.syncEntry(obj, headPose);
    }
  }

  private rebuildActiveObjects(snapshot: SceneSnapshot): void {
    const seen = new Set<string>();
    this.activeObjects = [];
    for (const obj of Object.values(snapshot.objects)) {
      if (!shouldHide(obj)) continue;
      seen.add(obj.id);
      this.activeObjects.push(obj);
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        this.group.remove(entry.mesh);
        this.entries.delete(id);
      }
    }
  }

  private envelopeVisible(obj: EditableObject, headPose: Pose): boolean {
    for (const plate of obj.background) {
      if (insideEnvelope(headPose, plate)) return true;
    }
    return false;
  }

  private syncEntry(obj: EditableObject, headPose: Pose): void {
    let entry = this.entries.get(obj.id);
    if (!entry) {
      const geometry = geometryForProxy(obj);
      const material = createProjectiveMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `background-hull:${obj.id}`;
      // Draw after the (invisible) static-shell occluders (renderOrder 0) and
      // before spawned/editable objects (renderOrder 2) - see render/shell.ts
      // and render/objects.ts for the rest of the ordering.
      mesh.renderOrder = 1;
      mesh.position.set(obj.originalPose.position.x, obj.originalPose.position.y, obj.originalPose.position.z);
      mesh.quaternion.set(
        obj.originalPose.rotation.x,
        obj.originalPose.rotation.y,
        obj.originalPose.rotation.z,
        obj.originalPose.rotation.w,
      );
      entry = { mesh, material, lastHeadPos: null, selectedFrame: null };
      this.entries.set(obj.id, entry);
      this.group.add(mesh);
    }

    const visible = this.envelopeVisible(obj, headPose);
    const frames = this.frameStore.get(obj.id);

    if (!visible || !frames || frames.length === 0) {
      entry.mesh.visible = false;
      return;
    }

    const moved = !entry.lastHeadPos || distance(entry.lastHeadPos, headPose.position) > RESELECT_DISTANCE_M;
    if (moved || !entry.selectedFrame) {
      entry.lastHeadPos = headPose.position;
      entry.selectedFrame = nearestFrame(frames, headPose.position);
    }

    if (!entry.selectedFrame) {
      entry.mesh.visible = false;
      return;
    }

    setMaterialFrame(entry.material, entry.selectedFrame);
    entry.mesh.visible = true;
  }

  dispose(): void {
    this.group.clear();
    this.entries.clear();
  }
}

function nearestFrame(frames: CameraFrame[], point: Vec3): CameraFrame | null {
  let best: CameraFrame | null = null;
  let bestDist = Infinity;
  for (const frame of frames) {
    const d = distance(frame.pose.position, point);
    if (d < bestDist) {
      bestDist = d;
      best = frame;
    }
  }
  return best;
}
