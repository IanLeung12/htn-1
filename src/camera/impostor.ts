/**
 * Camera-facing impostor for a moved, single-view (tier D) real object.
 *
 * A discovered real object with only one live RGB-D frame (no multi-view
 * capture yet, see docs/general-camera/STATE.md) has a depth mesh with no
 * side surfaces: viewed off-axis from where it moved to, it collapses to a
 * "thin white sliver". Until multi-frame capture exists (see
 * `src/render/objects.ts`'s per-object appearance depth meshes, which have
 * the same limitation), we instead cut the object's pixels out of its
 * appearance frame using its own depth blob and paint them on a billboard
 * quad that always faces the camera (yaw only), at the moved pose. A
 * translucent box outline is left at the original pose so it reads as
 * "moved from here" rather than a floating photo.
 *
 * Pure cutout math (`cutoutFromFrame`) is unit-testable without three.js;
 * `ImpostorViews` is the per-frame three.js side, mirroring the shape of
 * `src/render/objects.ts`'s `ObjectViews`.
 */
import * as THREE from 'three';
import type { CameraFrame } from '@/capture/contract';
import type { FrameStore } from '@/capture/frame-store';
import { appearanceFrameKey } from '@/capture/frame-store';
import type { EditableObject, SceneSnapshot, Vec3 } from '@/core/types';
import { add, quatRotateVec3, sub } from '@/core/math';
import { projectPoint, sampleDepthNearest } from '@/capture/geom';
import type { SilhouetteMask } from './edit/silhouette';
import { cutoutFromMask } from './edit/mask-cutout';

const EPS_POS = 0.005;
const EPS_ROT = 0.001;

const DEFAULT_PAD_PX = 2;
const DEFAULT_DEPTH_SLACK_M = 0.12;
/** Minimum fraction of the padded bbox that must be kept for the cutout to be usable. */
const MIN_COVERAGE = 0.05;

export interface CutoutResult {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** World-space size of the cutout on the object's mid-depth plane. */
  widthM: number;
  heightM: number;
  /** World centre of the cutout at the object's mid depth. */
  center: Vec3;
  /** Fraction of bbox pixels kept. */
  coverage: number;
}

export interface CutoutOptions {
  /** Pixels of padding added around the projected occlusion-box bbox. Default 2. */
  padPx?: number;
  /** Extra depth tolerance (m) beyond the box corners' depth range. Default 0.12. */
  depthSlackM?: number;
}

function halfExtentsForProxy(shape: EditableObject['occlusionProxy']): Vec3 {
  switch (shape.kind) {
    case 'box':
      return shape.halfExtents;
    case 'sphere':
      return { x: shape.radius, y: shape.radius, z: shape.radius };
    case 'capsule':
      return { x: shape.radius, y: shape.halfHeight + shape.radius, z: shape.radius };
  }
}

function boxCorners(halfExtents: Vec3): Vec3[] {
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push({ x: sx * halfExtents.x, y: sy * halfExtents.y, z: sz * halfExtents.z });
      }
    }
  }
  return corners;
}

/**
 * Project the object's occlusion box (at `originalPose`) into `frame`,
 * cut out the pixels whose sampled depth agrees with the box, and return a
 * standalone RGBA cutout plus its world footprint at mid-depth. Returns
 * null when the box doesn't project usefully into the frame (behind camera,
 * degenerate bbox, or too little of it survives the depth filter).
 */
