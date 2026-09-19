/**
 * Scene understanding: converts WebXR plane/mesh detection into core Surface
 * records and capture DetectedVolume records. Feature-detected - if the
 * runtime never populates frame.detectedPlanes/detectedMeshes this module
 * simply never dispatches anything (no throw).
 *
 * Also opportunistically anchors the room origin via frame.createAnchor when
 * the 'anchors' feature is enabled, tracking localized anchor ids for
 * RuntimeConditions.localizedAnchors.
 */
import type { Pose, SemanticLabel, Surface, Vec3 } from '@/core/types';
import type { DetectedVolume } from '@/capture/contract';
import { quatRotateVec3 } from '@/core/math';

const VOLUME_LABELS = new Set(['table', 'desk', 'shelf', 'couch', 'bed', 'storage', 'lamp', 'plant', 'screen']);

const SEMANTIC_MAP: Record<string, SemanticLabel> = {
  desk: 'desk',
  couch: 'couch',
  floor: 'floor',
  ceiling: 'ceiling',
  wall: 'wall',
  door: 'door',
  window: 'window',
  table: 'table',
  shelf: 'shelf',
  bed: 'bed',
  screen: 'screen',
  lamp: 'lamp',
  plant: 'plant',
  'wall art': 'wall art',
  storage: 'storage',
  global_mesh: 'global mesh',
  'global mesh': 'global mesh',
};

function mapSemanticLabel(raw: string | undefined): SemanticLabel {
  if (!raw) return 'other';
  return SEMANTIC_MAP[raw] ?? 'other';
}

function poseFromXRPose(xrPose: XRPose): Pose {
  const p = xrPose.transform.position;
  const o = xrPose.transform.orientation;
  return {
    position: { x: p.x, y: p.y, z: p.z },
    rotation: { x: o.x, y: o.y, z: o.z, w: o.w },
  };
}

function aabbOfLocalPoints(points: Iterable<Vec3>, pose: Pose, pad: Vec3) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const local of points) {
    // Rotate into world orientation, then translate: plane polygons and mesh
    // vertices are reported in the entity's own space, and Quest furniture is
    // frequently rotated 90 degrees about some axis.
    const r = quatRotateVec3(pose.rotation, local);
    const x = pose.position.x + r.x;
    const y = pose.position.y + r.y;
    const z = pose.position.z + r.z;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  if (!Number.isFinite(min.x)) {
    return {
      min: { x: pose.position.x - pad.x, y: pose.position.y - pad.y, z: pose.position.z - pad.z },
      max: { x: pose.position.x + pad.x, y: pose.position.y + pad.y, z: pose.position.z + pad.z },
    };
  }
  return {
    min: { x: min.x - pad.x, y: min.y - pad.y, z: min.z - pad.z },
    max: { x: max.x + pad.x, y: max.y + pad.y, z: max.z + pad.z },
  };
}

