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

/** DataTexture for a frame's RGBA, cached per frame instance (frames are immutable once captured). */
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
    tex.colorSpace = THREE.SRGBColorSpace;
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
