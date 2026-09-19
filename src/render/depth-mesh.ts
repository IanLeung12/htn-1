/**
 * Textured depth mesh for a captured clean-plate frame: a grid of
 * `frame.width x frame.height` vertices (subsampled to cap vertex count),
 * each unprojected from its pixel + per-pixel depth into WORLD space (see
 * `capture/geom.ts`'s `unprojectPixel`, the exact inverse of `projectPoint`/
 * `frameViewProjection`). Rendering this mesh instead of a flat proxy box
 * reproduces the real depth of whatever is physically behind a deleted/moved
 * object, so it looks correct (no parallax error) from any head position
 * inside the plate's verified envelope - not just from directly above.
 *
 * Triangles that span a depth discontinuity are dropped so foreground and
 * background surfaces (e.g. a couch in front of a wall) never get smeared
 * into a single slanted quad.
 *
 * Built once per frame instance and cached (frames are immutable once
 * captured, same convention as `projective.ts`'s texture cache) - no
 * per-frame(rendered)/per-call allocation.
 */
import * as THREE from 'three';
import type { CameraFrame } from '@/capture/contract';
import { unprojectPixel } from '@/capture/geom';

/** Neighbouring pixels whose depth differs by more than this (metres) are not bridged by a triangle. */
const DEPTH_DISCONTINUITY_M = 0.15;

/** Vertex grids stay near this even when a frame's raw pixel count is much larger. */
const MAX_VERTICES = 64_000;

const geometryCache = new WeakMap<CameraFrame, THREE.BufferGeometry | null>();

/** Subsample step for one axis so a `width x height` frame stays under `MAX_VERTICES` vertices. */
function stepFor(width: number, height: number): number {
  let step = width > 200 ? 2 : 1;
  while (Math.ceil(width / step) * Math.ceil(height / step) > MAX_VERTICES) {
    step += 1;
  }
  return step;
}

/**
 * Lazily build (and cache) a textured `BufferGeometry` unprojecting `frame`'s
 * depth buffer into world space. Returns null when the frame has no depth
 * (caller should fall back to the flat proxy-box projection) or the grid
 * would be degenerate.
 */
export function getDepthMeshGeometry(frame: CameraFrame): THREE.BufferGeometry | null {
  if (geometryCache.has(frame)) return geometryCache.get(frame)!;
  const geometry = frame.depth ? buildDepthMeshGeometry(frame, frame.depth) : null;
  geometryCache.set(frame, geometry);
  return geometry;
}

function buildDepthMeshGeometry(frame: CameraFrame, depthBuffer: Float32Array): THREE.BufferGeometry | null {
  const { width, height, pose, fovY, aspect } = frame;
  const step = stepFor(width, height);
  const gw = Math.floor((width - 1) / step) + 1;
  const gh = Math.floor((height - 1) / step) + 1;
  if (gw < 2 || gh < 2) return null;

  const count = gw * gh;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const depths = new Float32Array(count);
  const valid = new Uint8Array(count);

  for (let gy = 0; gy < gh; gy++) {
    const py = Math.min(gy * step, height - 1);
    for (let gx = 0; gx < gw; gx++) {
      const px = Math.min(gx * step, width - 1);
      const i = gy * gw + gx;
      const d = depthBuffer[py * width + px];
      uvs[i * 2] = (px + 0.5) / width;
      uvs[i * 2 + 1] = (py + 0.5) / height;
      if (d === undefined || !Number.isFinite(d) || d <= 0) {
        valid[i] = 0;
        continue;
      }
      valid[i] = 1;
      depths[i] = d;
      const world = unprojectPixel(px + 0.5, py + 0.5, d, pose, fovY, aspect, width, height);
      positions[i * 3] = world.x;
      positions[i * 3 + 1] = world.y;
      positions[i * 3 + 2] = world.z;
    }
  }

  const indices: number[] = [];
  const pushTriIfFlat = (a: number, b: number, c: number): void => {
    if (!valid[a] || !valid[b] || !valid[c]) return;
    const da = depths[a]!;
    const db = depths[b]!;
    const dc = depths[c]!;
    const spread = Math.max(da, db, dc) - Math.min(da, db, dc);
    if (spread > DEPTH_DISCONTINUITY_M) return;
    indices.push(a, b, c);
  };

  for (let gy = 0; gy < gh - 1; gy++) {
    for (let gx = 0; gx < gw - 1; gx++) {
      const i00 = gy * gw + gx;
      const i10 = gy * gw + (gx + 1);
      const i01 = (gy + 1) * gw + gx;
      const i11 = (gy + 1) * gw + (gx + 1);
      // Two triangles per quad; winding matches a top-first row order viewed
      // from in front of the camera (consistent with other quads in the
      // codebase, e.g. plates.ts's floor quad), which does not matter for an
      // unlit double-sided-agnostic material but keeps backface culling sane
      // if ever enabled.
      pushTriIfFlat(i00, i11, i10);
      pushTriIfFlat(i00, i01, i11);
    }
  }

  if (indices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
