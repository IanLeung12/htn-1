/**
 * Environment depth occlusion.
 *
 * Rendering order rationale (see reality-editor-canonical-architecture.md,
 * "Static-shell depth masking", feasibility gate 6):
 *
 *   1. Room-shell tiles (static physical walls/furniture reconstruction) are
 *      rendered FIRST, writing color+depth from their own known geometry.
 *      Because they come from our own tracked planes/meshes they already
 *      match the physical world; letting the XR depth-sensing mesh write
 *      over them would just re-quantize the same surface at a different
 *      resolution/lag and cause z-fighting/flicker as the two estimates
 *      drift frame to frame.
 *   2. The XR depth-sensing occlusion mesh is rendered SECOND, depth-only
 *      (color write disabled), strictly to let DYNAMIC real-world content
 *      (hands, people, pets) that the static shell doesn't know about
 *      occlude virtual content behind them.
 *   3. Editable/spawned virtual objects render LAST, depth-testing against
 *      both of the above, so a hand in front of a spawned cube correctly
 *      occludes it (via the depth mesh), while the static shell never
 *      fights with the depth mesh for the same real surface.
 *
 * This module owns step 2 only; renderer.ts sequences the three passes.
 */
import * as THREE from 'three';

export interface DepthState {
  /** True if renderer.xr currently has a usable depth-sensing texture. */
  available: boolean;
  /** Milliseconds since the last valid depth sample; Infinity if never. */
  ageMs: number;
}

export class DepthOcclusion {
  private lastValidAt = -Infinity;
  readonly state: DepthState = { available: false, ageMs: Infinity };

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /** Call once per rendered frame, after renderer.xr has processed the frame. */
  update(nowMs: number): void {
    let available = false;
    try {
      available = this.renderer.xr.hasDepthSensing();
    } catch {
      available = false; // Feature not present on this build/session; never throw.
    }

    if (available) {
      this.lastValidAt = nowMs;
    }
    this.state.available = available;
    this.state.ageMs = Number.isFinite(this.lastValidAt) ? nowMs - this.lastValidAt : Infinity;
  }

  /**
   * The depth occlusion mesh to render depth-only, or null if unavailable.
   * `renderOrder` is set higher than the static shell (0) so the shell draws
   * first and claims the depth buffer for surfaces it already knows about.
   * `depthFunc` is set to LessDepth (strictly nearer) rather than the default
   * LessEqualDepth so this mesh only wins the depth test - and therefore only
   * occludes - where something is genuinely nearer than the static shell
   * (a hand, a person). At the wall/furniture itself the two estimates are
   * near-equal and the shell's depth (drawn first) wins, which is what
   * prevents frame-to-frame flicker between two independent depth estimates
   * of the same physical surface.
   */
  getOcclusionMesh(): THREE.Mesh | null {
    if (!this.state.available) return null;
    try {
      const mesh = this.renderer.xr.getDepthSensingMesh();
      if (mesh) {
        mesh.renderOrder = 1;
        // Fullscreen quad drawn in clip space directly by three's occlusion
        // shader (see WebXRDepthSensing.js) rather than via the object's
        // transform, so its (identity, world-origin) bounding sphere is
        // meaningless for culling - without this, walking a few metres from
        // the origin (gate 2's walking loop) could get it frustum-culled and
        // silently stop hand/person occlusion.
        mesh.frustumCulled = false;
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const mat of material) {
            mat.depthFunc = THREE.LessDepth;
            mat.colorWrite = false;
          }
        } else {
          material.depthFunc = THREE.LessDepth;
          material.colorWrite = false;
        }
      }
      return mesh;
    } catch {
      return null;
    }
  }
}
