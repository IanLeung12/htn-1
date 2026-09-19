/**
 * Scene from estimated depth (phase 3, docs/general-camera/architecture.md).
 *
 * Every RANSAC run works on the newest confident metric depth map:
 *
 *  1. Dominant support plane. The largest roughly-horizontal plane in
 *     CAMERA space (normal within `maxTiltRad` of the camera's up axis) is
 *     the world's ground: it defines y = 0, and its normal gives the camera's
 *     true pitch and roll (`correction`). A laptop camera on a desk looking
 *     level at a bed therefore gets the bed/desk as its ground plane even
 *     though the floor is out of frame - which is exactly what physics and
 *     `surfaceBelow` need. The distance from the camera to that plane is
 *     reported as `cameraHeightM`; with a relative monocular model this
 *     distance is the scale anchor the depth fit was given (tuning), so it
 *     is a report, not an independent measurement.
 *  2. Other horizontal planes at ANY height (desk, bed, shelf) become
 *     'table' surfaces when their extent is plausible for furniture
 *     (`planeMinExtentM`); smaller tops are objects, not surfaces.
 *  3. Vertical planes become 'wall' surfaces (orientation 'vertical').
 *  4. Connected components of depth above every horizontal plane become
 *     `DetectedVolume`s for discovery; wall slivers and table tops are
 *     filtered out.
 *
 * Runs at most every `surfaceIntervalMs` and only on a NEW map; the early
 * return allocates nothing. All thresholds come from `getTuning()` so the
 * owner can tune them live (src/camera/tuning.ts).
 */
import type { Aabb, Millis, Pose, Surface, Vec3 } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import { aabbIntersects, distance, quatConjugate, quatFromAxisAngle, quatMultiply, quatRotateVec3 } from '@/core/math';
import type { DepthMap, EstimatedSurface, SurfaceEstimator } from '@/camera/contract';
import type { DetectedVolume } from '@/capture/contract';
import { makeFloorSurface } from './floor-prior';
import { clusterAbovePlane, depthToPointsWithRows, extractPlanes, findHorizontalPlanes, mergeHorizontalPlanes, ransacPlane, type PlaneFit } from './ransac';

/** The subset of camera tuning this estimator consumes (see src/camera/tuning.ts). */
export interface SurfaceTuning {
  ransacThresholdM: number;
  ransacIterations: number;
  planeMinInliers: number;
  planeMinExtentM: number;
  clusterCellM: number;
  clusterMinCount: number;
  clusterMinHeightM: number;
  volumeMaxSideM: number;
  surfaceIntervalMs: number;
  pointStride: number;
}

export const DEFAULT_SURFACE_TUNING: Readonly<SurfaceTuning> = {
  ransacThresholdM: 0.05,
  ransacIterations: 200,
  planeMinInliers: 100,
  planeMinExtentM: 0.4,
  clusterCellM: 0.05,
  clusterMinCount: 30,
  clusterMinHeightM: 0.04,
  volumeMaxSideM: 1.2,
  surfaceIntervalMs: 400,
  pointStride: 2,
};

export interface DepthSurfaceEstimatorOptions {
  cameraHeightM: number;
  /** Half-extent of the published ground square, metres. Default 6. */
  halfSizeM?: number;
  /** Deprecated in favour of tuning.surfaceIntervalMs; kept for callers/tests. */
  minIntervalMs?: number;
  /** Deprecated in favour of tuning.pointStride; kept for callers/tests. */
  stride?: number;
  /** Largest tilt (rad) of the dominant plane from the camera's up axis that still counts as ground. Default 40 degrees. */
  maxTiltRad?: number;
  getTuning?: () => SurfaceTuning;
  /**
   * Tracked poses (ZED SDK bridge): keep the map's pose as the world frame instead of
   * re-deriving pitch/roll/height from the dominant plane, so surfaces, volumes and picks
   * agree with the renderer's camera. The dominant plane is still fitted and reported
   * (`correction.groundY`) so the pose source can put it at y = 0.
   */
  trustPose?: boolean;
}

export interface DepthSurfaceStats {
  points: number;
  floorInliers: number;
  tables: number;
  walls: number;
  volumes: number;
  runMs: number;
}

