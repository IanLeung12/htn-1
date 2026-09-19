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
import type { Pose, SemanticLabel, Surface } from '@/core/types';
import type { DetectedVolume } from '@/capture/contract';

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

function polygonAabb(polygon: { x: number; z: number }[], pose: Pose) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minZ = maxZ = 0;
  }
  return {
    min: { x: pose.position.x + minX, y: pose.position.y - 0.01, z: pose.position.z + minZ },
    max: { x: pose.position.x + maxX, y: pose.position.y + 0.01, z: pose.position.z + maxZ },
  };
}

function meshAabb(vertices: Float32Array, pose: Pose) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const x = vertices[i] as number;
    const y = vertices[i + 1] as number;
    const z = vertices[i + 2] as number;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minY = maxY = minZ = maxZ = 0;
  }
  return {
    min: { x: pose.position.x + minX, y: pose.position.y + minY, z: pose.position.z + minZ },
    max: { x: pose.position.x + maxX, y: pose.position.y + maxY, z: pose.position.z + maxZ },
  };
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
  private readonly lastChanged = new Map<string, number>();
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

    this.latestVolumes = volumes;
    this.latestGlobalMeshes = globalMeshes;

    this.maybeAnchorRoom(frame, refSpace);
  }

  private handlePlane(plane: XRPlane, frame: XRFrame, refSpace: XRReferenceSpace, volumes: DetectedVolume[]): void {
    const id = this.idFor(this.planeIds as unknown as WeakMap<object, string>, plane, 'plane');
    const prevChanged = this.lastChanged.get(id);
    if (prevChanged === plane.lastChangedTime) return; // unchanged, skip dispatch

    const xrPose = frame.getPose(plane.planeSpace, refSpace);
    if (!xrPose) return;

    const pose = poseFromXRPose(xrPose);
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

    this.lastChanged.set(id, plane.lastChangedTime);
    this.callbacks.registerSurface(surface);

    if (VOLUME_LABELS.has(plane.semanticLabel ?? '')) {
      const halfX = (surface.aabb.max.x - surface.aabb.min.x) / 2;
      const halfY = 0.02;
      const halfZ = (surface.aabb.max.z - surface.aabb.min.z) / 2;
      volumes.push({
        id,
        label: plane.semanticLabel ?? 'other',
        pose,
        halfExtents: { x: halfX, y: halfY, z: halfZ },
      });
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
    const prevChanged = this.lastChanged.get(id);
    const xrPose = frame.getPose(mesh.meshSpace, refSpace);
    if (!xrPose) return;
    const pose = poseFromXRPose(xrPose);

    const isGlobalMesh = mapSemanticLabel(mesh.semanticLabel) === 'global mesh' || !mesh.semanticLabel;

    if (isGlobalMesh) {
      // Kept as raw collision/occlusion shell, never exposed as a core Surface.
      globalMeshes.push({ id, pose, vertices: mesh.vertices, indices: mesh.indices });
      return;
    }

    if (prevChanged === mesh.lastChangedTime) return;

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
    this.lastChanged.set(id, mesh.lastChangedTime);
    this.callbacks.registerSurface(surface);

    if (VOLUME_LABELS.has(mesh.semanticLabel ?? '')) {
      volumes.push({
        id,
        label: mesh.semanticLabel ?? 'other',
        pose,
        halfExtents: {
          x: (surface.aabb.max.x - surface.aabb.min.x) / 2,
          y: (surface.aabb.max.y - surface.aabb.min.y) / 2,
          z: (surface.aabb.max.z - surface.aabb.min.z) / 2,
        },
        vertices: mesh.vertices,
        indices: mesh.indices,
      });
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
