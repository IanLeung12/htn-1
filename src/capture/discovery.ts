/**
 * Pass 1 — candidate discovery. Turns raw detected volumes + known surfaces
 * into CandidateObject proposals. Never invents editability: everything
 * comes back at tier E with approved=false until capture (Pass 2/3) runs.
 */
import type {
  Aabb, EditableObject, PhysicalParams, Pose, SceneSnapshot, SemanticLabel, Surface, Vec3,
} from '@/core/types';
import { ROOM_ANCHOR_ID } from '@/core/types';
import { aabbFromCenterHalfExtents } from '@/core/math';
import type { CandidateObject, DetectedVolume } from './contract';

/** Only these labels can ever become editable candidates. */
const CANDIDATE_LABELS = new Set<string>([
  'table', 'desk', 'shelf', 'couch', 'bed', 'storage', 'lamp', 'plant', 'screen', 'other',
]);

const SUPPORT_GAP_M = 0.08;
/** Scan noise lets an object's bottom sit slightly below its support surface. */
const SUPPORT_PENETRATION_M = 0.1;
const WALL_TOUCH_M = 0.03;
const MAX_DIMENSION_M = 2.0;

function isHorizontal(s: Surface): boolean {
  return s.orientation === 'horizontal';
}

function isVertical(s: Surface): boolean {
  return s.orientation === 'vertical';
}

function xzOverlap(a: Aabb, b: Aabb): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

function xzSize(box: Aabb): number {
  return (box.max.x - box.min.x) * (box.max.z - box.min.z);
}

/** Find the best horizontal surface directly beneath the volume, or the floor. */
function findSupportSurface(volumeAabb: Aabb, surfaces: Surface[]): Surface | undefined {
  let best: Surface | undefined;
  let bestGap = Infinity;
  for (const s of surfaces) {
    if (!isHorizontal(s)) continue;
    if (s.label === 'floor') continue; // considered separately as a fallback below
    if (!xzOverlap(volumeAabb, s.aabb)) continue;
    const gap = volumeAabb.min.y - s.aabb.max.y;
    if (gap < -SUPPORT_PENETRATION_M || gap > SUPPORT_GAP_M) continue; // surface must be at/just below the bottom
    if (Math.abs(gap) < bestGap) {
      bestGap = Math.abs(gap);
      best = s;
    }
  }
  if (best) return best;

  // Fallback: the largest horizontal surface labeled floor, if close enough.
  let floor: Surface | undefined;
  let floorArea = -Infinity;
  for (const s of surfaces) {
    if (!isHorizontal(s) || s.label !== 'floor') continue;
    const area = xzSize(s.aabb);
    if (area > floorArea) {
      floorArea = area;
      floor = s;
    }
  }
  if (floor) {
    const gap = volumeAabb.min.y - floor.aabb.max.y;
    if (gap >= -SUPPORT_PENETRATION_M && gap <= SUPPORT_GAP_M) return floor;
  }
  return undefined;
}

/** Count how many sides of the volume's footprint are flush against a wall. */
function countFlushWalls(volumeAabb: Aabb, surfaces: Surface[]): number {
  let count = 0;
  for (const s of surfaces) {
    if (!isVertical(s)) continue;
    // Vertical surface must overlap the volume's bottom in height.
    const yOverlap = s.aabb.min.y <= volumeAabb.min.y + 0.2 && s.aabb.max.y >= volumeAabb.min.y;
    if (!yOverlap) continue;

    const touchesMinX = Math.abs(volumeAabb.min.x - s.aabb.max.x) <= WALL_TOUCH_M
      || Math.abs(volumeAabb.min.x - s.aabb.min.x) <= WALL_TOUCH_M;
    const touchesMaxX = Math.abs(volumeAabb.max.x - s.aabb.min.x) <= WALL_TOUCH_M
      || Math.abs(volumeAabb.max.x - s.aabb.max.x) <= WALL_TOUCH_M;
    const touchesMinZ = Math.abs(volumeAabb.min.z - s.aabb.max.z) <= WALL_TOUCH_M
      || Math.abs(volumeAabb.min.z - s.aabb.min.z) <= WALL_TOUCH_M;
    const touchesMaxZ = Math.abs(volumeAabb.max.z - s.aabb.min.z) <= WALL_TOUCH_M
      || Math.abs(volumeAabb.max.z - s.aabb.max.z) <= WALL_TOUCH_M;

    // Only count a side if the wall's own footprint actually spans that side
    // (avoid a small far-away wall segment counting from raw distance alone).
    const zOverlapsX = volumeAabb.min.z <= s.aabb.max.z && volumeAabb.max.z >= s.aabb.min.z;
    const xOverlapsZ = volumeAabb.min.x <= s.aabb.max.x && volumeAabb.max.x >= s.aabb.min.x;

    if ((touchesMinX || touchesMaxX) && zOverlapsX) count += 1;
    else if ((touchesMinZ || touchesMaxZ) && xOverlapsZ) count += 1;
  }
  return count;
}