/** Camera attitude implied by the dominant plane (camera-space fit). */
export interface FrameCorrection {
  /** Absolute pitch (rad, negative = looking down) that makes the dominant plane horizontal. */
  pitchRad: number;
  /** Absolute roll (rad) that makes the dominant plane level left-right. */
  rollRad: number;
  /** Distance from the camera to the dominant plane (m). */
  heightM: number;
  /** 0..1 from the plane's inlier fraction. */
  confidence: number;
  /** Inlier count behind the estimate (the app only trusts large planes). */
  inliers: number;
  /** True when a side wall's normal agrees with the roll (within 3 degrees); otherwise roll is clamped to +-5 degrees. */
  rollCorroborated: boolean;
  /** Larger in-plane extent of the dominant plane (m); small planes must not steer the attitude. */
  extentM: number;
  /** World y of the dominant plane in the published frame (0 unless `trustPose`, where it is the plane's height in the pose frame). */
  groundY: number;
  at: Millis;
}
/** Horizontal planes higher than this above the ground are ceilings/shelves, not tables. */
const TABLE_MAX_HEIGHT_M = 1.6;
/** trustPose: the pose knows which way is up, so the ground candidate must be within this of horizontal. */
const TRACKED_GROUND_CONE_RAD = (10 * Math.PI) / 180;
/** trustPose: a horizontal plane with this many inliers between TRACKED_TABLE_MIN/MAX_BELOW_M under the camera is a table whatever its extent (a desk seen edge-on from a camera resting on it). */
const TRACKED_TABLE_MIN_INLIERS = 300;
const TRACKED_TABLE_MIN_BELOW_M = 0.02;
const TRACKED_TABLE_MAX_BELOW_M = 1.2;

const FLOOR_MIN_INLIER_FRACTION = 0.1;
const ROLL_CLAMP_RAD = (5 * Math.PI) / 180;
/** Lowest fraction of image rows the ground plane is fitted in first. */
const GROUND_BAND_FRACTION = 0.35;
const GROUND_THRESHOLD_M = 0.025;
/** A volume's lowest seen point must be within this of its support plane. */
const VOLUME_MAX_SUPPORT_GAP_M = 0.15;
/** Monocular depth beyond this is too uncertain to fit planes on. */
const MAX_POINT_DEPTH_M = 6;
const TABLE_MIN_OFFSET_M = 0.08;
const TABLE_ID_MATCH_HEIGHT_M = 0.06;
const TABLE_REGION_PAD_M = 0.1;
const AABB_CHANGE_EPS_M = 0.02;
const VOLUME_MATCH_DIST_M = 0.15;
const VOLUME_TABLE_OVERLAP_FRACTION = 0.5;
const WALL_SLIVER_THIN_M = 0.12;
const WALL_SLIVER_TALL_M = 0.6;

interface Tracked {
  id: string;
  aabb: Aabb;
}

interface TrackedVolume {
  id: string;
  center: Vec3;
}

function aabbCenter(aabb: Aabb): Vec3 {
  return { x: (aabb.min.x + aabb.max.x) / 2, y: (aabb.min.y + aabb.max.y) / 2, z: (aabb.min.z + aabb.max.z) / 2 };
}

function xzOverlapFraction(a: Aabb, b: Aabb): number {
  const ix = Math.max(0, Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x));
  const iz = Math.max(0, Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z));
  const inter = ix * iz;
  if (inter <= 0) return 0;
  const areaA = Math.max(1e-9, (a.max.x - a.min.x) * (a.max.z - a.min.z));
  return inter / areaA;
}

function aabbChangedBeyond(a: Aabb, b: Aabb, eps: number): boolean {
  return (
    Math.abs(a.min.x - b.min.x) > eps || Math.abs(a.min.y - b.min.y) > eps || Math.abs(a.min.z - b.min.z) > eps ||
    Math.abs(a.max.x - b.max.x) > eps || Math.abs(a.max.y - b.max.y) > eps || Math.abs(a.max.z - b.max.z) > eps
  );
}

