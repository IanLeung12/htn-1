/**
 * Plans the orbit of viewpoints `AppHandle.captureRoomShell` walks (on device
 * the guide would step the user through them one at a time, same as
 * src/app/guide.ts's clean-plate arc; the simulator/tests capture from each
 * pose directly via the CameraFrameSource).
 */
import * as THREE from 'three';
import type { Aabb, Pose, Quat, SceneSnapshot, Vec3 } from '@/core/types';

const ORBIT_COUNT = 8;
const DOWNWARD_COUNT = 4;
const ORBIT_HEIGHT_M = 1.5;
const MIN_RADIUS_M = 0.6;
const MAX_RADIUS_M = 3;

function lookAtQuat(eye: Vec3, target: Vec3): Quat {
  const m = new THREE.Matrix4().lookAt(
    new THREE.Vector3(eye.x, eye.y, eye.z),
    new THREE.Vector3(target.x, target.y, target.z),
    new THREE.Vector3(0, 1, 0),
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function unionAabb(boxes: Aabb[]): Aabb | undefined {
  if (boxes.length === 0) return undefined;
  const min: Vec3 = { ...boxes[0]!.min };
  const max: Vec3 = { ...boxes[0]!.max };
  for (const b of boxes) {
    min.x = Math.min(min.x, b.min.x);
    min.y = Math.min(min.y, b.min.y);
    min.z = Math.min(min.z, b.min.z);
    max.x = Math.max(max.x, b.max.x);
    max.y = Math.max(max.y, b.max.y);
    max.z = Math.max(max.z, b.max.z);
  }
  return { min, max };
}

/** Floor surfaces' union AABB, falling back to every known surface if none is labeled floor. */
function floorAabb(snapshot: SceneSnapshot): Aabb {
  const surfaces = Object.values(snapshot.surfaces);
  const floors = surfaces.filter((s) => s.label === 'floor').map((s) => s.aabb);
  const box = unionAabb(floors.length > 0 ? floors : surfaces.map((s) => s.aabb));
  return box ?? { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 0, z: 1 } };
}

export interface RoomShellPlan {
  viewpoints: Pose[];
  center: Vec3;
}

/**
 * 8 viewpoints orbiting the room centre at 1.5m above the floor, looking
 * outward at the walls, plus 4 viewpoints looking straight down at the
 * floor, evenly spread over its footprint.
 */
export function planRoomShellViewpoints(snapshot: SceneSnapshot): RoomShellPlan {
  const box = floorAabb(snapshot);
  const floorY = box.max.y;
  const center: Vec3 = {
    x: (box.min.x + box.max.x) / 2,
    y: floorY,
    z: (box.min.z + box.max.z) / 2,
  };
  const halfWidth = Math.max(0.1, (box.max.x - box.min.x) / 2);
  const halfDepth = Math.max(0.1, (box.max.z - box.min.z) / 2);
  const radius = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, 0.6 * Math.max(halfWidth, halfDepth)));

  const viewpoints: Pose[] = [];
  for (let i = 0; i < ORBIT_COUNT; i++) {
    const angle = (i / ORBIT_COUNT) * Math.PI * 2;
    const position: Vec3 = {
      x: center.x + radius * Math.cos(angle),
      y: floorY + ORBIT_HEIGHT_M,
      z: center.z + radius * Math.sin(angle),
    };
    // "Looking outward at walls": face away from the room centre.
    const away: Vec3 = { x: position.x + Math.cos(angle), y: position.y, z: position.z + Math.sin(angle) };
    viewpoints.push({ position, rotation: lookAtQuat(position, away) });
  }

  for (let i = 0; i < DOWNWARD_COUNT; i++) {
    const angle = (i / DOWNWARD_COUNT) * Math.PI * 2 + Math.PI / DOWNWARD_COUNT;
    const r = radius * 0.5;
    const position: Vec3 = {
      x: center.x + r * Math.cos(angle),
      y: floorY + ORBIT_HEIGHT_M,
      z: center.z + r * Math.sin(angle),
    };
    const below: Vec3 = { x: position.x, y: floorY, z: position.z };
    viewpoints.push({ position, rotation: lookAtQuat(position, below) });
  }

  return { viewpoints, center };
}