/** Content signature for change detection (pose rounded to 1 mm / 1e-3 rad, geometry size). */
function poseSignature(pose: Pose, size: number, _lastChanged: number): string {
  const p = pose.position;
  const r = pose.rotation;
  return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}|${r.x.toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)},${r.w.toFixed(3)}|${size}`;
}

function aabbCenter(aabb: { min: Vec3; max: Vec3 }): Vec3 {
  return { x: (aabb.min.x + aabb.max.x) / 2, y: (aabb.min.y + aabb.max.y) / 2, z: (aabb.min.z + aabb.max.z) / 2 };
}

function polygonAabb(polygon: { x: number; z: number }[], pose: Pose) {
  return aabbOfLocalPoints(polygon.map((p) => ({ x: p.x, y: 0, z: p.z })), pose, { x: 0, y: 0.01, z: 0 });
}

function* vertexPoints(vertices: Float32Array): Iterable<Vec3> {
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    yield { x: vertices[i] as number, y: vertices[i + 1] as number, z: vertices[i + 2] as number };
  }
}

function meshAabb(vertices: Float32Array, pose: Pose) {
  return aabbOfLocalPoints(vertexPoints(vertices), pose, { x: 0, y: 0, z: 0 });
}

export interface SceneUnderstandingCallbacks {
  registerSurface(surface: Surface): void;
  removeSurface(surfaceId: string): void;
}

/** A raw global mesh kept for shell/collision rendering, not exposed as a Surface. */
export interface RawGlobalMesh {
  id: string;
  pose: Pose;
  vertices: Float32Array;
  indices: Uint32Array;
}

export class SceneUnderstanding {
  private readonly lastChanged = new Map<string, string>();
  private readonly volumeCache = new Map<string, DetectedVolume>();
  private readonly planeIds = new WeakMap<XRPlane, string>();
  private readonly meshIds = new WeakMap<object, string>();
  private nextId = 0;
  private roomAnchor: XRAnchor | null = null;
  private roomAnchorRequested = false;

  readonly localizedAnchors = new Set<string>();
  /** Volumes discovered this frame, for capture.discover(). */
  latestVolumes: DetectedVolume[] = [];
  /** Global mesh shells for shell/collision rendering (not surfaces). */
  latestGlobalMeshes: RawGlobalMesh[] = [];

  constructor(private readonly callbacks: SceneUnderstandingCallbacks) {}

  private idFor(map: WeakMap<object, string>, key: object, prefix: string): string {
    let id = map.get(key);
    if (!id) {
      id = `${prefix}-${this.nextId++}`;
      map.set(key, id);
    }
    return id;
  }

  /** Call once per rendered XR frame with the active reference space. */
  update(frame: XRFrame | undefined, refSpace: XRReferenceSpace | null): void {
    if (!frame || !refSpace) return;

    const volumes: DetectedVolume[] = [];
    const globalMeshes: RawGlobalMesh[] = [];

    const planes = frame.detectedPlanes;
    if (planes) {
      for (const plane of planes) {
        this.handlePlane(plane, frame, refSpace, volumes);
      }
    }

    const meshes = frame.detectedMeshes;
    if (meshes) {
      for (const mesh of meshes) {
        this.handleMesh(mesh, frame, refSpace, volumes, globalMeshes);
      }
    }

    // Quest exposes furniture both as a top plane and as a labelled mesh/box volume.
    // Plane-derived volumes are thin slabs with the plane's orientation and are only a
    // fallback for runtimes that never report labelled meshes; when real volumes exist,
    // drop the slabs so candidate discovery works on true object extents.
    const meshVolumes = volumes.filter((v) => v.id.startsWith('mesh-'));
    this.latestVolumes = meshVolumes.length > 0 ? meshVolumes : volumes;
    this.latestGlobalMeshes = globalMeshes;

    this.maybeAnchorRoom(frame, refSpace);
  }

  private handlePlane(plane: XRPlane, frame: XRFrame, refSpace: XRReferenceSpace, volumes: DetectedVolume[]): void {
    const id = this.idFor(this.planeIds as unknown as WeakMap<object, string>, plane, 'plane');
    const xrPose = frame.getPose(plane.planeSpace, refSpace);
    if (!xrPose) return;

    const pose = poseFromXRPose(xrPose);
    // Some runtimes (the emulator included) bump lastChangedTime every frame, so
    // change detection uses a content signature: pose + polygon vertex count.
    const signature = poseSignature(pose, plane.polygon.length, plane.lastChangedTime);
    if (this.lastChanged.get(id) === signature) {
      if (VOLUME_LABELS.has(plane.semanticLabel ?? '')) {
        const cached = this.volumeCache.get(id);
        if (cached) volumes.push(cached);
      }
      return;
    }
    const label = mapSemanticLabel(plane.semanticLabel);
    const polygon = plane.polygon.map((p) => ({ x: p.x, z: p.z }));

    const surface: Surface = {
      id,
      label,
      orientation: plane.orientation === 'horizontal' ? 'horizontal' : 'vertical',
      pose,
      polygon,
      aabb: polygonAabb(polygon, pose),
      lastChanged: plane.lastChangedTime,
    };

    this.lastChanged.set(id, signature);
    this.callbacks.registerSurface(surface);

    if (VOLUME_LABELS.has(plane.semanticLabel ?? '')) {
      const halfX = (surface.aabb.max.x - surface.aabb.min.x) / 2;
      const halfY = 0.02;
      const halfZ = (surface.aabb.max.z - surface.aabb.min.z) / 2;
      const volume: DetectedVolume = {
        id,
        label: plane.semanticLabel ?? 'other',
        pose: { position: aabbCenter(surface.aabb), rotation: pose.rotation },
        halfExtents: { x: halfX, y: halfY, z: halfZ },
      };
      this.volumeCache.set(id, volume);
      volumes.push(volume);
    }
  }

  private handleMesh(
    mesh: XRMesh,
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    volumes: DetectedVolume[],
    globalMeshes: RawGlobalMesh[],
  ): void {
    const id = this.idFor(this.meshIds, mesh as unknown as object, 'mesh');
    const xrPose = frame.getPose(mesh.meshSpace, refSpace);
    if (!xrPose) return;
    const pose = poseFromXRPose(xrPose);

    const isGlobalMesh = mapSemanticLabel(mesh.semanticLabel) === 'global mesh' || !mesh.semanticLabel;

    if (isGlobalMesh) {
      // Kept as raw collision/occlusion shell, never exposed as a core Surface.
      globalMeshes.push({ id, pose, vertices: mesh.vertices, indices: mesh.indices });
      return;
    }

    const signature = poseSignature(pose, mesh.vertices.length, mesh.lastChangedTime);
    if (this.lastChanged.get(id) === signature) {
      const cached = this.volumeCache.get(id);
      if (cached) volumes.push(cached);
      return;
    }

    const label = mapSemanticLabel(mesh.semanticLabel);
    const surface: Surface = {
      id,
      label,
      orientation: 'mesh',
      pose,
      polygon: [],
      aabb: meshAabb(mesh.vertices, pose),
      lastChanged: mesh.lastChangedTime,
    };
    this.lastChanged.set(id, signature);
    this.callbacks.registerSurface(surface);

    if (VOLUME_LABELS.has(mesh.semanticLabel ?? '')) {
      // Quest volumes report their origin at the top-face centre; the object package
      // wants the geometric centre so proxies and footprints line up with the AABB.
      const volume: DetectedVolume = {
        id,
        label: mesh.semanticLabel ?? 'other',
        pose: { position: aabbCenter(surface.aabb), rotation: pose.rotation },
        halfExtents: {
          x: (surface.aabb.max.x - surface.aabb.min.x) / 2,
          y: (surface.aabb.max.y - surface.aabb.min.y) / 2,
          z: (surface.aabb.max.z - surface.aabb.min.z) / 2,
        },
        vertices: mesh.vertices,
        indices: mesh.indices,
      };
      this.volumeCache.set(id, volume);
      volumes.push(volume);
    }
  }

  private maybeAnchorRoom(frame: XRFrame, refSpace: XRReferenceSpace): void {
    if (this.roomAnchor || this.roomAnchorRequested) return;
    if (typeof frame.createAnchor !== 'function') return;
    this.roomAnchorRequested = true;
    frame
      .createAnchor(new XRRigidTransform(), refSpace)
      .then((anchor) => {
        this.roomAnchor = anchor;
        this.localizedAnchors.add('room-origin');
      })
      .catch(() => {
        // Anchors unsupported or the frame expired before the promise settled; not fatal.
      });
  }

  dispose(): void {
    try {
      this.roomAnchor?.delete();
    } catch {
      // Anchor may already be invalid.
    }
  }
}
