/**
 * Static-camera fast path for hiding a physical object (general-camera
 * backend). `BackgroundHull` (src/render/background-hull.ts) reprojects the
 * clean-plate frames as a parallax-correct 3D depth mesh so it stays correct
 * from any head position - necessary on a moving camera, but needless work
 * when the camera hasn't moved: with a STATIC camera, "what's behind the
 * object" is exactly the clean-plate frame's own pixels, at the exact same
 * screen position the object's silhouette occupies. `StaticCameraEraser`
 * exploits that: a camera-facing quad, cut out by the object's tracked
 * silhouette mask (`./silhouette.ts`) and textured directly from the
 * clean-plate frame via `./mask-cutout.ts` - no depth-mesh reprojection,
 * exact per-pixel match. It is a WORLD-SPACE quad added to the main scene
 * (same pattern as `../impostor.ts`'s `ImpostorViews`), not a hand-rolled
 * screen-space overlay: the ordinary perspective camera (whose fov/aspect
 * the app keeps in sync with the video's `object-fit: cover` crop, see
 * `src/camera/app.ts`) then places it exactly where it renders, the same
 * way it places every other object - a separate NDC projection would have
 * to reproduce that crop math and drift out of sync with it.
 *
 * Used only while camera motion is below ~1 px (see `CameraAppOptions`'
 * wiring in src/camera/app.ts, which measures it); `BackgroundHull` remains
 * the fallback for everything else (camera moved, no plate frame yet, no
 * tracked mask yet).
 *
 * SYNTHETIC path (docs/general-camera/STATE.md "Synthetic delete"): when an
 * object has a tracked mask but NO clean-plate frame (the user never took it
 * off the desk), and `synthetic()` allows it, the plate frame is fabricated
 * by `./inpaint.ts` from the newest APPEARANCE frame (the last frame stored
 * under `appearanceFrameKey(id)` while the object still sat at its original
 * spot - not the live frame, which may already show it moved, or a hand)
 * and composited exactly like a real plate. Cached per (frame timestamp,
 * mask bbox); `isSynthetic(id)` reports which path an object is on.
 */
import * as THREE from 'three';
import { appearanceFrameKey, type FrameStore } from '@/capture/frame-store';
import type { CameraFrame } from '@/capture/contract';
import { inpaintMask } from './inpaint';
import type { EditableObject, SceneSnapshot } from '@/core/types';
import type { SilhouetteMask } from './silhouette';
import { cutoutFromMask } from './mask-cutout';

/** Below this camera motion (px, same metric the caller's optical-flow/pose delta uses), the fast path is used. */
export const STATIC_CAMERA_MOTION_PX = 1;

function shouldHide(obj: EditableObject): boolean {
  if (obj.origin !== 'physical') return false;
  if (!obj.visible) return true;
  const a = obj.originalPose.position;
  const b = obj.currentPose.position;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0.005;
}

interface EraserEntry {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  texture: THREE.DataTexture;
  builtKey: string | undefined;
  active: boolean;
  synthetic: boolean;
  /** Inpainted plate frame, keyed by (source frame timestamp, mask bbox). */
  syntheticKey: string | undefined;
  syntheticFrame: CameraFrame | undefined;
}

export interface StaticCameraEraserOptions {
  /**
   * Whether an object WITHOUT a clean-plate frame may be composited from an
   * inpainted appearance frame (`./inpaint.ts`). Default: never (real plates
   * only). The camera app wires this to tuning `syntheticDelete`.
   */
  synthetic?: () => boolean;
  /** Ring width (px, in the appearance frame) the inpaint copies from. Default 6. */
  inpaintRingPx?: number;
}

/**
 * Renders, for each hidden/moved physical object whose tracked silhouette
 * mask and a clean-plate frame both exist, a camera-facing world-space quad
 * that composites the plate frame's own pixels exactly where the object's
 * silhouette is.
 */
export class StaticCameraEraser {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, EraserEntry>();
  private activeIds = new Set<string>();
  private syntheticIds = new Set<string>();

  constructor(private readonly frameStore: FrameStore, private readonly options: StaticCameraEraserOptions = {}) {}

