/**
 * Shared projective-texture material: samples a captured CameraFrame as if
 * it were a slide projector aimed from where it was taken, using the same
 * view-projection convention as capture/geom.ts's `projectPoint` (see
 * `frameViewProjection`'s doc comment for the shared math). Used by
 * BackgroundHull (real objects hidden/moved in live-overlay mode) and
 * ShellRenderer's captured-shell surfaces, so both read the real world from
 * the nearest clean-plate/room-shell viewpoint instead of a flat color.
 */
import * as THREE from 'three';
import type { CameraFrame } from '@/capture/contract';
import { frameViewProjection } from '@/capture/geom';

const textureCache = new WeakMap<CameraFrame, THREE.DataTexture>();

/**
 * DataTexture for a frame's RGBA, cached per frame instance (frames are
 * immutable once captured).
 *
 * Colour space: deliberately `THREE.NoColorSpace`, NOT `SRGBColorSpace`.
 * `frame.rgba` comes straight off a 2D canvas `getImageData()` (see
 * `src/sim/camera-source.ts`), i.e. it already holds the exact display-ready
 * sRGB-encoded bytes passthrough shows. The materials that sample this
 * texture (below, and the depth-mesh material in `depth-mesh.ts`) are hand
 * written `ShaderMaterial`s that write `texture2D(...)` straight to
 * `gl_FragColor` with no `colorspace_fragment`/`linearToOutputTexel` step
 * afterwards. Tagging the texture `SRGBColorSpace` makes three.js upload it
 * with an `SRGB8_ALPHA8` internal format, which makes the GPU sampler
 * silently decode sRGB -> linear on every `texture2D()` call; since that
 * decoded (linear, i.e. darker-looking than the sRGB source for any
 * mid-tone) value is then written directly as the final pixel with no
 * re-encode back to sRGB, the result was double-converted and rendered
 * visibly darker than the surrounding passthrough. `NoColorSpace` makes the
 * sampler return the stored bytes unchanged, so a frame pixel reproduces the
 * passthrough pixel exactly when the head is at the frame's pose. (Built-in
 * materials such as `plates.ts`'s `MeshBasicMaterial` do their own decode
 * *and* re-encode via `colorspace_fragment`, so they stay on
 * `SRGBColorSpace` and are unaffected by this.)
 */
export function getFrameTexture(frame: CameraFrame): THREE.DataTexture {
  let tex = textureCache.get(frame);
  if (!tex) {
    tex = new THREE.DataTexture(frame.rgba, frame.width, frame.height, THREE.RGBAFormat);
    // frame.rgba is row-major, top row first (see capture/contract.ts). With
    // flipY left at its DataTexture default (false), texel row 0 uploads to
    // texture v=0, which is exactly the mapping the fragment shader below
    // assumes (v = 0.5 - ndc.y*0.5, i.e. v=0 at the top of the view).
    tex.flipY = false;
    tex.needsUpdate = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    textureCache.set(frame, tex);
  }
  return tex;
}

const VERTEX_SHADER = `
varying vec3 vWorldPos;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = `
uniform sampler2D uFrameTex;
uniform mat4 uFrameViewProj;
varying vec3 vWorldPos;
void main() {
  vec4 clip = uFrameViewProj * vec4(vWorldPos, 1.0);
  if (clip.w <= 0.0) discard; // behind the frame's camera
  vec2 ndc = clip.xy / clip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) discard; // outside the frame
  vec2 uv = vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  gl_FragColor = texture2D(uFrameTex, uv);
}
`;

export function createProjectiveMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFrameTex: { value: null },
      uFrameViewProj: { value: new THREE.Matrix4() },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.DoubleSide,
    depthWrite: true,
    depthTest: true,
  });
}

/** Point a projective material at a captured frame (texture + its view-projection matrix). */
export function setMaterialFrame(material: THREE.ShaderMaterial, frame: CameraFrame): void {
  material.uniforms.uFrameTex!.value = getFrameTexture(frame);
  (material.uniforms.uFrameViewProj!.value as THREE.Matrix4).fromArray(frameViewProjection(frame));
}

// ---------------------------------------------------------------------------
// Unlit direct-UV sampler: used by the depth-mesh geometry (see
// render/depth-mesh.ts), whose vertices are already unprojected per-pixel
// from the frame, so each vertex's UV maps straight to its source texel -
// no per-fragment view-projection re-derivation needed (unlike the
// projective material above, which projects an arbitrary surface point back
// into the frame every fragment because that geometry - a flat box face -
// has no inherent per-vertex correspondence to frame pixels).
// ---------------------------------------------------------------------------

const UNLIT_VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const UNLIT_FRAGMENT_SHADER = `
uniform sampler2D uMap;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uMap, vUv);
}
`;

/** Unlit material that samples a captured frame's texture directly via vertex UVs. */
export function createUnlitTextureMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: null } },
    vertexShader: UNLIT_VERTEX_SHADER,
    fragmentShader: UNLIT_FRAGMENT_SHADER,
    side: THREE.FrontSide,
    depthWrite: true,
    depthTest: true,
  });
}

/** Point an unlit direct-UV material at a captured frame's texture. */
export function setUnlitMaterialFrame(material: THREE.ShaderMaterial, frame: CameraFrame): void {
  material.uniforms.uMap!.value = getFrameTexture(frame);
}