export function cutoutFromFrame(frame: CameraFrame, obj: EditableObject, opts?: CutoutOptions): CutoutResult | null {
  const padPx = opts?.padPx ?? DEFAULT_PAD_PX;
  const depthSlackM = opts?.depthSlackM ?? DEFAULT_DEPTH_SLACK_M;

  const halfExtents = halfExtentsForProxy(obj.occlusionProxy);

  const corners = boxCorners(halfExtents).map((c) => add(obj.originalPose.position, c));
  // originalPose rotation is applied around the local box centre too, but the
  // occlusion box is axis-aligned in the object's local frame and small
  // rotations don't change which pixels/depths are relevant here; project
  // corners in world space directly (matches how projectPoint/inFrame treat
  // any world point).

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let anyInFront = false;

  for (const corner of corners) {
    const p = projectPoint(corner, frame.pose, frame.fovY, frame.aspect, frame.width, frame.height);
    if (!p) continue;
    anyInFront = true;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.depth < minDepth) minDepth = p.depth;
    if (p.depth > maxDepth) maxDepth = p.depth;
  }

  if (!anyInFront) return null;

  const x0 = Math.max(0, Math.floor(minX - padPx));
  const x1 = Math.min(frame.width, Math.ceil(maxX + padPx));
  const y0 = Math.max(0, Math.floor(minY - padPx));
  const y1 = Math.min(frame.height, Math.ceil(maxY + padPx));

  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 1 || height < 1) return null;

  const depthLo = minDepth - depthSlackM;
  const depthHi = maxDepth + depthSlackM;
  const midDepth = (minDepth + maxDepth) / 2;

  const rgba = new Uint8ClampedArray(width * height * 4);
  const keepMask = new Uint8Array(width * height);
  let kept = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx = x0 + x;
      const fy = y0 + y;
      let keep = true;
      if (frame.depth) {
        const d = sampleDepthNearest(frame.depth, frame.width, frame.height, fx, fy);
        keep = d !== undefined && d > 0 && d >= depthLo && d <= depthHi;
      }
      if (keep) {
        keepMask[y * width + x] = 1;
        kept += 1;
      }
    }
  }

  // Erode 1px: drop kept pixels with any non-kept 4-neighbour (or frame edge
  // neighbour, treated as non-kept) to avoid a halo of background bleeding
  // into the cutout at the depth boundary.
  const eroded = new Uint8Array(width * height);
  let erodedKept = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!keepMask[i]) continue;
      const up = y > 0 ? keepMask[i - width] : 0;
      const down = y < height - 1 ? keepMask[i + width] : 0;
      const left = x > 0 ? keepMask[i - 1] : 0;
      const right = x < width - 1 ? keepMask[i + 1] : 0;
      if (up && down && left && right) {
        eroded[i] = 1;
        erodedKept += 1;
      }
    }
  }

  const totalPx = width * height;
  const coverage = totalPx > 0 ? erodedKept / totalPx : 0;
  if (coverage < MIN_COVERAGE) return null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const fx = x0 + x;
      const fy = y0 + y;
      const srcIdx = (fy * frame.width + fx) * 4;
      const dstIdx = i * 4;
      if (eroded[i]) {
        rgba[dstIdx] = frame.rgba[srcIdx] ?? 0;
        rgba[dstIdx + 1] = frame.rgba[srcIdx + 1] ?? 0;
        rgba[dstIdx + 2] = frame.rgba[srcIdx + 2] ?? 0;
        rgba[dstIdx + 3] = 255;
      } else {
        rgba[dstIdx] = 0;
        rgba[dstIdx + 1] = 0;
        rgba[dstIdx + 2] = 0;
        rgba[dstIdx + 3] = 0;
      }
    }
  }

  const tanHalfFovY = Math.tan(frame.fovY / 2);
  const worldPerPixelY = (2 * midDepth * tanHalfFovY) / frame.height;
  const worldPerPixelX = (2 * midDepth * tanHalfFovY * frame.aspect) / frame.width;
  // Metric size uses the object's own (unpadded) projected footprint, not
  // the padded/clamped raster rectangle - padding exists to avoid clipping
  // the cutout's edge pixels, not to inflate the reported physical size.
  const widthM = (maxX - minX) * worldPerPixelX;
  const heightM = (maxY - minY) * worldPerPixelY;

  // World centre of the bbox at mid depth: unproject the bbox's centre pixel
  // at midDepth using the same pinhole model projectPoint uses.
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const ndcX = (2 * cx) / frame.width - 1;
  const ndcY = 1 - (2 * cy) / frame.height;
  const localX = ndcX * midDepth * tanHalfFovY * frame.aspect;
  const localY = ndcY * midDepth * tanHalfFovY;
  const localZ = -midDepth;
  // Rotate local offset by the frame camera's rotation and add its position.
  const worldOffset = quatRotateVec3(frame.pose.rotation, { x: localX, y: localY, z: localZ });
  const center = add(frame.pose.position, worldOffset);

  return { width, height, rgba, widthM, heightM, center, coverage };
}

