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
import type { Aabb, EditableObject, ProxyShape, SceneSnapshot } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import type { FrameStore } from '@/capture/frame-store';
import { appearanceFrameKey } from '@/capture/frame-store';
import { createUnlitTextureMaterial, setUnlitMaterialFrame, setUnlitClipBox, setUnlitEyePosition, createDepthResetMaterial } from './projective';
import { getDepthMeshGeometry } from './depth-mesh';

const EPS_POS = 0.005;
const EPS_ROT = 0.001;

/** Padding added around an object's original occlusion box for the appearance box filter (see BOX_EXPAND_M usage below). */
const APPEARANCE_BOX_EXPAND_M = 0.03;
const RENDER_ORDER_APPEARANCE_STENCIL = 0.5;
const RENDER_ORDER_APPEARANCE_DEPTH = 1;

/** Allocates small stable integers (1..255) for stencil refs, reused once freed. Offset from
 * render/background-hull.ts's own pool (which starts at 1) so the two features - a moved
 * object's own appearance stencil here, and the hole-it-left-behind stencil there - never
 * reuse the same GPU stencil value for two different objects in the same rendered frame. */
class StencilRefPool {
  private next: number;
  private free: number[] = [];
  private assigned = new Map<string, number>();

  constructor(start: number) {
    this.next = start;
  }

  acquire(id: string): number {
    const existing = this.assigned.get(id);
    if (existing !== undefined) return existing;
    const ref = this.free.pop() ?? this.next++;
    this.assigned.set(id, ref);
    return ref;
  }

  release(id: string): void {
    const ref = this.assigned.get(id);
    if (ref === undefined) return;
    this.assigned.delete(id);
    this.free.push(ref);
  }
}

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
  /** Cached flat material list for `solid`, rebuilt only when `solid`'s contents change
   * (construction, or async gltf swap) - avoids an `Object3D.traverse()` + closure
   * allocation on every frame in `updateHighlights()`. */
  materials: THREE.MeshStandardMaterial[];
  /**
   * "Move the table and see the table": when `obj.visual.kind === 'baked'`
   * and the object is displaced from `originalPose`, this group (a CHILD of
   * `root`, so it inherits root's current-pose transform for free - root is
   * positioned/oriented at `obj.currentPose` every frame, see `syncObject`)
   * holds the object's own captured depth meshes, expressed in
   * `originalPose`-relative local space. Parenting them under `root` is
   * exactly the transform the spec calls for: local = originalPose^-1 *
   * worldVertex, then root (currentPose) * local = (currentPose *
   * originalPose^-1) * worldVertex, i.e. the appearance is drawn at the
   * delta between where the object used to be and where it is now.
   */
  appearanceGroup: THREE.Group;
  appearanceStencilMesh: THREE.Mesh;
  appearanceStencilMaterial: THREE.ShaderMaterial;
  appearanceStencilRef: number;
  /** Built lazily once frames are available; `undefined` until first attempted. */
  appearanceDepthMeshes: Map<CameraFrame, THREE.Mesh | null> | undefined;
  appearanceHasMesh: boolean;
}

function collectStandardMaterials(root: THREE.Object3D, out: THREE.MeshStandardMaterial[]): void {
  out.length = 0;
  root.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
      out.push(child.material);
    }
  });
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

/**
 * Local-space bounding box of a just-loaded (not-yet-parented) gltf scene
 * root. Called before the scene is added under an object's root group, so
 * `updateMatrixWorld` composes only the scene's own transform - i.e. this is
 * the model's bounds in the object's local frame, exactly what
 * `src/app/catalog-fit.ts`'s `fitProxiesToBounds` expects.
 */
function localBoundsOf(scene: THREE.Object3D): Aabb {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
}

interface PreviewEntry {
  objectId: string;
  mesh: THREE.Mesh;
}

