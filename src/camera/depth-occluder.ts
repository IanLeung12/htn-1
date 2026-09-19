/**
 * Live-depth occlusion for the general-camera backend: makes spawned/virtual
 * objects hide behind real ones using the estimated depth map, the same way
 * the WebXR depth-sensing occlusion mesh does on a headset (see
 * `src/xr/depth.ts`'s module doc for the analogous 3-pass rationale).
 *
 * Each frame, `depthEstimator.latest`'s `metric` array (metres along the
 * camera forward axis, see `contract.ts`'s `DepthMap`) is uploaded into a
 * small `DataTexture` and sampled by a full-screen quad drawn FIRST
 * (`renderOrder -1`, before the static shell at 0, depth-reset boxes at 0.5,
 * captured content at 1, and objects/impostors/eraser at 2 - see
 * `src/render/projective.ts` / `background-hull.ts` / `objects.ts`), writing
 * only depth (`colorWrite: false`) so real-world content the depth estimator
 * can see - anything not already accounted for by the app's own captured
 * geometry - occludes virtual content behind it.
 *
 * The written depth is the true metric depth pushed back slightly
 * (`occluderBiasM`, added in metres) so plates/impostors/eraser patches that
 * sit exactly AT a real surface (drawn afterwards, at the true unbiased
 * depth) reliably win the depth test instead of z-fighting or losing to
 * estimator noise - the same reasoning `xr/depth.ts` uses `LessDepth`
 * (strictly nearer) for, just applied as a depth offset instead of a
 * compare-function change (this quad has no incoming depth to compare
 * against - `depthTest: false`, `AlwaysDepth` - since it draws first).
 *
 * Requires WebGL2 (`gl_FragDepth` is core in GLSL ES 300, which three r186
 * always compiles down to when a WebGL2 context is available - see
 * `WebGLProgram.js`'s unconditional `#version 300 es`).
 */
import * as THREE from 'three';
import type { DepthMap } from './contract';

/** Depth maps older than this are considered stale (a moved camera invalidates a screen-space sample) and skipped. */
export const OCCLUDER_STALE_MS = 500;

/** Per-pixel weight below this (see `DepthMap.weight`) is treated as invalid. */
const MIN_WEIGHT = 0.3;
/** Per-pixel confidence (0..255, see `DepthMap.confidenceMap`) below this is treated as invalid. */
const MIN_CONFIDENCE = 64;

const VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  // Full-screen quad in clip space directly - independent of this mesh's own
  // transform, which is never touched (see xr/depth.ts's WebXR occlusion
  // mesh for the same "fullscreen quad, no transform" convention).
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// uDepthTex.r = metric forward depth (metres), .g = 1.0 valid / 0.0 invalid
// (packed together so one texture upload covers both metric + weight/confidence).
const FRAGMENT_SHADER = `
uniform sampler2D uDepthTex;
uniform int uValid;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(0.0);
  if (uValid == 0) {
    gl_FragDepth = 1.0;
    return;
  }
  // DepthMap rows are top-row-first (contract.ts); vUv.y=0 is the plane's
  // bottom (screen bottom), so flip to sample the texture's row 0 at the
  // screen top - same convention as render/projective.ts's frame texture.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 texel = texture2D(uDepthTex, uv).rg;
  float depthM = texel.r;
  float ok = texel.g;
  if (ok < 0.5 || !(depthM > 0.0) || depthM != depthM) {
    gl_FragDepth = 1.0;
    return;
  }
  // Forward distance -> NDC depth via the ACTIVE camera's own projection
  // matrix (three supplies this built-in uniform for whatever camera
  // renderer.render(scene, camera) was called with), so this stays correct
  // if near/far/fov ever change - see forwardDepthToNdc for the equivalent
  // pure-math version this must agree with (tests/unit/depth-occluder.test.ts).
  vec4 clip = projectionMatrix * vec4(0.0, 0.0, -depthM, 1.0);
  float ndc = clip.z / clip.w;
  gl_FragDepth = clamp(ndc * 0.5 + 0.5, 0.0, 1.0);
}
`;