function horizontalSurface(id: string, label: 'table' | 'floor', fit: PlaneFit, now: Millis): Surface {
  const halfX = (fit.extentMax.x - fit.extentMin.x) / 2;
  const halfZ = (fit.extentMax.z - fit.extentMin.z) / 2;
  const cx = (fit.extentMax.x + fit.extentMin.x) / 2;
  const cz = (fit.extentMax.z + fit.extentMin.z) / 2;
  const y = fit.centroid.y;
  return {
    id,
    label,
    orientation: 'horizontal',
    pose: { position: { x: cx, y, z: cz }, rotation: IDENTITY_QUAT },
    polygon: [
      { x: -halfX, z: -halfZ },
      { x: halfX, z: -halfZ },
      { x: halfX, z: halfZ },
      { x: -halfX, z: halfZ },
    ],
    aabb: { min: { x: cx - halfX, y: y - 0.01, z: cz - halfZ }, max: { x: cx + halfX, y: y + 0.01, z: cz + halfZ } },
    lastChanged: now,
  };
}

function wallSurface(id: string, fit: PlaneFit, now: Millis): Surface {
  const c = fit.centroid;
  const pad = 0.02;
  return {
    id,
    label: 'wall',
    orientation: 'vertical',
    pose: { position: { x: c.x, y: c.y, z: c.z }, rotation: IDENTITY_QUAT },
    polygon: [],
    aabb: {
      min: { x: fit.extentMin.x - pad, y: fit.extentMin.y, z: fit.extentMin.z - pad },
      max: { x: fit.extentMax.x + pad, y: fit.extentMax.y, z: fit.extentMax.z + pad },
    },
    lastChanged: now,
  };
}

/** Rotate a flat XYZ point array in place by `q`, then translate by `t`. */
function transformPoints(points: Float32Array, q: Pose['rotation'], t: Vec3): void {
  const v = { x: 0, y: 0, z: 0 };
  for (let i = 0; i + 2 < points.length; i += 3) {
    v.x = points[i] as number;
    v.y = points[i + 1] as number;
    v.z = points[i + 2] as number;
    const r = quatRotateVec3(q, v);
    points[i] = r.x + t.x;
    points[i + 1] = r.y + t.y;
    points[i + 2] = r.z + t.z;
  }
}

/**
 * Camera attitude from the dominant plane's normal in CAMERA coordinates
 * (camera looks down -Z, +Y up). For a level camera above a horizontal plane
 * the normal is (0, 1, 0); pitching the camera down by `p` (rotation about
 * +X by p < 0) moves the world-up vector to (0, cos p, -sin p) in camera
 * space, so pitch = -atan2(nz, ny); rolling the camera by `r` about its
 * forward axis moves it to (-sin r, cos r, 0), so roll = -atan2(nx, ny).
 */
export function attitudeFromNormal(n: Vec3): { pitchRad: number; rollRad: number } {
  const ny = Math.max(1e-6, n.y);
  return { pitchRad: -Math.atan2(n.z, ny), rollRad: -Math.atan2(n.x, Math.hypot(ny, n.z)) };
}

export class DepthSurfaceEstimator implements SurfaceEstimator {
  private heightM: number;
  private readonly trustPose: boolean;
  private readonly halfSizeM: number;
  private readonly maxTiltRad: number;
  private readonly getTuning: () => SurfaceTuning;
  private readonly legacyInterval: number | undefined;
  private readonly legacyStride: number | undefined;

  private floorEstimated: EstimatedSurface;
  private tables: EstimatedSurface[] = [];
  private walls: EstimatedSurface[] = [];
  private trackedTables: Tracked[] = [];
  private trackedWalls: Tracked[] = [];
  private trackedVolumes: TrackedVolume[] = [];
  private nextTableIndex = 0;
  private nextWallIndex = 0;
  private nextVolumeIndex = 0;

  surfaces: readonly EstimatedSurface[];
  volumes: readonly DetectedVolume[] = [];
  /** Attitude the dominant plane implies for the camera; null until a plane was found. */
  correction: FrameCorrection | null = null;

  private lastProcessedDepthTimestamp: Millis = -Infinity;
  lastRunAt: Millis = -Infinity;
  lastStats: DepthSurfaceStats = { points: 0, floorInliers: 0, tables: 0, walls: 0, volumes: 0, runMs: 0 };
  /** World-space extent of the fitted ground plane's inliers (for the wireframe overlay); null before a fit. */
  groundExtent: Aabb | null = null;
  /** Camera->world transform used for the last run's point cloud (pick.ts must use the same). */
  lastFrame: { rotation: Pose['rotation']; position: Vec3 } | null = null;
  /** Raw plane fits of the last run (before extent filters), for diagnostics/tests. */
  lastFits: { horizontal: PlaneFit[]; vertical: PlaneFit[] } = { horizontal: [], vertical: [] };