export class ObjectViews {
  /** Head position for the appearance silhouette clip; set by the app each frame. */
  eyePosition: { x: number; y: number; z: number } | null = null;
  private readonly clipMin = new THREE.Vector3();
  private readonly clipMax = new THREE.Vector3();
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, Entry>();
  private readonly appearanceStencilRefs = new StencilRefPool(101);
  private lastVersion = -1;
  private previewEntry: PreviewEntry | null = null;
  hoveredId: string | null = null;
  grabbedId: string | null = null;
  selectedId: string | null = null;

  /**
   * `frameStore` supplies each object's "appearance pass" frames (see
   * `capture/frame-store.ts`'s `appearanceFrameKey`) for rendering a moved
   * physical object with its own captured look instead of a primitive box.
   * Optional so existing callers/tests that only build proxy geometry still
   * work unchanged.
   */
  constructor(private readonly frameStore?: FrameStore) {}
  /**
   * Optional hook fired once a gltf-visual object's model finishes loading,
   * with the model's local-space bounding box (see `localBoundsOf`). The app
   * (src/app/main.ts) can wire this to dispatch a `setProxies` intent via
   * `fitProxiesToBounds` so the object's interaction/collision/occlusion
   * proxies match what was actually drawn, e.g.:
   *
   *   views.onModelLoaded = (objectId, bounds) => {
   *     const obj = store.current.objects[objectId];
   *     if (!obj) return;
   *     const fitted = fitProxiesToBounds(obj, bounds);
   *     store.dispatch({
   *       intent: { kind: 'setProxies', objectId, interaction: fitted.interactionProxy, collision: fitted.collisionProxy, occlusion: fitted.occlusionProxy },
   *       source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version,
   *     }, conditions());
   *   };
   */
  onModelLoaded?: (objectId: string, bounds: Aabb) => void;

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
        this.appearanceStencilRefs.release(id);
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

    // "Move the table and see the table": a displaced physical object whose
    // appearance was captured renders its own depth meshes instead of the
    // primitive-box stand-in, provided at least one usable mesh was built
    // (see syncAppearance) - otherwise fall back to the box as before.
    const wantsAppearance = obj.visible && moved && obj.visual.kind === 'baked' && !!this.frameStore;
    const appearanceActive = wantsAppearance ? this.syncAppearance(entry, obj) : false;
    if (!wantsAppearance) entry.appearanceGroup.visible = false;
    else this.updateAppearanceClip(entry, obj);

    entry.solid.visible = obj.visible && showSolid && !appearanceActive;
    entry.hoverOutline.visible = obj.visible && !showSolid && this.hoveredId === obj.id;

