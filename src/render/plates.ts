/**
 * Background plate rendering: what fills the "hole" left when a
 * physical-origin object has moved from its originalPose. Only meaningful
 * while the viewer's head is inside the plate's verified ViewpointEnvelope -
 * outside it we render nothing, matching the resolver's own envelope gate
 * (the resolver already blocked edits outside the envelope; this is a
 * defence against head-pose drift making the view stray outside it anyway).
 */
import * as THREE from 'three';
import type { BackgroundPlate, EditableObject, Pose, SceneSnapshot } from '@/core/types';
import type { PlateTextureRegistry } from '@/capture/contract';

function insideEnvelope(headPose: Pose, plate: BackgroundPlate): boolean {
  const env = plate.envelope;
  const dx = headPose.position.x - env.center.x;
  const dy = headPose.position.y - env.center.y;
  const dz = headPose.position.z - env.center.z;
  const dist = Math.hypot(dx, dy, dz);
  return dist <= env.radius; // angular check omitted: heading is not tracked on Pose alone
}

function provenanceTint(provenance: BackgroundPlate['provenance']): { color: number; dashed: boolean } {
  switch (provenance) {
    case 'observed_clean_plate':
    case 'multi_view_observed':
      return { color: 0xffffff, dashed: false }; // no tint: trusted evidence
    case 'constrained_surface':
      return { color: 0xdddddd, dashed: false }; // faint tint
    case 'synthetic_completion':
      return { color: 0xcccccc, dashed: true }; // dashed outline: least trusted
    case 'unavailable':
    default:
      return { color: 0x999999, dashed: true };
  }
}

interface PlateEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
  textureRef?: string;
}

export class PlateRenderer {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, PlateEntry>();

  constructor(private readonly textures: PlateTextureRegistry) {}

  /** Call once per rendered frame. */
  update(snapshot: SceneSnapshot, headPose: Pose): void {
    const seen = new Set<string>();
    for (const obj of Object.values(snapshot.objects)) {
      const moved = this.hasMoved(obj);
      if (!moved) continue;
      for (const plate of obj.background) {
        seen.add(plate.id);
        this.syncPlate(plate, headPose);
      }
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        this.group.remove(entry.mesh, entry.outline);
        this.entries.delete(id);
      }
    }
  }

  private hasMoved(obj: EditableObject): boolean {
    if (!obj.visible) return true;
    const a = obj.originalPose.position;
    const b = obj.currentPose.position;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0.005;
  }

  private syncPlate(plate: BackgroundPlate, headPose: Pose): void {
    let entry = this.entries.get(plate.id);
    const visible = insideEnvelope(headPose, plate);

    if (!entry) {
      const width = Math.max(plate.region.max.x - plate.region.min.x, 0.01);
      const depth = Math.max(plate.region.max.z - plate.region.min.z, 0.01);
      const geometry = new THREE.PlaneGeometry(width, depth);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineDashedMaterial({ color: 0x888888, dashSize: 0.02, gapSize: 0.02 }),
      );
      outline.computeLineDistances();
      entry = { mesh, outline };
      this.entries.set(plate.id, entry);
      this.group.add(mesh, outline);
    }

    const cx = (plate.region.min.x + plate.region.max.x) / 2;
    const cz = (plate.region.min.z + plate.region.max.z) / 2;
    const y = plate.region.min.y;
    entry.mesh.position.set(cx, y, cz);
    entry.outline.position.set(cx, y, cz);

    entry.mesh.visible = visible;
    entry.outline.visible = false;

    const tint = provenanceTint(plate.provenance);
    entry.outline.visible = visible && tint.dashed;

    const material = entry.mesh.material as THREE.MeshStandardMaterial;
    if (plate.textureRef && entry.textureRef !== plate.textureRef) {
      const frame = this.textures.get(plate.textureRef);
      if (frame) {
        const tex = new THREE.DataTexture(frame.rgba, frame.width, frame.height, THREE.RGBAFormat);
        tex.needsUpdate = true;
        tex.colorSpace = THREE.SRGBColorSpace;
        material.map = tex;
        material.color.set(0xffffff);
      }
      entry.textureRef = plate.textureRef;
    } else if (!plate.textureRef) {
      material.map = null;
      material.color.setHex(tint.color);
    }
    material.needsUpdate = true;
  }

  dispose(): void {
    this.group.clear();
    this.entries.clear();
  }
}
