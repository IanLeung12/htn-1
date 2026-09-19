/**
 * Read-only queries over a SceneSnapshot: nearest-object lookup, proxy
 * raycasting, region membership, and "what surface is directly below this
 * point" for placement/drop logic.
 */
import type { Aabb, EditableObject, Pose, Region, SceneSnapshot, Surface, Vec3 } from './types';
import { aabbContains, add, distance, normalize, poseInverse, quatRotateVec3, length } from './math';

export function nearestObjects(snapshot: SceneSnapshot, point: Vec3, maxDistance: number): EditableObject[] {
  return Object.values(snapshot.objects)
    .filter((o) => o.visible)
    .map((o) => ({ o, d: distance(o.currentPose.position, point) }))
    .filter(({ d }) => d <= maxDistance)
    .sort((a, b) => a.d - b.d)
    .map(({ o }) => o);
}

export interface RaycastHit {
  objectId: string;
  distance: number;
  point: Vec3;
  /** True when the ray origin was already inside the proxy (a hand enclosed by the object). */
  originInside: boolean;
}

function rayBoxLocal(originLocal: Vec3, dirLocal: Vec3, halfExtents: Vec3): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;

  const axes: (keyof Vec3)[] = ['x', 'y', 'z'];
  for (const axis of axes) {
    const o = originLocal[axis];
    const d = dirLocal[axis];
    const he = halfExtents[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < -he || o > he) return null;
      continue;
    }
    const t1 = (-he - o) / d;
    const t2 = (he - o) / d;
    const tNear = Math.min(t1, t2);
    const tFar = Math.max(t1, t2);
    tMin = Math.max(tMin, tNear);
    tMax = Math.min(tMax, tFar);
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  return tMin >= 0 ? tMin : tMax;
}

function pointInBoxLocal(p: Vec3, he: Vec3): boolean {
  return Math.abs(p.x) <= he.x && Math.abs(p.y) <= he.y && Math.abs(p.z) <= he.z;
}

function raySphereLocal(originLocal: Vec3, dirLocal: Vec3, radius: number): number | null {
  // dirLocal assumed normalized.
  const b = originLocal.x * dirLocal.x + originLocal.y * dirLocal.y + originLocal.z * dirLocal.z;
  const c = originLocal.x * originLocal.x + originLocal.y * originLocal.y + originLocal.z * originLocal.z - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = -b - sqrtDisc;
  const t2 = -b + sqrtDisc;
  if (t2 < 0) return null;
  return t1 >= 0 ? t1 : t2;
}

/** Raycast against object interaction proxies. Box uses a true OBB via the object's pose. */
export function raycastProxies(snapshot: SceneSnapshot, origin: Vec3, direction: Vec3, maxDistance: number, padM = 0): RaycastHit[] {
  const dir = normalize(direction);
  // `padM` grows every proxy so small real objects (a 6 cm can seen from 0.5 m) are easier to
  // hover with a mouse; hits stay sorted by distance so a padded far object never wins over a
  // nearer one.
  const pad = (he: Vec3): Vec3 => (padM > 0 ? { x: he.x + padM, y: he.y + padM, z: he.z + padM } : he);
  const hits: RaycastHit[] = [];

  for (const o of Object.values(snapshot.objects)) {
    if (!o.visible) continue;
    const pose: Pose = o.currentPose;
    const inv = poseInverse(pose);
    const originLocal = add(quatRotateVec3(inv.rotation, origin), inv.position);
    const dirLocal = quatRotateVec3(inv.rotation, dir);

    const proxy = o.interactionProxy;
    let t: number | null = null;
    let originInside = false;
    if (proxy.kind === 'box') {
      const he = pad(proxy.halfExtents);
      t = rayBoxLocal(originLocal, dirLocal, he);
      originInside = pointInBoxLocal(originLocal, he);
    } else if (proxy.kind === 'sphere') {
      t = raySphereLocal(originLocal, dirLocal, proxy.radius + padM);
      originInside = length(originLocal) <= proxy.radius + padM;
    } else {
      // capsule: approximate as a box (radius, halfHeight+radius, radius).
      const he = pad({ x: proxy.radius, y: proxy.halfHeight + proxy.radius, z: proxy.radius });
      t = rayBoxLocal(originLocal, dirLocal, he);
      originInside = pointInBoxLocal(originLocal, he);
    }

    if (t !== null && t >= 0 && t <= maxDistance) {
      hits.push({ objectId: o.id, distance: t, point: add(origin, { x: dir.x * t, y: dir.y * t, z: dir.z * t }), originInside });
    }
  }

  return hits.sort((a, b) => a.distance - b.distance);
}

export function objectsInRegion(snapshot: SceneSnapshot, region: Region): EditableObject[] {
  return Object.values(snapshot.objects).filter((o) => o.visible && aabbContains(region.bounds, o.currentPose.position));
}

/** Nearest horizontal surface strictly at or below the given point (by vertical drop). */
export function surfaceBelow(snapshot: SceneSnapshot, point: Vec3): Surface | undefined {
  let best: Surface | undefined;
  let bestDrop = Infinity;

  for (const s of Object.values(snapshot.surfaces)) {
    if (s.orientation !== 'horizontal') continue;
    const box: Aabb = s.aabb;
    if (point.x < box.min.x || point.x > box.max.x) continue;
    if (point.z < box.min.z || point.z > box.max.z) continue;
    if (box.max.y > point.y + 1e-9) continue; // surface must be at/below the point
    const drop = point.y - box.max.y;
    if (drop < bestDrop) {
      bestDrop = drop;
      best = s;
    }
  }

  return best;
}

export default { nearestObjects, raycastProxies, objectsInRegion, surfaceBelow };
