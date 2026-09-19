/**
 * Object3D views for EditableObjects, diffed against snapshot versions.
 *
 * Physical-origin objects follow the "live-overlay by default" rule: while
 * they sit at their originalPose and are visible, the real object is seen
 * through passthrough and we render NOTHING for them except an optional
 * hover wireframe. Only once they have been moved (currentPose != original)
 * or deleted do we render a solid substitute (and plates.ts paints the
 * exposed background at their original location).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { EditableObject, ProxyShape, SceneSnapshot } from '@/core/types';

const EPS_POS = 0.005;
const EPS_ROT = 0.001;

function posesEqual(a: EditableObject['originalPose'], b: EditableObject['currentPose']): boolean {
  const dp = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
  const dr =
    Math.abs(a.rotation.x - b.rotation.x) +
    Math.abs(a.rotation.y - b.rotation.y) +
    Math.abs(a.rotation.z - b.rotation.z) +
    Math.abs(a.rotation.w - b.rotation.w);
  return dp < EPS_POS && dr < EPS_ROT;
}

function geometryForProxy(shape: ProxyShape): THREE.BufferGeometry {
  switch (shape.kind) {
    case 'box':
      return new THREE.BoxGeometry(shape.halfExtents.x * 2, shape.halfExtents.y * 2, shape.halfExtents.z * 2);
    case 'sphere':
      return new THREE.SphereGeometry(shape.radius, 16, 12);
    case 'capsule':
      return new THREE.CapsuleGeometry(shape.radius, shape.halfHeight * 2, 4, 8);
  }
}

interface Entry {
  root: THREE.Group;
  solid: THREE.Mesh | THREE.Group;
  hoverOutline: THREE.LineSegments;
  version: string; // cheap dirty-check signature
  gltfUrl?: string;
}

const gltfLoader = new GLTFLoader();
const gltfCache = new Map<string, THREE.Object3D>();

function loadGltf(url: string, onReady: (scene: THREE.Object3D) => void): void {
  const cached = gltfCache.get(url);
  if (cached) {
    onReady(cached.clone(true));
    return;
  }
  gltfLoader.load(
    url,
    (gltf) => {
      gltfCache.set(url, gltf.scene);
      onReady(gltf.scene.clone(true));
    },
    undefined,
    () => {
      // Load failure: keep the placeholder proxy visual, never throw in the loop.
    },
  );
}

export class ObjectViews {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, Entry>();
  private lastVersion = -1;
  hoveredId: string | null = null;
  grabbedId: string | null = null;
  selectedId: string | null = null;

  /** Call once per rendered frame with the current snapshot. */
  update(snapshot: SceneSnapshot): void {
    if (snapshot.version === this.lastVersion) {
      this.updateHighlights();
      return;
    }
    this.lastVersion = snapshot.version;

    const seen = new Set<string>();
    for (const obj of Object.values(snapshot.objects)) {
      seen.add(obj.id);
      this.syncObject(obj);
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        this.group.remove(entry.root);
        this.entries.delete(id);
      }
    }
    this.updateHighlights();
  }

  private syncObject(obj: EditableObject): void {
    let entry = this.entries.get(obj.id);
    const moved = !posesEqual(obj.originalPose, obj.currentPose);
    const showSolid = obj.origin !== 'physical' || moved || !obj.visible;

    if (!entry) {
      entry = this.buildEntry(obj);
      this.entries.set(obj.id, entry);
      this.group.add(entry.root);
    }

    entry.root.visible = obj.visible || showSolid; // deleted-but-restorable stays hidden via solid.visible below
    entry.root.position.set(obj.currentPose.position.x, obj.currentPose.position.y, obj.currentPose.position.z);
    entry.root.quaternion.set(
      obj.currentPose.rotation.x,
      obj.currentPose.rotation.y,
      obj.currentPose.rotation.z,
      obj.currentPose.rotation.w,
    );

    entry.solid.visible = obj.visible && showSolid;
    entry.hoverOutline.visible = obj.visible && !showSolid && this.hoveredId === obj.id;

    if (obj.visual.kind === 'gltf' && obj.visual.url && entry.gltfUrl !== obj.visual.url) {
      entry.gltfUrl = obj.visual.url;
      loadGltf(obj.visual.url, (scene) => {
        // Replace placeholder children with the loaded asset.
        const solidGroup = entry!.solid as THREE.Group;
        solidGroup.clear();
        solidGroup.add(scene);
      });
    }
  }

  private buildEntry(obj: EditableObject): Entry {
    const root = new THREE.Group();
    root.name = `object:${obj.id}`;
    // Editable/spawned objects draw last (after the static shell at 0 and the
    // XR depth occlusion mesh at 1, see xr/depth.ts) so hands/people in front
    // of them - captured by the depth mesh - correctly occlude them.
    root.renderOrder = 2;

    const geometry = geometryForProxy(obj.interactionProxy);
    const color = obj.visual.color ?? 0x8899aa;
    const material = new THREE.MeshStandardMaterial({ color });

    let solid: THREE.Mesh | THREE.Group;
    if (obj.visual.kind === 'gltf') {
      solid = new THREE.Group();
      // Placeholder box until the async load resolves.
      solid.add(new THREE.Mesh(geometry, material));
    } else {
      solid = new THREE.Mesh(geometry, material);
    }
    root.add(solid);

    const outlineGeo = new THREE.EdgesGeometry(geometry);
    const hoverOutline = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
    hoverOutline.visible = false;
    root.add(hoverOutline);

    return { root, solid, hoverOutline, version: '' };
  }

  private updateHighlights(): void {
    for (const [id, entry] of this.entries) {
      const isSelected = id === this.selectedId;
      const isGrabbed = id === this.grabbedId;
      const isHovered = id === this.hoveredId;
      entry.hoverOutline.visible = entry.hoverOutline.visible || (isHovered && entry.solid.visible === false);
      const mats: THREE.MeshStandardMaterial[] = [];
      entry.solid.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
          mats.push(child.material);
        }
      });
      for (const mat of mats) {
        mat.emissive.setHex(isGrabbed ? 0x333333 : isSelected ? 0x222222 : 0x000000);
      }
    }
  }

  /** Ghost preview: semi-transparent copy at preview.pose. */
  updatePreview(snapshot: SceneSnapshot, previewGroup: THREE.Group): void {
    previewGroup.clear();
    const preview = snapshot.preview;
    if (!preview) return;
    const obj = snapshot.objects[preview.objectId];
    if (!obj) return;
    const geometry = geometryForProxy(obj.interactionProxy);
    const material = new THREE.MeshStandardMaterial({
      color: obj.visual.color ?? 0x8899aa,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(preview.pose.position.x, preview.pose.position.y, preview.pose.position.z);
    mesh.quaternion.set(
      preview.pose.rotation.x,
      preview.pose.rotation.y,
      preview.pose.rotation.z,
      preview.pose.rotation.w,
    );
    previewGroup.add(mesh);
  }

  dispose(): void {
    this.group.clear();
    this.entries.clear();
  }
}