  /**
   * `masks` maps objectId -> its tracked silhouette mask (in the depth
   * frame's pixel grid, `depthGridWidth x depthGridHeight`). `motionPx` is
   * the caller's current camera-motion estimate; above
   * `STATIC_CAMERA_MOTION_PX` every entry is hidden (falls back to the 3D
   * hull). Returns the number of objects actively composited this frame.
   */
  update(
    snapshot: SceneSnapshot,
    masks: ReadonlyMap<string, SilhouetteMask>,
    motionPx: number,
    depthGridWidth: number,
    depthGridHeight: number,
    camera: THREE.Camera,
  ): number {
    this.activeIds = new Set();
    this.syntheticIds = new Set();
    if (!(motionPx < STATIC_CAMERA_MOTION_PX) || depthGridWidth <= 0 || depthGridHeight <= 0) {
      for (const entry of this.entries.values()) entry.mesh.visible = false;
      return 0;
    }

    for (const obj of Object.values(snapshot.objects)) {
      if (!shouldHide(obj)) continue;
      const mask = masks.get(obj.id);
      if (!mask) continue;
      const frames = this.frameStore.get(obj.id);
      let plateFrame = frames && frames.length > 0 ? frames[0] : undefined;
      let synthetic = false;
      let entry = this.entries.get(obj.id);
      if (!plateFrame && this.options.synthetic?.()) {
        // No clean plate: fabricate one from the newest frame that still shows the object
        // at its original spot (appearance frames are appended oldest-first).
        const appearance = this.frameStore.get(appearanceFrameKey(obj.id));
        const source = appearance && appearance.length > 0 ? appearance[appearance.length - 1] : undefined;
        if (source) {
          if (!entry) {
            entry = this.buildEntry();
            this.entries.set(obj.id, entry);
            this.group.add(entry.mesh);
          }
          const synthKey = `${source.timestamp}:${mask.x0}:${mask.y0}:${mask.width}:${mask.height}`;
          if (entry.syntheticKey !== synthKey || !entry.syntheticFrame) {
            entry.syntheticFrame = inpaintMask(source, mask, this.options.inpaintRingPx ?? 6, { width: depthGridWidth, height: depthGridHeight });
            entry.syntheticKey = synthKey;
          }
          plateFrame = entry.syntheticFrame;
          synthetic = true;
        }
      }
      if (!plateFrame) continue;

      const key = `${synthetic ? 'synthetic' : 'plate'}:${plateFrame.timestamp}:${mask.x0}:${mask.y0}:${mask.width}:${mask.height}`;
      if (!entry) {
        entry = this.buildEntry();
        this.entries.set(obj.id, entry);
        this.group.add(entry.mesh);
      }
      entry.synthetic = synthetic;

      if (entry.builtKey !== key) {
        const cutout = cutoutFromMask(plateFrame, obj, mask, depthGridWidth, depthGridHeight);
        entry.builtKey = key;
        if (!cutout) {
          entry.active = false;
          entry.mesh.visible = false;
          continue;
        }
        this.applyCutout(entry, cutout);
      }
      if (!entry.active) continue;

      // Camera-facing (yaw-only) billboard, same convention as the impostor: a static
      // camera's plate frame is a rectified view from exactly this pose, so orienting
      // toward wherever "camera" currently is keeps it aligned (identical to the capture
      // pose when the camera truly hasn't moved, which is the only time this path runs).
      const camPos = camera.position;
      const yaw = Math.atan2(camPos.x - entry.mesh.position.x, camPos.z - entry.mesh.position.z);
      entry.mesh.rotation.set(0, yaw, 0);
      entry.mesh.visible = true;
      this.activeIds.add(obj.id);
      if (synthetic) this.syntheticIds.add(obj.id);
    }

    for (const [id, entry] of this.entries) {
      if (!this.activeIds.has(id)) entry.mesh.visible = false;
    }
    return this.activeIds.size;
  }

  /** True when a visible composited quad exists for `objectId` this frame. */
  isActive(objectId: string): boolean {
    return this.activeIds.has(objectId);
  }

  /** True when `objectId`'s composited quad this frame is an inpainted (synthetic) fill, not a clean plate. */
  isSynthetic(objectId: string): boolean {
    return this.syntheticIds.has(objectId);
  }

  /** Number of objects currently composited via the fast path. */
  get activeCount(): number {
    return this.activeIds.size;
  }

  /** Number of those composited from an inpainted appearance frame rather than a clean plate. */
  /** Diagnostics: per active entry, the texture size, mean colour/alpha and whether it is synthetic. */
  debugEntries(): { id: string; synthetic: boolean; key: string | undefined; tex: number[]; mean: number[]; pos: number[]; size: number[] }[] {
    const out: { id: string; synthetic: boolean; key: string | undefined; tex: number[]; mean: number[]; pos: number[]; size: number[] }[] = [];
    for (const [id, e] of this.entries) {
      if (!e.active) continue;
      const img = e.texture.image as { data: Uint8ClampedArray; width: number; height: number };
      const data = img.data;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
        a += data[i + 3]!;
      }
      const geom = e.mesh.geometry as THREE.PlaneGeometry;
      const p = geom.parameters;
      out.push({ id, synthetic: e.synthetic, key: e.builtKey ?? e.syntheticKey, tex: [img.width, img.height], mean: [r / n, g / n, b / n, a / n].map((v) => Math.round(v)), pos: [e.mesh.position.x, e.mesh.position.y, e.mesh.position.z].map((v) => +v.toFixed(3)), size: [p.width, p.height].map((v) => +v.toFixed(3)) });
    }
    return out;
  }

  get syntheticCount(): number {
    return this.syntheticIds.size;
  }

  private buildEntry(): EraserEntry {
    const texture = new THREE.DataTexture(new Uint8ClampedArray(4), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
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
      // The live-depth occlusion quad (src/camera/depth-occluder.ts) draws
      // first and writes the REAL scene's depth pushed back a couple of
      // centimetres (occluderBiasM) so things resting AT that depth win
      // reliably; this patch instead sits exactly at the erased object's own
      // real depth (it composites the clean-plate frame's own pixels there),
      // which estimator noise could put on the wrong side of that bias. It's
      // a camera-facing overlay drawn after the occluder (renderOrder 2 vs
      // -1), so skip the depth test rather than risk being hidden by the
      // very surface it's meant to replace.
      depthTest: false,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.renderOrder = 2;
    mesh.visible = false;

    return { mesh, material, texture, builtKey: undefined, active: false, synthetic: false, syntheticKey: undefined, syntheticFrame: undefined };
  }

  private applyCutout(entry: EraserEntry, cutout: { width: number; height: number; rgba: Uint8ClampedArray; widthM: number; heightM: number; center: { x: number; y: number; z: number } }): void {
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
    entry.mesh.position.set(cutout.center.x, cutout.center.y, cutout.center.z);
    entry.active = true;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.mesh.geometry.dispose();
      entry.material.dispose();
      entry.texture.dispose();
      this.group.remove(entry.mesh);
    }
    this.entries.clear();
    this.activeIds.clear();
    this.syntheticIds.clear();
  }
}
