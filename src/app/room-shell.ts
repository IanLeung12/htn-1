/**
 * Plans the orbit of viewpoints `AppHandle.captureRoomShell` walks (on device
 * the guide would step the user through them one at a time, same as
 * src/app/guide.ts's clean-plate arc; the simulator/tests capture from each
 * pose directly via the CameraFrameSource).
 */
import * as THREE from 'three';
import type { Aabb, Pose, Quat, SceneSnapshot, Vec3 } from '@/core/types';

const RING_COUNT = 8;
const CENTRE_COUNT = 4;
const MIN_RADIUS_M = 0.6;
const MAX_RADIUS_M = 3;

/** Ring A: outward at eye height, walls. */
const RING_A_HEIGHT_M = 1.5;
const RING_A_RADIUS_SCALE = 0.6; // fraction of the room's half-extent, same convention as the original single ring
/** Ring B: closer in, pitched slightly up (upper walls / crown). */
const RING_B_HEIGHT_M = 1.0;
const RING_B_RADIUS_SCALE = 0.35;
const RING_B_UP_TILT_M = 0.6; // aim point raised this much above the viewpoint's own height
/** Ring C: high, looking down at the floor. */
const RING_C_HEIGHT_M = 1.7;
const RING_C_RADIUS_SCALE = 0.5;
/** Centre cluster: looking up at the ceiling and toward each corner. */
const CENTRE_HEIGHT_M = 1.5;

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

/** True when `x`/`z` fall inside `box`'s XZ footprint (a small margin covers viewpoints planned right at the wall). */
function insideFloorFootprint(box: Aabb, x: number, z: number, marginM = 0.15): boolean {
  return (
    x >= box.min.x - marginM && x <= box.max.x + marginM &&
    z >= box.min.z - marginM && z <= box.max.z + marginM
  );
}

/**
 * Three rings plus a centre cluster, enough to reconstruct the whole room
 * (walls, ceiling, floor) as a baked textured mesh (see
 * reality-editor-canonical-architecture.md's "Representation choices: Room"):
 *
 *  - Ring A: 8 viewpoints at eye height (1.5m), further out, looking outward
 *    at the walls (the original single ring).
 *  - Ring B: 8 viewpoints closer to the centre (1.0m height), pitched
 *    slightly upward, so the upper walls/crown are covered too.
 *  - Ring C: 8 viewpoints high up (1.7m), looking straight down at the
 *    floor, spread over its footprint.
 *  - Centre: 4 viewpoints from the room's centre, looking up toward the
 *    ceiling and each of the four floor corners in turn, so the ceiling and
 *    the tops of the walls are covered from directly below.
 *
 * A viewpoint whose XZ position falls outside the floor's AABB (e.g. a small
 * room where the outward scale factor would place it past a wall) is
 * dropped rather than clamped, since a pose outside the room has nothing
 * useful to capture from where it stands.
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
  const halfExtent = Math.max(halfWidth, halfDepth);

  const viewpoints: Pose[] = [];

  const ringRadiusA = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, RING_A_RADIUS_SCALE * halfExtent));
  for (let i = 0; i < RING_COUNT; i++) {
    const angle = (i / RING_COUNT) * Math.PI * 2;
    const position: Vec3 = {
      x: center.x + ringRadiusA * Math.cos(angle),
      y: floorY + RING_A_HEIGHT_M,
      z: center.z + ringRadiusA * Math.sin(angle),
    };
    if (!insideFloorFootprint(box, position.x, position.z)) continue;
    // "Looking outward at walls": face away from the room centre.
    const away: Vec3 = { x: position.x + Math.cos(angle), y: position.y, z: position.z + Math.sin(angle) };
    viewpoints.push({ position, rotation: lookAtQuat(position, away) });
  }

  const ringRadiusB = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M * 0.5, RING_B_RADIUS_SCALE * halfExtent));
  for (let i = 0; i < RING_COUNT; i++) {
    const angle = (i / RING_COUNT) * Math.PI * 2 + Math.PI / RING_COUNT;
    const position: Vec3 = {
      x: center.x + ringRadiusB * Math.cos(angle),
      y: floorY + RING_B_HEIGHT_M,
      z: center.z + ringRadiusB * Math.sin(angle),
    };
    if (!insideFloorFootprint(box, position.x, position.z)) continue;
    // Outward and slightly up: aim past the room centre, raised.
    const awayUp: Vec3 = {
      x: position.x + Math.cos(angle),
      y: position.y + RING_B_UP_TILT_M,
      z: position.z + Math.sin(angle),
    };
    viewpoints.push({ position, rotation: lookAtQuat(position, awayUp) });
  }

  const ringRadiusC = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M * 0.5, RING_C_RADIUS_SCALE * halfExtent));
  for (let i = 0; i < RING_COUNT; i++) {
    const angle = (i / RING_COUNT) * Math.PI * 2 + Math.PI / RING_COUNT;
    const position: Vec3 = {
      x: center.x + ringRadiusC * Math.cos(angle),
      y: floorY + RING_C_HEIGHT_M,
      z: center.z + ringRadiusC * Math.sin(angle),
    };
    if (!insideFloorFootprint(box, position.x, position.z)) continue;
    const below: Vec3 = { x: position.x, y: floorY, z: position.z };
    viewpoints.push({ position, rotation: lookAtQuat(position, below) });
  }

  // Centre cluster: straight up at the ceiling, then toward each of the 4
  // floor corners (still pitched upward) so the ceiling/upper-wall junction
  // is covered from directly below, not just from the rings' oblique angles.
  const centrePos: Vec3 = { x: center.x, y: floorY + CENTRE_HEIGHT_M, z: center.z };
  if (insideFloorFootprint(box, centrePos.x, centrePos.z)) {
    const corners: Vec3[] = [
      { x: box.min.x, y: floorY + CENTRE_HEIGHT_M + 2, z: box.min.z },
      { x: box.max.x, y: floorY + CENTRE_HEIGHT_M + 2, z: box.min.z },
      { x: box.max.x, y: floorY + CENTRE_HEIGHT_M + 2, z: box.max.z },
      { x: box.min.x, y: floorY + CENTRE_HEIGHT_M + 2, z: box.max.z },
    ];
    for (let i = 0; i < CENTRE_COUNT; i++) {
      const target = corners[i % corners.length]!;
      viewpoints.push({ position: centrePos, rotation: lookAtQuat(centrePos, target) });
    }
  }

  return { viewpoints, center };
}
