/**
 * Background hull: hides a physical object that has been deleted or moved by
 * rendering the TRUE background behind it, from wherever the head currently
 * is, within the object's verified capture envelope - outside it we render
 * nothing, same rule plates.ts uses.
 *
 * v2 (parallax-correct): for each clean-plate frame captured with per-pixel
 * depth (`CameraFrame.depth`, see capture/contract.ts), we build a textured
 * depth mesh (render/depth-mesh.ts) that unprojects every pixel into world
 * space - i.e. it reproduces the actual 3D shape of whatever is physically
 * behind the object (a wall, the floor, a couch further back), not just a
 * flat projection painted onto the object's own bounding box. Painting the
 * proxy box's faces (v1, still used as a fallback below) is only correct
 * when the head is exactly at the capture viewpoint; from any other angle it
 * shows whatever the box face's *own* surface projects to, which is wrong
 * whenever the real background isn't coplanar with that face (e.g. it shows
 * ceiling/couch instead of the wall actually behind a deleted table).
 *
 * A single clean-plate viewpoint only ever sees part of what's behind an
 * object - whatever that one camera's line of sight could reach is baked
 * into its depth mesh, and nothing else. Guided capture takes several
 * viewpoints around the object precisely so their combined coverage is
 * (close to) complete (see src/app/guide.ts), so rather than picking one
 * "nearest" frame and leaving the rest of the silhouette uncovered from
 * angles that frame's capture couldn't see, every captured frame's depth
 * mesh is rendered together, stencil-clipped to the same silhouette; the
 * ordinary GL depth test resolves whichever one is actually closest to the
 * camera wherever more than one covers the same surface point.
 *
 * Because a depth mesh's silhouette rarely matches the object's occlusion
 * proxy exactly (grid subsampling, dropped triangles at depth
 * discontinuities, capture noise), we clip it with the stencil buffer: the
 * proxy box is first stamped into the stencil buffer at the object's
 * ORIGINAL pose (invisible - colorWrite off), then each depth mesh is drawn
 * only where the stencil test passes, i.e. strictly inside the silhouette of
 * the thing being hidden. Real passthrough (or the shell) shows through
 * everywhere else, so a background surface that pokes slightly outside the
 * proxy box is never incorrectly overpainted.
 */
import * as THREE from 'three';
import type { EditableObject, Pose, SceneSnapshot, Vec3 } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import type { FrameStore } from '@/capture/frame-store';
import { distance } from '@/core/math';
import { insideEnvelope } from './plates';
import { createProjectiveMaterial, setMaterialFrame, createUnlitTextureMaterial, setUnlitMaterialFrame, setUnlitClipBox, setUnlitEyePosition, createDepthResetMaterial } from './projective';
import { getDepthMeshGeometry } from './depth-mesh';

const RESELECT_DISTANCE_M = 0.1;

/** Draw order relative to the rest of the frame (see render/shell.ts and render/objects.ts). */
const RENDER_ORDER_STENCIL_BOX = 0.5;
const RENDER_ORDER_DEPTH_MESH = 1;
const RENDER_ORDER_FALLBACK_BOX = 1;

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

/** World-space AABB of the object's occlusion proxy at its ORIGINAL pose (proxies are axis-aligned). */
function clipBoxFor(obj: EditableObject): { min: Vec3; max: Vec3 } {
  const p = obj.originalPose.position;
  const proxy = obj.occlusionProxy;
  const he =
    proxy.kind === 'box'
      ? proxy.halfExtents
      : proxy.kind === 'sphere'
        ? { x: proxy.radius, y: proxy.radius, z: proxy.radius }
        : { x: proxy.radius, y: proxy.halfHeight + proxy.radius, z: proxy.radius };
  const pad = 0.02;
  return {
    min: { x: p.x - he.x - pad, y: p.y - he.y - pad, z: p.z - he.z - pad },
    max: { x: p.x + he.x + pad, y: p.y + he.y + pad, z: p.z + he.z + pad },
  };
}