/**
 * Pure reimplementation of the fragment shader's forward-depth -> depth-buffer
 * conversion, for unit testing without a GL context. Matches three.js's
 * standard (on-axis) perspective projection: the well-known
 * `(1/z - 1/near) / (1/far - 1/near)` non-linear depth mapping, clamped to
 * the valid [0, 1] depth-buffer range for depths outside [near, far].
 */
export function forwardDepthToNdc(depthM: number, near: number, far: number): number {
  if (!(depthM > 0) || !Number.isFinite(depthM)) return 1;
  const ndc = (1 / depthM - 1 / near) / (1 / far - 1 / near);
  return Math.min(1, Math.max(0, ndc));
}

export interface DepthOccluderState {
  enabled: boolean;
  /** Timestamp (DepthMap.timestamp) of the most recently uploaded map; -Infinity if none yet. */
  lastUploadTs: number;
  textureWidth: number;
  textureHeight: number;
}

/**
 * Draws a full-screen depth-only quad from the newest live depth map. Add
 * `.mesh` to the scene once; call `.update()` once per rendered frame before
 * `renderer.render`.
 */
export class DepthOccluder {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private texture: THREE.DataTexture | null = null;
  private data: Float32Array | null = null;
  private texW = 0;
  private texH = 0;
  private lastTimestamp = -Infinity;

  readonly state: DepthOccluderState = {
    enabled: true,
    lastUploadTs: -Infinity,
    textureWidth: 0,
    textureHeight: 0,
  };

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDepthTex: { value: null },
        uValid: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      colorWrite: false,
      depthWrite: true,
      depthTest: false,
      depthFunc: THREE.AlwaysDepth,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'depth-occluder';
    // Drawn first, before the static shell (0), depth-reset boxes (0.5),
    // captured content (1) and objects/impostors/eraser (2) - see module doc.
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /**
   * Call once per rendered frame. `map` is `depthEstimator.latest`; `now` is
   * `performance.now()`; `enabled` is the tuning flag; `biasM` is
   * `tuning.occluderBiasM` (metres added to the metric depth before it is
   * written, see module doc).
   */
  update(map: DepthMap | undefined, now: number, enabled: boolean, biasM: number): void {
    this.state.enabled = enabled;
    if (!enabled || !map || !(map.width > 0) || !(map.height > 0)) {
      this.mesh.visible = false;
      this.material.uniforms.uValid!.value = 0;
      return;
    }
    if (now - map.timestamp > OCCLUDER_STALE_MS) {
      this.mesh.visible = false;
      this.material.uniforms.uValid!.value = 0;
      return;
    }

    this.ensureTexture(map.width, map.height);
    if (map.timestamp !== this.lastTimestamp) {
      this.lastTimestamp = map.timestamp;
      this.uploadDepth(map, biasM);
      this.state.lastUploadTs = map.timestamp;
    }
    this.material.uniforms.uValid!.value = 1;
    this.mesh.visible = true;
  }

  private ensureTexture(width: number, height: number): void {
    if (this.texture && this.texW === width && this.texH === height) return;
    this.texture?.dispose();
    this.texW = width;
    this.texH = height;
    this.data = new Float32Array(width * height * 2);
    const texture = new THREE.DataTexture(this.data, width, height, THREE.RGFormat, THREE.FloatType);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.texture = texture;
    this.material.uniforms.uDepthTex!.value = texture;
    this.state.textureWidth = width;
    this.state.textureHeight = height;
  }

  private uploadDepth(map: DepthMap, biasM: number): void {
    const data = this.data;
    const texture = this.texture;
    if (!data || !texture) return;
    const n = map.width * map.height;
    const metric = map.metric;
    const weight = map.weight;
    const confidenceMap = map.confidenceMap;
    for (let i = 0; i < n; i++) {
      const raw = metric[i] ?? 0;
      const w = weight ? (weight[i] ?? 0) : 1;
      const c = confidenceMap ? (confidenceMap[i] ?? 0) : 255;
      const valid = raw > 0 && Number.isFinite(raw) && w >= MIN_WEIGHT && c >= MIN_CONFIDENCE;
      data[i * 2] = valid ? raw + biasM : 0;
      data[i * 2 + 1] = valid ? 1 : 0;
    }
    texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.data = null;
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