function physicalParamsFor(label: SemanticLabel): PhysicalParams {
  const friction = 0.6;
  const restitution = 0.1;
  switch (label) {
    case 'couch':
      return { massKg: 40, friction, restitution, kinematic: true };
    case 'bed':
      return { massKg: 35, friction, restitution, kinematic: true };
    case 'storage':
      return { massKg: 12, friction, restitution, kinematic: false };
    case 'shelf':
      return { massKg: 10, friction, restitution, kinematic: false };
    case 'table':
      return { massKg: 15, friction, restitution, kinematic: false };
    case 'desk':
      return { massKg: 15, friction, restitution, kinematic: false };
    case 'screen':
      return { massKg: 5, friction, restitution, kinematic: false };
    case 'lamp':
      return { massKg: 3, friction, restitution, kinematic: false };
    case 'plant':
      return { massKg: 4, friction, restitution, kinematic: false };
    case 'other':
    default:
      return { massKg: 2, friction, restitution, kinematic: false };
  }
}

function footprintRegion(volumeAabb: Aabb, supportSurface: Surface | undefined): Aabb {
  const thickness = 0.01;
  const y = supportSurface ? supportSurface.aabb.max.y : volumeAabb.min.y;
  return {
    min: { x: volumeAabb.min.x, y: y - thickness / 2, z: volumeAabb.min.z },
    max: { x: volumeAabb.max.x, y: y + thickness / 2, z: volumeAabb.max.z },
  };
}

export function discover(volumes: DetectedVolume[], snapshot: SceneSnapshot): CandidateObject[] {
  const surfaces = Object.values(snapshot.surfaces);
  const candidates: CandidateObject[] = [];
  const labelCounts = new Map<string, number>();

  for (const volume of volumes) {
    if (!CANDIDATE_LABELS.has(volume.label)) continue; // walls/floor/ceiling/doors/etc never become candidates

    const label = volume.label as SemanticLabel;
    const inflatedHalf: Vec3 = {
      x: volume.halfExtents.x + 0.02,
      y: volume.halfExtents.y + 0.02,
      z: volume.halfExtents.z + 0.02,
    };
    const volumeAabb = aabbFromCenterHalfExtents(volume.pose.position, volume.halfExtents);

    const supportSurface = findSupportSurface(volumeAabb, surfaces);
    const flushWalls = countFlushWalls(volumeAabb, surfaces);
    const dims = [
      volume.halfExtents.x * 2,
      volume.halfExtents.y * 2,
      volume.halfExtents.z * 2,
    ];
    const oversized = dims.some((d) => d > MAX_DIMENSION_M);

    const restricted = !supportSurface || flushWalls >= 2 || oversized;

    const reasons: string[] = [];
    if (!supportSurface) reasons.push('no support surface found within 0.08m');
    if (flushWalls >= 2) reasons.push(`flush against ${flushWalls} walls`);
    if (oversized) reasons.push('exceeds 2.0m in a dimension');

    const rationale = restricted
      ? `${label}: ${reasons.join('; ')}; placement-restricted (tier E, not deletable)`
      : `${label}: supported by ${supportSurface!.id}; eligible for guided clean-plate capture`;

    const index = (labelCounts.get(label) ?? 0) + 1;
    labelCounts.set(label, index);

    const now = Date.now();
    const pose: Pose = volume.pose;

    const object: EditableObject = {
      id: `obj:${volume.id}`,
      label,
      userName: `${label} ${index}`,
      origin: 'physical',
      originalPose: pose,
      currentPose: pose,
      anchorId: ROOM_ANCHOR_ID,
      visual: { kind: 'primitive' },
      interactionProxy: { kind: 'box', halfExtents: inflatedHalf },
      collisionProxy: { kind: 'box', halfExtents: volume.halfExtents },
      occlusionProxy: { kind: 'box', halfExtents: volume.halfExtents },
      supportSurfaces: supportSurface ? [supportSurface.id] : [],
      background: [],
      provenance: { method: 'scene_volume', capturedAt: now, capturePath: [] },
      tier: 'E',
      tierConfidence: 0.5,
      envelope: { center: pose.position, radius: 2.5, maxAngle: 1.2 },
      physical: physicalParamsFor(label),
      approved: false,
      visible: true,
    };

    candidates.push({
      object,
      rationale,
      exposedRegion: footprintRegion(volumeAabb, supportSurface),
    });
  }

  return candidates;
}