  constructor(opts: DepthSurfaceEstimatorOptions) {
    this.heightM = opts.cameraHeightM;
    this.trustPose = opts.trustPose ?? false;
    this.halfSizeM = opts.halfSizeM ?? 6;
    this.maxTiltRad = opts.maxTiltRad ?? (40 * Math.PI) / 180;
    this.legacyInterval = opts.minIntervalMs;
    this.legacyStride = opts.stride;
    this.getTuning = opts.getTuning ?? (() => DEFAULT_SURFACE_TUNING);
    this.floorEstimated = { surface: makeFloorSurface(this.halfSizeM, 0), confidence: 1, origin: 'prior' };
    this.surfaces = [this.floorEstimated];
  }

  get cameraHeightM(): number {
    return this.heightM;
  }

  setHeight(h: number): void {
    this.heightM = h;
  }

  update(depth: DepthMap | undefined, pose: Pose, now: Millis): void {
    if (!depth) return;
    if (depth.confidence < 0.2) return;
    if (!(depth.timestamp > this.lastProcessedDepthTimestamp)) return;
    const tuning = this.getTuning();
    const interval = this.legacyInterval ?? tuning.surfaceIntervalMs;
    if (now - this.lastRunAt < interval) return;

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.lastRunAt = now;
    this.lastProcessedDepthTimestamp = depth.timestamp;
    const stride = this.legacyStride ?? tuning.pointStride;

    // 1. Camera-space cloud and the dominant support plane.
    const localMap: DepthMap = { ...depth, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { ...IDENTITY_QUAT } } };
    const cloud = depthToPointsWithRows(localMap, stride, MAX_POINT_DEPTH_M);
    const points = cloud.points;
    const pointCount = Math.floor(points.length / 3);
    // Plane-filled stereo pixels (the bare desk) vote with their map weight (0.4-0.5) rather than 1.
    const ransacOpts = { thresholdM: tuning.ransacThresholdM, iterations: tuning.ransacIterations, minInliers: Math.max(20, Math.floor(tuning.planeMinInliers / 2)), seed: 7, weights: cloud.weights };
    // Ground = the plane that explains the BOTTOM of the frame (the desk edge under a laptop
    // camera), not the largest plane in view (the bed behind it). Fit first among points from
    // the lowest GROUND_BAND_FRACTION of image rows with a tight threshold; fall back to the
    // largest camera-up-facing plane when that band has too few points.
    const bandMask = new Uint8Array(pointCount);
    let bandPoints = 0;
    const bandTopRow = depth.height * (1 - GROUND_BAND_FRACTION);
    for (let i = 0; i < pointCount; i++) {
      if ((cloud.rows[i] as number) >= bandTopRow) {
        bandMask[i] = 1;
        bandPoints += 1;
      }
    }
    const groundThreshold = Math.min(ransacOpts.thresholdM, GROUND_THRESHOLD_M);
    // Tracked pose: true up in camera space and a tight cone (a band of holes must not yield a 35-degree "ground").
    const upHint: Vec3 = this.trustPose ? quatRotateVec3(quatConjugate(depth.pose.rotation), { x: 0, y: 1, z: 0 }) : { x: 0, y: 1, z: 0 };
    const groundCone = this.trustPose ? TRACKED_GROUND_CONE_RAD : this.maxTiltRad;
    let dominant: PlaneFit | null = null;
    if (bandPoints >= ransacOpts.minInliers) {
      const bandFit = ransacPlane(points, { ...ransacOpts, thresholdM: groundThreshold, normalHint: upHint, maxNormalAngleRad: groundCone, candidateMask: bandMask });
      if (bandFit) {
        // Recount inliers over ALL points so the fit's extent/confidence reflect the whole plane.
        dominant = ransacPlane(points, { ...ransacOpts, thresholdM: groundThreshold, iterations: 1, normalHint: bandFit.normal, maxNormalAngleRad: 0.02, seed: 3 }) ?? bandFit;
        if (Math.abs(dominant.d - bandFit.d) > 0.05) dominant = bandFit;
      }
    }
    if (!dominant) {
      dominant = ransacPlane(points, { ...ransacOpts, thresholdM: groundThreshold, normalHint: upHint, maxNormalAngleRad: groundCone });
    }

