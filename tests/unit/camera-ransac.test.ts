import { describe, expect, it } from 'vitest';
import { StaticPoseSource } from '@/camera/pose/static';
import { fillFloorDepth } from '@/camera/depth/prior';
import type { DepthMap } from '@/camera/contract';
import {
  clusterAbovePlane,
  depthToPoints,
  findHorizontalPlanes,
  ransacPlane,
} from '@/camera/surfaces/ransac';

// ---------------------------------------------------------------------------
// Deterministic "random" generator for synthetic point clouds (separate from
// ransacPlane's own internal RNG - this one just builds test fixtures).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number, sigma: number): number {
  // Box-Muller.
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

interface SyntheticCloud {
  points: Float32Array;
  floorY: number;
  tableY: number;
  tableCenter: { x: number; z: number };
  tableHalf: { x: number; z: number };
  boxCenter: { x: number; y: number; z: number };
  boxHalf: { x: number; y: number; z: number };
}

function buildSyntheticCloud(seed = 7): SyntheticCloud {
  const rand = mulberry32(seed);
  const pts: number[] = [];

  const floorY = 0;
  const floorHalf = 3;
  const floorCount = 4000;
  for (let i = 0; i < floorCount; i++) {
    const x = (rand() * 2 - 1) * floorHalf;
    const z = (rand() * 2 - 1) * floorHalf;
    const y = floorY + gaussian(rand, 0.01);
    pts.push(x, y, z);
  }

  // Table slab at y=0.75, 0.8 x 0.6 m, centered at (1, -1.5).
  const tableY = 0.75;
  const tableCenter = { x: 1, z: -1.5 };
  const tableHalf = { x: 0.4, z: 0.3 };
  const tableCount = 800;
  for (let i = 0; i < tableCount; i++) {
    const x = tableCenter.x + (rand() * 2 - 1) * tableHalf.x;
    const z = tableCenter.z + (rand() * 2 - 1) * tableHalf.z;
    const y = tableY + gaussian(rand, 0.01);
    pts.push(x, y, z);
  }

  // Box 0.3 x 0.3 x 0.3 on the floor, centered at (-0.8, 0.15, 0.5) - top face sampled.
  const boxCenter = { x: -0.8, y: 0.15, z: 0.5 };
  const boxHalf = { x: 0.15, y: 0.15, z: 0.15 };
  const boxCount = 400;
  for (let i = 0; i < boxCount; i++) {
    const x = boxCenter.x + (rand() * 2 - 1) * boxHalf.x;
    const z = boxCenter.z + (rand() * 2 - 1) * boxHalf.z;
    const y = boxCenter.y + boxHalf.y + gaussian(rand, 0.005);
    pts.push(x, y, z);
  }

  const totalReal = floorCount + tableCount + boxCount;
  const outlierCount = Math.round(totalReal * 0.05);
  for (let i = 0; i < outlierCount; i++) {
    const x = (rand() * 2 - 1) * 4;
    const z = (rand() * 2 - 1) * 4;
    const y = rand() * 2 - 0.2;
    pts.push(x, y, z);
  }

  return {
    points: Float32Array.from(pts),
    floorY,
    tableY,
    tableCenter,
    tableHalf,
    boxCenter,
    boxHalf,
  };
}

describe('ransacPlane', () => {
  it('finds the floor plane with a +Y normal hint despite table, box, and outliers', () => {
    const cloud = buildSyntheticCloud();
    const fit = ransacPlane(cloud.points, {
      normalHint: { x: 0, y: 1, z: 0 },
      maxNormalAngleRad: (15 * Math.PI) / 180,
      thresholdM: 0.03,
      minInliers: 50,
      seed: 42,
    });

    expect(fit).not.toBeNull();
    expect(Math.abs(fit!.d)).toBeLessThan(0.02);
    expect(fit!.normal.y).toBeGreaterThan(0.99);
  });
});

describe('findHorizontalPlanes', () => {
  it('finds the floor and the table plane at the right heights', () => {
    const cloud = buildSyntheticCloud();
    const fits = findHorizontalPlanes(cloud.points, { maxPlanes: 3, seed: 3 });

    expect(fits.length).toBeGreaterThanOrEqual(2);
    // Sorted lowest first.
    expect(fits[0]!.centroid.y).toBeLessThan(fits[1]!.centroid.y);
    expect(Math.abs(fits[0]!.centroid.y - cloud.floorY)).toBeLessThan(0.03);

    const tableFit = fits.find((f) => Math.abs(f.centroid.y - cloud.tableY) < 0.05);
    expect(tableFit).toBeDefined();
  });
});

describe('clusterAbovePlane', () => {
  it('finds the box cluster with an aabb close to the true box extents', () => {
    const cloud = buildSyntheticCloud();
    const clusters = clusterAbovePlane(cloud.points, cloud.floorY, {
      minHeightM: 0.04,
      maxHeightM: 1.0,
    });

    expect(clusters.length).toBeGreaterThan(0);

    const trueMin = {
      x: cloud.boxCenter.x - cloud.boxHalf.x,
      z: cloud.boxCenter.z - cloud.boxHalf.z,
    };
    const trueMax = {
      x: cloud.boxCenter.x + cloud.boxHalf.x,
      z: cloud.boxCenter.z + cloud.boxHalf.z,
    };

    const boxCluster = clusters.find(
      (c) =>
        Math.abs(c.aabb.min.x - trueMin.x) < 0.05 &&
        Math.abs(c.aabb.max.x - trueMax.x) < 0.05 &&
        Math.abs(c.aabb.min.z - trueMin.z) < 0.05 &&
        Math.abs(c.aabb.max.z - trueMax.z) < 0.05,
    );
    expect(boxCluster).toBeDefined();
    expect(boxCluster!.aabb.min.y).toBeCloseTo(cloud.floorY, 6);

    // The table slab is also a cluster above the floor.
    const tableCluster = clusters.find(
      (c) =>
        Math.abs(c.aabb.max.y - c.aabb.min.y - 0) >= 0 &&
        c.aabb.min.x > cloud.tableCenter.x - cloud.tableHalf.x - 0.1 &&
        c.aabb.max.x < cloud.tableCenter.x + cloud.tableHalf.x + 0.1,
    );
    expect(tableCluster).toBeDefined();
  });
});

describe('depthToPoints', () => {
  it('round-trips a floor-only depth map: every returned point has |y| < 1e-4', () => {
    const pose = new StaticPoseSource({ cameraHeightM: 1.1, pitchRad: -0.35 }).pose;
    const width = 64;
    const height = 48;
    const fovY = Math.PI / 4;
    const aspect = width / height;

    const metric = new Float32Array(width * height);
    fillFloorDepth(metric, width, height, pose, fovY, aspect, 0);

    const depth: DepthMap = {
      width,
      height,
      metric,
      confidence: 1,
      source: 'plane-prior',
      pose,
      fovY,
      aspect,
      timestamp: 0,
    };

    const points = depthToPoints(depth, 2);
    const count = Math.floor(points.length / 3);
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const y = points[i * 3 + 1] as number;
      expect(Math.abs(y)).toBeLessThan(1e-4);
    }
  });
});