function posesDiffer(a: EditableObject['originalPose'], b: EditableObject['currentPose']): boolean {
  const dp = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
  const dr =
    Math.abs(a.rotation.x - b.rotation.x) +
    Math.abs(a.rotation.y - b.rotation.y) +
    Math.abs(a.rotation.z - b.rotation.z) +
    Math.abs(a.rotation.w - b.rotation.w);
  return dp > EPS_POS || dr > EPS_ROT;
}

interface ImpostorEntry {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  texture: THREE.DataTexture;
  outline: THREE.LineSegments;
  /** Frame the current cutout was built from, so we rebuild if the appearance frame changes. */
  builtFromFrame: CameraFrame | undefined;
  /** Offset from originalPose.position to the cutout's world centre, cached with the cutout. */
  centerOffset: Vec3;
  active: boolean;
}

/**
 * Renders a billboard "photo cutout" impostor for each moved, tier-D-style
 * physical object (baked visual, single appearance frame), plus a faint
 * outline at its original pose. See module doc comment for why.
 */
/** Supplies the tracked silhouette mask for an object, in its depth grid's `gridW x gridH` pixels (see `SilhouetteTracker.peek`). */
export type MaskSource = (objectId: string) => { mask: SilhouetteMask; gridW: number; gridH: number } | undefined;

export class ImpostorViews {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, ImpostorEntry>();
  private maskSource: MaskSource | undefined;

  constructor(private readonly frameStore: FrameStore) {}

  /**
   * Wires a per-object tracked silhouette mask (`./edit/silhouette.ts`) so
   * the impostor cutout follows the object's actual shape rather than its
   * occlusion box. Optional: without it, `cutoutFromFrame`'s box+depth
   * cutout is used as before.
   */
  setMaskSource(source: MaskSource | undefined): void {
    this.maskSource = source;
  }