/** Allocates small stable integers (1..255) for stencil refs, reused once freed. */
class StencilRefPool {
  private next = 1;
  private free: number[] = [];
  private assigned = new Map<string, number>();

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

interface FrameMesh {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

interface HullEntry {
  /** Invisible: stamps the object's silhouette into the stencil buffer at its original pose. */
  stencilMesh: THREE.Mesh;
  stencilMaterial: THREE.ShaderMaterial;
  /**
   * One parallax-correct textured depth mesh per captured frame that has
   * depth, all drawn simultaneously (stencil-clipped, normal GL depth test
   * resolves overlaps) - `null` cached for a frame whose depth mesh turned
   * out degenerate (e.g. all triangles dropped at discontinuities), so we
   * do not keep re-attempting to build it.
   */
  depthMeshes: Map<CameraFrame, FrameMesh | null>;
  /** v1 fallback: single-frame box projection, used only when NO frame yields a usable depth mesh. */
  fallbackMesh: THREE.Mesh;
  fallbackMaterial: THREE.ShaderMaterial;
  stencilRef: number;
  lastHeadPos: Vec3 | null;
  selectedFallbackFrame: CameraFrame | null;
}

export class BackgroundHull {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, HullEntry>();
  private readonly stencilRefs = new StencilRefPool();
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
        this.group.remove(entry.stencilMesh, entry.fallbackMesh);
        for (const fm of entry.depthMeshes.values()) {
          if (fm) this.group.remove(fm.mesh);
        }
        this.entries.delete(id);
        this.stencilRefs.release(id);
      }
    }
  }

  private envelopeVisible(obj: EditableObject, headPose: Pose): boolean {
    for (const plate of obj.background) {
      if (insideEnvelope(headPose, plate)) return true;
    }
    return false;
  }

  private buildEntry(obj: EditableObject): HullEntry {
    const stencilRef = this.stencilRefs.acquire(obj.id);

    const stencilGeometry = geometryForProxy(obj);
    // Depth reset (see projective.ts createDepthResetMaterial): clears the
    // environment/static depth inside the silhouette so the hull can draw.
    const stencilMaterial = createDepthResetMaterial();
    stencilMaterial.stencilWrite = true;
    stencilMaterial.stencilFunc = THREE.AlwaysStencilFunc;
    stencilMaterial.stencilRef = stencilRef;
    stencilMaterial.stencilZPass = THREE.ReplaceStencilOp;
    const stencilMesh = new THREE.Mesh(stencilGeometry, stencilMaterial);
    stencilMesh.name = `background-hull-stencil:${obj.id}`;
    stencilMesh.renderOrder = RENDER_ORDER_STENCIL_BOX;
    stencilMesh.position.set(obj.originalPose.position.x, obj.originalPose.position.y, obj.originalPose.position.z);
    stencilMesh.quaternion.set(
      obj.originalPose.rotation.x,
      obj.originalPose.rotation.y,
      obj.originalPose.rotation.z,
      obj.originalPose.rotation.w,
    );

    const fallbackMaterial = createProjectiveMaterial();
    const fallbackMesh = new THREE.Mesh(geometryForProxy(obj), fallbackMaterial);
    fallbackMesh.name = `background-hull-fallback:${obj.id}`;
    fallbackMesh.renderOrder = RENDER_ORDER_FALLBACK_BOX;
    fallbackMesh.position.copy(stencilMesh.position);
    fallbackMesh.quaternion.copy(stencilMesh.quaternion);

    this.group.add(stencilMesh, fallbackMesh);

    return {
      stencilMesh,
      stencilMaterial,
      depthMeshes: new Map(),
      fallbackMesh,
      fallbackMaterial,
      stencilRef,
      lastHeadPos: null,
      selectedFallbackFrame: null,
    };
  }

  /** Lazily build (and cache) this entry's depth-mesh Mesh for one captured frame. */
  private getOrBuildFrameMesh(entry: HullEntry, frame: CameraFrame, obj: EditableObject): FrameMesh | null {
    const cached = entry.depthMeshes.get(frame);
    if (cached !== undefined) return cached;

    const geometry = frame.depth ? getDepthMeshGeometry(frame) : null;
    if (!geometry) {
      entry.depthMeshes.set(frame, null);
      return null;
    }

    const material = createUnlitTextureMaterial();
    // Silhouette clip is done in the shader (see projective.ts): the stencil path is
    // kept as a no-op fallback because some XR framebuffers expose no stencil bits.
    material.depthWrite = true;
    material.depthTest = true;
    setUnlitMaterialFrame(material, frame);
    const clip = clipBoxFor(obj);
    setUnlitClipBox(material, clip.min, clip.max);

    // Depth-mesh geometry vertices are already in world space (unprojected
    // per-pixel, see render/depth-mesh.ts), so the mesh itself stays at the
    // identity transform - baking a further object-pose offset would move
    // already-absolute coordinates a second time.
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `background-hull-depth:${frame.timestamp}`;
    mesh.renderOrder = RENDER_ORDER_DEPTH_MESH;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;

    const entryMesh: FrameMesh = { mesh, material };
    entry.depthMeshes.set(frame, entryMesh);
    this.group.add(mesh);
    return entryMesh;
  }

  private syncEntry(obj: EditableObject, headPose: Pose): void {
    let entry = this.entries.get(obj.id);
    if (!entry) {
      entry = this.buildEntry(obj);
      this.entries.set(obj.id, entry);
    }

    const visible = this.envelopeVisible(obj, headPose);
    const frames = this.frameStore.get(obj.id);

    if (!visible || !frames || frames.length === 0) {
      entry.stencilMesh.visible = false;
      entry.fallbackMesh.visible = false;
      for (const fm of entry.depthMeshes.values()) {
        if (fm) fm.mesh.visible = false;
      }
      return;
    }

    // Render every frame's depth mesh at once (stencil-clipped to the same
    // silhouette): together their coverage is much closer to complete than
    // any single "nearest" viewpoint's, since each one only ever saw part
    // of what's behind the object from its own capture angle.
    let anyDepthMesh = false;
    for (const frame of frames) {
      const fm = this.getOrBuildFrameMesh(entry, frame, obj);
      if (fm) {
        fm.mesh.visible = true;
        setUnlitEyePosition(fm.mesh.material as THREE.ShaderMaterial, headPose.position);
        anyDepthMesh = true;
      }
    }

    entry.stencilMesh.visible = anyDepthMesh;

    if (anyDepthMesh) {
      entry.fallbackMesh.visible = false;
      return;
    }

    // Fallback: none of this object's frames had usable depth - paint the
    // proxy box faces with the flat single nearest-frame projection, same
    // as the original v1 behaviour.
    const moved = !entry.lastHeadPos || distance(entry.lastHeadPos, headPose.position) > RESELECT_DISTANCE_M;
    if (moved || !entry.selectedFallbackFrame) {
      entry.lastHeadPos = headPose.position;
      entry.selectedFallbackFrame = nearestFrame(frames, headPose.position);
    }

    if (!entry.selectedFallbackFrame) {
      entry.fallbackMesh.visible = false;
      return;
    }

    setMaterialFrame(entry.fallbackMaterial, entry.selectedFallbackFrame);
    entry.fallbackMesh.visible = true;
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
