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

export function insideEnvelope(headPose: Pose, plate: BackgroundPlate): boolean {
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
  private lastVersion = -1;
  /** Plates that belong to a moved object as of `lastVersion` - rebuilt only on a
   * version change so the per-frame path (envelope visibility only, driven by
   * head pose) never re-scans `snapshot.objects` or allocates a Set. */
  private activePlates: BackgroundPlate[] = [];

  constructor(private readonly textures: PlateTextureRegistry) {}

  /** Call once per rendered frame. */
  update(snapshot: SceneSnapshot, headPose: Pose): void {
    if (snapshot.version !== this.lastVersion) {
      this.lastVersion = snapshot.version;
      this.rebuildActivePlates(snapshot);
    }
    for (const plate of this.activePlates) {
      this.syncPlate(plate, headPose);
    }
  }

  private rebuildActivePlates(snapshot: SceneSnapshot): void {
    const seen = new Set<string>();
    this.activePlates = [];
    for (const obj of Object.values(snapshot.objects)) {
      if (!this.hasMoved(obj)) continue;
      for (const plate of obj.background) {
        seen.add(plate.id);
        this.activePlates.push(plate);
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
      // Lies flat in the region's XZ footprint (PlaneGeometry starts in the XY
      // plane facing +Z; rotating -90 degrees about X lays it down facing +Y,
      // i.e. a horizontal quad you look down onto - same convention used for
      // shell tiles in src/render/shell.ts).
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
    // A hair above the region's top face so the plate never z-fights with the
    // support surface it's resting on.
    const y = plate.region.max.y + 0.002;
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
        // capture/plates.ts bakes texel row 0 at region.min.z (row index increases
        // with world Z). The plate quad's V=0 edge sits at region.max.z (see the
        // -90deg X rotation above: local plane V=0 -> world +Z after rotation), so
        // flipping the texture on upload (row 0 -> V=1) lines the two up; without
        // this the baked photo is mirrored across Z on the quad.
        tex.flipY = true;
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