  update(snapshot: SceneSnapshot, camera: THREE.Camera, now: number): void {
    void now;
    const seen = new Set<string>();

    for (const obj of Object.values(snapshot.objects)) {
      if (obj.origin !== 'physical' || !obj.visible || obj.visual.kind !== 'baked') continue;
      if (!posesDiffer(obj.originalPose, obj.currentPose)) continue;

      const frames = this.frameStore.get(appearanceFrameKey(obj.id));
      const frame = frames && frames.length > 0 ? frames[frames.length - 1] : undefined;
      if (!frame) continue;

      seen.add(obj.id);
      let entry = this.entries.get(obj.id);
      if (!entry) {
        entry = this.buildEntry();
        this.entries.set(obj.id, entry);
        this.group.add(entry.mesh);
        this.group.add(entry.outline);
        const halfExtents = halfExtentsForProxy(obj.occlusionProxy);
        entry.outline.geometry.dispose();
        entry.outline.geometry = new THREE.EdgesGeometry(
          new THREE.BoxGeometry(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2),
        );
      }

      if (entry.builtFromFrame !== frame) {
        const tracked = this.maskSource?.(obj.id);
        const cutout = tracked ? cutoutFromMask(frame, obj, tracked.mask, tracked.gridW, tracked.gridH) : cutoutFromFrame(frame, obj);
        if (!cutout) {
          entry.active = false;
          entry.mesh.visible = false;
          entry.outline.visible = false;
          entry.builtFromFrame = frame;
          continue;
        }
        this.applyCutout(entry, cutout);
        entry.builtFromFrame = frame;
        entry.centerOffset = sub(cutout.center, obj.originalPose.position);
      }

      if (!entry.active) {
        entry.mesh.visible = false;
        entry.outline.visible = false;
        continue;
      }

      const pos = add(obj.currentPose.position, entry.centerOffset);
      entry.mesh.position.set(pos.x, pos.y, pos.z);
      const camPos = camera.position;
      const yaw = Math.atan2(camPos.x - pos.x, camPos.z - pos.z);
      entry.mesh.rotation.set(0, yaw, 0);
      entry.mesh.visible = true;

      entry.outline.position.set(
        obj.originalPose.position.x,
        obj.originalPose.position.y,
        obj.originalPose.position.z,
      );
      entry.outline.quaternion.set(
        obj.originalPose.rotation.x,
        obj.originalPose.rotation.y,
        obj.originalPose.rotation.z,
        obj.originalPose.rotation.w,
      );
      entry.outline.visible = true;
    }

    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      entry.mesh.visible = false;
      entry.outline.visible = false;
    }
  }

  /** True when a visible impostor mesh currently exists for `objectId`. */
  isActive(objectId: string): boolean {
    const entry = this.entries.get(objectId);
    return !!entry && entry.active && entry.mesh.visible;
  }

  /**
   * Forces this frame's impostor for `objectId` invisible (its own outline stays, since
   * "moved from here" is still true) - used when the camera has moved too far from where the
   * appearance frames were captured (see `edit/appearance.ts`'s `cameraMovedFromAppearance`):
   * a flat single-viewpoint billboard reads as a photo from any other angle, so the caller
   * falls back to the depth-mesh appearance path (src/render/objects.ts) instead.
   */
  forceHide(objectId: string): void {
    const entry = this.entries.get(objectId);
    if (entry) entry.mesh.visible = false;
  }

  private buildEntry(): ImpostorEntry {
    const texture = new THREE.DataTexture(new Uint8ClampedArray(4), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    // rgba rows are top-row-first (see capture/contract.ts); PlaneGeometry's
    // default UVs put v=0 at the plane's -Y edge (bottom) and v=1 at +Y
    // (top), so with flipY=false texel row 0 (the frame's TOP row) would
    // sample at v=0, i.e. the plane's bottom - upside down. flipY=true makes
    // three.js invert the sampled row (v=0 -> last row) so the frame's top
    // row ends up at the plane's top.
    texture.flipY = true;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      depthWrite: true,
      // See the matching comment in edit/eraser.ts: a camera-facing overlay
      // drawn after the live-depth occluder (renderOrder 2 vs -1) that
      // stands at the real object's own depth, which the occluder's
      // biased-back depth (or plain estimator noise) could otherwise hide.
      depthTest: false,
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    mesh.visible = false;

    const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const outlineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
    });
    const outline = new THREE.LineSegments(outlineGeo, outlineMat);
    outline.renderOrder = 3;
    outline.visible = false;

    return {
      mesh,
      material,
      texture,
      outline,
      builtFromFrame: undefined,
      centerOffset: { x: 0, y: 0, z: 0 },
      active: false,
    };
  }

  /** Rebuilds an entry's geometry/texture/outline scale from a fresh cutout. */
  private applyCutout(entry: ImpostorEntry, cutout: CutoutResult): void {
    entry.texture.dispose();
    const texture = new THREE.DataTexture(cutout.rgba, cutout.width, cutout.height, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    entry.texture = texture;
    entry.material.map = texture;
    entry.material.needsUpdate = true;

    entry.mesh.geometry.dispose();
    entry.mesh.geometry = new THREE.PlaneGeometry(cutout.widthM, cutout.heightM);

    entry.active = true;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.mesh.geometry.dispose();
      entry.material.dispose();
      entry.texture.dispose();
      entry.outline.geometry.dispose();
      (entry.outline.material as THREE.Material).dispose();
      this.group.remove(entry.mesh);
      this.group.remove(entry.outline);
    }
    this.entries.clear();
  }
}

/** True when `views` currently shows a visible impostor mesh for `objectId`. */
export function isImpostorActive(views: ImpostorViews, objectId: string): boolean {
  return views.isActive(objectId);
}