    if (obj.visual.kind === 'gltf' && obj.visual.url && entry.gltfUrl !== obj.visual.url) {
      entry.gltfUrl = obj.visual.url;
      loadGltf(obj.visual.url, (scene) => {
        const bounds = localBoundsOf(scene);
        // Replace placeholder children with the loaded asset.
        const solidGroup = entry!.solid as THREE.Group;
        solidGroup.clear();
        solidGroup.add(scene);
        collectStandardMaterials(entry!.solid, entry!.materials);
        this.onModelLoaded?.(obj.id, bounds);
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

    const materials: THREE.MeshStandardMaterial[] = [];
    collectStandardMaterials(solid, materials);

    // Appearance stencil: stamps the object's occlusion-proxy silhouette at
    // the CURRENT pose (this mesh sits at root's local origin, and root is
    // positioned/oriented at currentPose every frame) so the depth meshes
    // below only ever paint inside that silhouette, never spilling onto
    // whatever real geometry happens to be nearby at the new location.
    const appearanceStencilRef = this.appearanceStencilRefs.acquire(obj.id);
    // Depth reset inside the silhouette at the CURRENT pose (see projective.ts).
    const appearanceStencilMaterial = createDepthResetMaterial();
    appearanceStencilMaterial.stencilWrite = true;
    appearanceStencilMaterial.stencilFunc = THREE.AlwaysStencilFunc;
    appearanceStencilMaterial.stencilRef = appearanceStencilRef;
    appearanceStencilMaterial.stencilZPass = THREE.ReplaceStencilOp;
    const appearanceStencilMesh = new THREE.Mesh(geometryForProxy(obj.occlusionProxy), appearanceStencilMaterial);
    appearanceStencilMesh.name = `object-appearance-stencil:${obj.id}`;
    appearanceStencilMesh.renderOrder = RENDER_ORDER_APPEARANCE_STENCIL;
    appearanceStencilMesh.visible = false;

    const appearanceGroup = new THREE.Group();
    appearanceGroup.name = `object-appearance:${obj.id}`;
    appearanceGroup.visible = false;
    appearanceGroup.add(appearanceStencilMesh);
    root.add(appearanceGroup);

    return {
      root,
      solid,
      hoverOutline,
      version: '',
      materials,
      appearanceGroup,
      appearanceStencilMesh,
      appearanceStencilMaterial,
      appearanceStencilRef,
      appearanceDepthMeshes: undefined,
      appearanceHasMesh: false,
    };
  }

  /**
   * Lazily builds (once per object; frames never change while a capture is
   * held) the object's appearance depth meshes from its `obj-appearance:<id>`
   * frames, box-filtered to its own original occlusion volume (expanded 3cm)
   * so floor/wall geometry the same frames also saw is excluded. Returns
   * whether at least one usable mesh exists (caller falls back to the
   * primitive box otherwise).
   */
  private syncAppearance(entry: Entry, obj: EditableObject): boolean {
    if (entry.appearanceDepthMeshes === undefined) {
      entry.appearanceDepthMeshes = new Map();
      const frames = this.frameStore?.get(appearanceFrameKey(obj.id)) ?? [];
      const proxy = obj.occlusionProxy;
      const keepInsideBox =
        proxy.kind === 'box'
          ? {
              min: {
                x: obj.originalPose.position.x - proxy.halfExtents.x - APPEARANCE_BOX_EXPAND_M,
                y: obj.originalPose.position.y - proxy.halfExtents.y - APPEARANCE_BOX_EXPAND_M,
                z: obj.originalPose.position.z - proxy.halfExtents.z - APPEARANCE_BOX_EXPAND_M,
              },
              max: {
                x: obj.originalPose.position.x + proxy.halfExtents.x + APPEARANCE_BOX_EXPAND_M,
                y: obj.originalPose.position.y + proxy.halfExtents.y + APPEARANCE_BOX_EXPAND_M,
                z: obj.originalPose.position.z + proxy.halfExtents.z + APPEARANCE_BOX_EXPAND_M,
              },
            }
          : undefined;

      const invOriginal = new THREE.Matrix4()
        .compose(
          new THREE.Vector3(obj.originalPose.position.x, obj.originalPose.position.y, obj.originalPose.position.z),
          new THREE.Quaternion(
            obj.originalPose.rotation.x,
            obj.originalPose.rotation.y,
            obj.originalPose.rotation.z,
            obj.originalPose.rotation.w,
          ),
          new THREE.Vector3(1, 1, 1),
        )
        .invert();

      let anyMesh = false;
      for (const frame of frames) {
        const worldGeometry = getDepthMeshGeometry(frame, keepInsideBox);
        if (!worldGeometry) {
          entry.appearanceDepthMeshes.set(frame, null);
          continue;
        }
        // Re-express the (world-space) depth-mesh vertices relative to the
        // object's ORIGINAL pose, so parenting under `root` (positioned at
        // the CURRENT pose every frame) applies exactly the delta transform
        // currentPose . originalPose^-1 the spec calls for.
        const localGeometry = worldGeometry.clone().applyMatrix4(invOriginal);
        const material = createUnlitTextureMaterial();
        // Silhouette clip happens in the shader (projective.ts); the box uniform is
        // refreshed every frame from the CURRENT pose in updateAppearanceClip().
        setUnlitMaterialFrame(material, frame);
        const mesh = new THREE.Mesh(localGeometry, material);
        mesh.name = `object-appearance-depth:${obj.id}:${frame.timestamp}`;
        mesh.renderOrder = RENDER_ORDER_APPEARANCE_DEPTH;
        mesh.frustumCulled = false;
        entry.appearanceGroup.add(mesh);
        entry.appearanceDepthMeshes.set(frame, mesh);
        anyMesh = true;
      }
      entry.appearanceHasMesh = anyMesh;
    }

    entry.appearanceGroup.visible = entry.appearanceHasMesh;
    entry.appearanceStencilMesh.visible = entry.appearanceHasMesh;
    return entry.appearanceHasMesh;
  }

  private updateHighlights(): void {
    for (const [id, entry] of this.entries) {
      const isSelected = id === this.selectedId;
      const isGrabbed = id === this.grabbedId;
      const isHovered = id === this.hoveredId;
      entry.hoverOutline.visible = entry.hoverOutline.visible || (isHovered && entry.solid.visible === false);
      const hex = isGrabbed ? 0x333333 : isSelected ? 0x222222 : 0x000000;
      for (const mat of entry.materials) {
        mat.emissive.setHex(hex);
      }
    }
  }

  /**
   * Ghost preview: semi-transparent copy at preview.pose. Called every rendered
   * frame while a grab is in progress; the mesh/geometry/material are built once
   * per preview target and only its transform is touched thereafter, instead of
   * allocating (and leaking - `Group.clear()` does not dispose GPU resources) a
   * fresh mesh every frame of the drag.
   */
  updatePreview(snapshot: SceneSnapshot, previewGroup: THREE.Group): void {
    const preview = snapshot.preview;
    const obj = preview ? snapshot.objects[preview.objectId] : undefined;

    if (!preview || !obj) {
      this.clearPreview(previewGroup);
      return;
    }

    if (!this.previewEntry || this.previewEntry.objectId !== preview.objectId) {
      this.clearPreview(previewGroup);
      const geometry = geometryForProxy(obj.interactionProxy);
      const material = new THREE.MeshStandardMaterial({
        color: obj.visual.color ?? 0x8899aa,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      previewGroup.add(mesh);
      this.previewEntry = { objectId: preview.objectId, mesh };
    }

    const mesh = this.previewEntry.mesh;
    mesh.position.set(preview.pose.position.x, preview.pose.position.y, preview.pose.position.z);
    mesh.quaternion.set(
      preview.pose.rotation.x,
      preview.pose.rotation.y,
      preview.pose.rotation.z,
      preview.pose.rotation.w,
    );
    mesh.scale.setScalar(preview.scale ?? 1);
  }

  private clearPreview(previewGroup: THREE.Group): void {
    if (!this.previewEntry) return;
    previewGroup.remove(this.previewEntry.mesh);
    this.previewEntry.mesh.geometry.dispose();
    (this.previewEntry.mesh.material as THREE.Material).dispose();
    this.previewEntry = null;
  }

  /** Keep each appearance mesh clipped to the occlusion box at the object's current pose. */
  private updateAppearanceClip(entry: Entry, obj: EditableObject): void {
    const p = obj.currentPose.position;
    const proxy = obj.occlusionProxy;
    const hx = proxy.kind === 'box' ? proxy.halfExtents.x : proxy.radius;
    const hy = proxy.kind === 'box' ? proxy.halfExtents.y : proxy.kind === 'sphere' ? proxy.radius : proxy.halfHeight + proxy.radius;
    const hz = proxy.kind === 'box' ? proxy.halfExtents.z : proxy.radius;
    const pad = 0.02;
    this.clipMin.set(p.x - hx - pad, p.y - hy - pad, p.z - hz - pad);
    this.clipMax.set(p.x + hx + pad, p.y + hy + pad, p.z + hz + pad);
    for (const child of entry.appearanceGroup.children) {
      const mat = (child as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (mat && mat.uniforms && mat.uniforms.uClipMin) {
        setUnlitClipBox(mat, this.clipMin, this.clipMax);
        if (this.eyePosition) setUnlitEyePosition(mat, this.eyePosition);
      }
    }
  }

  dispose(): void {
    this.group.clear();
    this.entries.clear();
  }
}