    let floorInliers = 0;
    let floorChanged = false;
    let worldRotation = depth.pose.rotation;
    let worldPosition: Vec3 = depth.pose.position;
    let groundY = 0;

    if (dominant && dominant.inlierFraction >= FLOOR_MIN_INLIER_FRACTION && dominant.inliers.length >= tuning.planeMinInliers) {
      floorInliers = dominant.inliers.length;
      const att = attitudeFromNormal(dominant.normal);
      // Distance from the camera (origin in camera space) to the plane n.p + d = 0.
      const heightM = Math.abs(dominant.d);
      const confidence = Math.min(1, dominant.inlierFraction * 3);
      const extentM = Math.max(dominant.extentMax.x - dominant.extentMin.x, dominant.extentMax.z - dominant.extentMin.z, dominant.extentMax.y - dominant.extentMin.y);
      if (this.trustPose) {
        // The pose is measured: the plane is expressed in that frame instead of defining it.
        const c = quatRotateVec3(depth.pose.rotation, dominant.centroid);
        groundY = c.y + depth.pose.position.y;
        this.heightM = depth.pose.position.y - groundY;
      } else {
        // World frame from the dominant plane: pitch/roll from its normal, y = 0 on the plane,
        // yaw from the reported pose (depth cannot observe heading).
        const yaw = this.yawOf(depth.pose);
        worldRotation = quatMultiply(quatFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw), quatMultiply(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, att.pitchRad), quatFromAxisAngle({ x: 0, y: 0, z: 1 }, att.rollRad)));
        worldPosition = { x: depth.pose.position.x, y: heightM, z: depth.pose.position.z };
        this.heightM = heightM;
      }
      this.correction = { pitchRad: att.pitchRad, rollRad: att.rollRad, heightM, confidence, inliers: dominant.inliers.length, rollCorroborated: false, extentM, groundY, at: now };
      if (this.floorEstimated.origin !== 'ransac' || Math.abs(this.floorEstimated.confidence - confidence) > 0.01) {
        floorChanged = true;
        this.floorEstimated = { surface: this.floorEstimated.surface, confidence, origin: 'ransac' };
      }
    }

    // 2. World-space cloud (dominant plane at y = 0 when found, else the reported pose).
    transformPoints(points, worldRotation, worldPosition);
    this.lastFrame = { rotation: worldRotation, position: worldPosition };
    if (dominant) {
      // Inlier extent in world space (points are transformed in place, so read them back).
      const gmin = { x: Infinity, y: Infinity, z: Infinity };
      const gmax = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (const idx of dominant.inliers) {
        const px = points[idx * 3] as number;
        const py = points[idx * 3 + 1] as number;
        const pz = points[idx * 3 + 2] as number;
        if (px < gmin.x) gmin.x = px;
        if (py < gmin.y) gmin.y = py;
        if (pz < gmin.z) gmin.z = pz;
        if (px > gmax.x) gmax.x = px;
        if (py > gmax.y) gmax.y = py;
        if (pz > gmax.z) gmax.z = pz;
      }
      this.groundExtent = Number.isFinite(gmin.x) ? { min: gmin, max: gmax } : null;
    }

    // Best-first extraction (see ransac.ts extractPlanes), then merge layered horizontals. With a
    // tracked pose the horizontals are searched FIRST with the up hint: best-first otherwise lets a
    // tilted fit through desk + wall points eat the desk (real ZED frame: 883 desk inliers lost to a
    // 30-degree plane that was then discarded as neither horizontal nor vertical).
    let hinted: PlaneFit[] = [];
    let extractMask: Uint8Array | undefined;
    if (this.trustPose) {
      hinted = findHorizontalPlanes(points, { ...ransacOpts, maxPlanes: 4, minInliers: tuning.planeMinInliers });
      if (hinted.length > 0) {
        extractMask = new Uint8Array(pointCount).fill(1);
        for (const fit of hinted) for (const idx of fit.inliers) extractMask[idx] = 0;
      }
    }
    const extracted = extractPlanes(points, { ...ransacOpts, maxPlanes: 8, minInliers: tuning.planeMinInliers, candidateMask: extractMask });
    const horizontal = mergeHorizontalPlanes([...hinted, ...extracted.horizontal], Math.max(0.08, 2 * tuning.ransacThresholdM));
    const vertical = extracted.vertical;
    this.lastFits = { horizontal, vertical };

    // Roll check: a sloped duvet biases the dominant plane's normal, so roll is only trusted when
    // a SIDE wall (normal mostly along x) shows the same tilt; otherwise it is clamped to +-5 degrees.
    if (this.correction && this.correction.at === now) {
      const corr = this.correction;
      let corroborated = false;
      for (const fit of vertical) {
        const n = fit.normal;
        if (Math.abs(n.x) < 0.5) continue;
        // Points are already in the corrected frame: a leftover tilt of a side wall's normal is residual roll.
        const residual = Math.atan2(n.y * Math.sign(n.x), Math.abs(n.x));
        if (Math.abs(residual) < (3 * Math.PI) / 180) corroborated = true;
      }
      corr.rollCorroborated = corroborated;
      if (!corroborated) corr.rollRad = Math.max(-ROLL_CLAMP_RAD, Math.min(ROLL_CLAMP_RAD, corr.rollRad));
    }

    // 3. Table surfaces: horizontal planes away from the ground with furniture-sized extent.
    const newTables: EstimatedSurface[] = [];
    const newTrackedTables: Tracked[] = [];
    const tableFits: PlaneFit[] = [];
    for (const fit of horizontal) {
      // trustPose: y = 0 is the floor by construction (the pose source's floor policy), so the ground
      // test is against 0 even when the dominant plane in view is a desk (which is then a table).
      const floorY = this.trustPose ? 0 : groundY;
      if (Math.abs(fit.centroid.y - floorY) < TABLE_MIN_OFFSET_M) continue; // the ground itself
      if (fit.centroid.y - floorY > TABLE_MAX_HEIGHT_M) continue; // ceiling / high shelf
      const ex = fit.extentMax.x - fit.extentMin.x;
      const ez = fit.extentMax.z - fit.extentMin.z;
      const belowCameraM = depth.pose.position.y - fit.centroid.y;
      const trackedTable = this.trustPose && fit.inliers.length >= TRACKED_TABLE_MIN_INLIERS && belowCameraM >= TRACKED_TABLE_MIN_BELOW_M && belowCameraM <= TRACKED_TABLE_MAX_BELOW_M;
      if (!trackedTable && (Math.max(ex, ez) < tuning.planeMinExtentM || Math.min(ex, ez) < tuning.planeMinExtentM / 2)) continue;
      const aabb: Aabb = { min: fit.extentMin, max: fit.extentMax };
      const matched = this.trackedTables.find((t) => Math.abs(t.aabb.min.y - aabb.min.y) <= TABLE_ID_MATCH_HEIGHT_M && aabbIntersects(t.aabb, aabb));
      const id = matched ? matched.id : `camera-plane-${this.nextTableIndex++}`;
      const surface = horizontalSurface(id, 'table', fit, now);
      const prev = this.tables.find((s) => s.surface.id === id);
      if (prev && !aabbChangedBeyond(prev.surface.aabb, surface.aabb, AABB_CHANGE_EPS_M)) surface.lastChanged = prev.surface.lastChanged;
      newTables.push({ surface, confidence: Math.min(1, fit.inlierFraction * 3), origin: 'ransac' });
      newTrackedTables.push({ id, aabb });
      tableFits.push(fit);
    }

    // 4. Wall surfaces.
    const newWalls: EstimatedSurface[] = [];
    const newTrackedWalls: Tracked[] = [];
    for (const fit of vertical) {
      const ex = fit.extentMax.x - fit.extentMin.x;
      const ey = fit.extentMax.y - fit.extentMin.y;
      const ez = fit.extentMax.z - fit.extentMin.z;
      if (Math.max(ex, ez) < tuning.planeMinExtentM || ey < tuning.planeMinExtentM / 2) continue;
      const aabb: Aabb = { min: fit.extentMin, max: fit.extentMax };
      const matched = this.trackedWalls.find((t) => aabbIntersects(t.aabb, aabb));
      const id = matched ? matched.id : `camera-wall-${this.nextWallIndex++}`;
      const surface = wallSurface(id, fit, now);
      const prev = this.walls.find((s) => s.surface.id === id);
      if (prev && !aabbChangedBeyond(prev.surface.aabb, surface.aabb, AABB_CHANGE_EPS_M)) surface.lastChanged = prev.surface.lastChanged;
      newWalls.push({ surface, confidence: Math.min(1, fit.inlierFraction * 3), origin: 'ransac' });
      newTrackedWalls.push({ id, aabb });
    }

    const tablesChanged = this.tables.length !== newTables.length || this.tables.some((s, i) => s.surface !== newTables[i]?.surface || s.surface.lastChanged !== newTables[i]?.surface.lastChanged);
    const wallsChanged = this.walls.length !== newWalls.length || this.walls.some((s, i) => s.surface.lastChanged !== newWalls[i]?.surface.lastChanged || s.surface.id !== newWalls[i]?.surface.id);
    this.tables = newTables;
    this.walls = newWalls;
    this.trackedTables = newTrackedTables;
    this.trackedWalls = newTrackedWalls;
    if (floorChanged || tablesChanged || wallsChanged || this.surfaces.length !== 1 + newTables.length + newWalls.length) {
      this.surfaces = [this.floorEstimated, ...this.tables, ...this.walls];
    }

    // 5. Volumes above the ground and above each table.
    const clusterOpts = { cellM: tuning.clusterCellM, minHeightM: tuning.clusterMinHeightM, maxHeightM: tuning.volumeMaxSideM };
    const raw: { aabb: Aabb; count: number }[] = [];
    const accept = (c: { aabb: Aabb; count: number; lowestY: number; supportY: number }): boolean => {
      const dx = c.aabb.max.x - c.aabb.min.x;
      const dy = c.aabb.max.y - c.aabb.min.y;
      const dz = c.aabb.max.z - c.aabb.min.z;
      if (dx > tuning.volumeMaxSideM || dy > tuning.volumeMaxSideM || dz > tuning.volumeMaxSideM) return false;
      // Must actually stand on its support: a far wardrobe seen only from mid-height upward is not resting on it.
      if (c.lowestY - c.supportY > VOLUME_MAX_SUPPORT_GAP_M) return false;
      if (c.count < tuning.clusterMinCount) return false;
      if (Math.min(dx, dz) < WALL_SLIVER_THIN_M && dy > WALL_SLIVER_TALL_M) return false; // wall fragment
      if (newTables.some((t) => xzOverlapFraction(c.aabb, t.surface.aabb) > VOLUME_TABLE_OVERLAP_FRACTION)) return false; // a table top
      if (newWalls.some((w) => xzOverlapFraction(c.aabb, w.surface.aabb) > 0.8)) return false;
      return true;
    };
    for (const c of clusterAbovePlane(points, 0, clusterOpts)) if (accept(c)) raw.push(c);
    for (const fit of tableFits) {
      const regionAabb: Aabb = {
        min: { x: fit.extentMin.x - TABLE_REGION_PAD_M, y: fit.centroid.y, z: fit.extentMin.z - TABLE_REGION_PAD_M },
        max: { x: fit.extentMax.x + TABLE_REGION_PAD_M, y: fit.centroid.y + tuning.volumeMaxSideM, z: fit.extentMax.z + TABLE_REGION_PAD_M },
      };
      for (const c of clusterAbovePlane(points, fit.centroid.y, { ...clusterOpts, regionAabb })) if (accept(c)) raw.push(c);
    }

    const newVolumes: DetectedVolume[] = [];
    const newTracked: TrackedVolume[] = [];
    for (const rv of raw) {
      const center = aabbCenter(rv.aabb);
      const matched = this.trackedVolumes.find((tv) => distance(tv.center, center) <= VOLUME_MATCH_DIST_M);
      const id = matched ? matched.id : `camera-vol-${this.nextVolumeIndex++}`;
      newVolumes.push({
        id,
        label: 'other',
        pose: { position: center, rotation: IDENTITY_QUAT },
        halfExtents: { x: (rv.aabb.max.x - rv.aabb.min.x) / 2, y: (rv.aabb.max.y - rv.aabb.min.y) / 2, z: (rv.aabb.max.z - rv.aabb.min.z) / 2 },
      });
      newTracked.push({ id, center });
    }
    this.trackedVolumes = newTracked;
    this.volumes = newVolumes;

    this.lastStats = {
      points: pointCount,
      floorInliers,
      tables: newTables.length,
      walls: newWalls.length,
      volumes: newVolumes.length,
      runMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
    };
  }

  private yawOf(pose: Pose): number {
    const f = quatRotateVec3(pose.rotation, { x: 0, y: 0, z: -1 });
    return Math.atan2(-f.x, -f.z);
  }
}
