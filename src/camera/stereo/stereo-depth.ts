/**
 * WebGL2 stereo depth for the ZED 2 (or any side-by-side stereo source):
 * the GPU implementation of the census pipeline whose CPU reference lives in
 * ./census.ts. Implements `CreateStereoDepthEstimator` from ./contract.ts and
 * registers itself with `registerStereoDepth` at import.
 *
 * Passes (all fullscreen-triangle fragment shaders, one draw each; nothing
 * loops over disparities in JS, and no readback but the final one):
 *   1. remap    both eyes through the rectification maps (RG32F source pixel
 *               per rectified pixel, at full eye resolution, scaled to the work
 *               grid) into R32F luma; identity when there are no maps.
 *   2. rowmean  per-row luma mean of each eye (1 x H).
 *   3. census   5x5 census transform (24 bits in an R32UI texel) on the row
 *               equalised luma (right eye scaled to the left eye's row mean).
 *   4. cost     Hamming distance for every disparity 0..D-1, both directions,
 *               written as an RGBA8UI atlas of D/4 tiles (4 disparities per
 *               texel). Unrectified input searches +-rowSearch rows and keeps the
 *               minimum.
 *   5. aggH     7-wide horizontal box sum on the atlas (fits in 8 bits: 7 * 24).
 *   6. wta      per pixel: 7-tall vertical box sum over the D/4 tiles (the other
 *               half of the separable 7x7 aggregation), winner-take-all with
 *               parabola sub-pixel refinement -> RG32F (disparity, cost).
 *   7. lr       left-right consistency: reject |dL - dR(x - dL)| > 1 -> R32F.
 *   8. median   3x3 median over consistent neighbours -> R32F.
 *   9. final    5x5 mean hole fill (confidence 0.5), then a plane-aware fill of
 *               the remaining holes whose 15x15 neighbourhood is >= 20% valid and
 *               planar in disparity (least squares, confidence 0.4; the bare desk
 *               between matched edges), and Z = fx * B / d -> RGBA32F
 *               (depth m, confidence, disparity, 0), read back once.
 *
 * Depth is metres along the rectified camera axis at the work resolution
 * (fx scaled from the full eye size), holes are 0. `latest.confidence` is the
 * fraction of pixels that passed the LR check, as the contract asks.
 */
import type { Pose } from '@/core/types';
import type { CameraIntrinsics, DepthEstimator, DepthMap, DepthSample, DepthStatus, GrabbedFrame } from '../contract';
import { resampleDepth } from '../depth/fit';
import { registerStereoDepth, type CreateStereoDepthOptions, type RectifyMaps, type StereoDepthEstimator, type StereoDepthStats } from './contract';

const DEFAULT_WORK_WIDTH = 336;
/** Eye-order auto-detection: both orderings are matched on these frames (then every AUTO_SWAP_PERIOD frames). */
const AUTO_SWAP_WARMUP_FRAMES = 2;
const AUTO_SWAP_PERIOD = 120;
/** The other ordering must beat the current one's LR-consistent fraction by this factor to switch. */
const AUTO_SWAP_HYSTERESIS = 1.25;
const DEFAULT_MAX_DISPARITY_AT_336 = 64;
/** Rows searched either side when the input is not rectified. */
const UNRECTIFIED_ROW_SEARCH = 2;
/** Left-right consistency tolerance (px). */
export const LR_TOLERANCE_PX = 1;
/** Aggregation window radius (7x7). */
const AGG_RADIUS = 3;
/** Disparities below this (px) are treated as no match / infinitely far. */
const MIN_DISPARITY = 0.5;
/** Minimum valid neighbours (of 24) for the 5x5 hole fill. */
const HOLE_FILL_MIN_NEIGHBOURS = 8;
/** Plane-aware fill: radius of the neighbourhood (7 -> 15x15) fitted by least squares in disparity space. */
export const PLANE_FILL_RADIUS = 7;
/** ...which must be at least this fraction valid; larger holes stay invalid. */
export const PLANE_FILL_MIN_VALID_FRACTION = 0.2;
/** ...and fit those neighbours to within this RMS (px), else the neighbourhood is not one surface. */
export const PLANE_FILL_MAX_RMS_PX = 2;
/** Confidence / weight of plane-filled pixels (mean-filled 0.5, matched 1). */
export const PLANE_FILL_CONFIDENCE = 0.4;

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const VS = `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_REMAP = `#version 300 es
precision highp float;
uniform sampler2D uEye;
uniform sampler2D uMap;
uniform bool uHasMap;
uniform vec2 uWork;
uniform vec2 uMapSize;
out float outGray;
void main() {
  vec2 uv = gl_FragCoord.xy / uWork;
  if (uHasMap) {
    // Map texels hold source pixel coordinates (integer = pixel centre) at the full eye size.
    vec2 s = texture(uMap, uv).rg;
    uv = (s + 0.5) / uMapSize;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { outGray = 0.0; return; }
  }
  vec3 c = texture(uEye, uv).rgb * 255.0;
  outGray = dot(c, vec3(0.299, 0.587, 0.114));
}`;

const FS_ROWMEAN = `#version 300 es
precision highp float;
uniform sampler2D uGray;
uniform int uWidth;
out float outMean;
void main() {
  int y = int(gl_FragCoord.y);
  float s = 0.0;
  for (int x = 0; x < uWidth; x++) s += texelFetch(uGray, ivec2(x, y), 0).r;
  outMean = s / float(uWidth);
}`;

const FS_CENSUS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uGray;
uniform sampler2D uMeanSelf;
uniform sampler2D uMeanRef;
uniform ivec2 uSize;
out uint outCensus;
float g(ivec2 p) {
  p = clamp(p, ivec2(0), uSize - 1);
  float v = texelFetch(uGray, p, 0).r;
  float ms = texelFetch(uMeanSelf, ivec2(0, p.y), 0).r;
  float mr = texelFetch(uMeanRef, ivec2(0, p.y), 0).r;
  return ms > 1e-3 ? v * (mr / ms) : v;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float centre = g(c);
  uint bits = 0u;
  uint bit = 0u;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      if (dx == 0 && dy == 0) continue;
      if (g(c + ivec2(dx, dy)) >= centre) bits |= (1u << bit);
      bit++;
    }
  }
  outCensus = bits;
}`;

const FS_COST = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uCRef;
uniform usampler2D uCOther;
uniform ivec2 uSize;
uniform int uTilesX;
uniform int uDir;
uniform int uRowSearch;
out uvec4 outCost;
uint pc(uint v) {
  v = v - ((v >> 1u) & 0x55555555u);
  v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
  v = (v + (v >> 4u)) & 0x0F0F0F0Fu;
  return ((v * 0x01010101u) >> 24u) & 0xFFu;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 tile = p / uSize;
  ivec2 q = p - tile * uSize;
  int g = tile.y * uTilesX + tile.x;
  uint ref = texelFetch(uCRef, q, 0).r;
  uvec4 o = uvec4(24u);
  for (int k = 0; k < 4; k++) {
    int d = g * 4 + k;
    int xo = q.x + uDir * d;
    if (xo < 0 || xo >= uSize.x) continue;
    uint c = pc(ref ^ texelFetch(uCOther, ivec2(xo, q.y), 0).r);
    for (int r = 1; r <= uRowSearch; r++) {
      if (q.y - r >= 0) c = min(c, pc(ref ^ texelFetch(uCOther, ivec2(xo, q.y - r), 0).r));
      if (q.y + r < uSize.y) c = min(c, pc(ref ^ texelFetch(uCOther, ivec2(xo, q.y + r), 0).r));
    }
    o[k] = c;
  }
  outCost = o;
}`;

const FS_AGG_H = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uCost;
uniform ivec2 uSize;
out uvec4 outAgg;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 tile = p / uSize;
  ivec2 q = p - tile * uSize;
  ivec2 base = tile * uSize;
  uvec4 s = uvec4(0u);
  for (int dx = -${AGG_RADIUS}; dx <= ${AGG_RADIUS}; dx++) {
    int x = clamp(q.x + dx, 0, uSize.x - 1);
    s += texelFetch(uCost, base + ivec2(x, q.y), 0);
  }
  outAgg = s;
}`;

const FS_WTA = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uAgg;
uniform ivec2 uSize;
uniform int uTilesX;
uniform int uGroups;
out vec2 outBest;
float bestC, bestD, cBefore, cAfter, prevC;
void consider(float c, float d) {
  if (c < bestC) { bestC = c; bestD = d; cBefore = prevC; cAfter = 1e9; }
  else if (d == bestD + 1.0) { cAfter = c; }
  prevC = c;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  bestC = 1e9; bestD = -1.0; cBefore = 1e9; cAfter = 1e9; prevC = 1e9;
  for (int g = 0; g < uGroups; g++) {
    ivec2 base = ivec2(g % uTilesX, g / uTilesX) * uSize;
    uvec4 s = uvec4(0u);
    for (int dy = -${AGG_RADIUS}; dy <= ${AGG_RADIUS}; dy++) {
      int y = clamp(q.y + dy, 0, uSize.y - 1);
      s += texelFetch(uAgg, base + ivec2(q.x, y), 0);
    }
    vec4 c = vec4(s);
    float d0 = float(g * 4);
    consider(c.x, d0);
    consider(c.y, d0 + 1.0);
    consider(c.z, d0 + 2.0);
    consider(c.w, d0 + 3.0);
  }
  float d = bestD;
  if (bestD > 0.0 && cBefore < 1e8 && cAfter < 1e8) {
    float denom = cBefore - 2.0 * bestC + cAfter;
    if (abs(denom) > 1e-6) d = bestD + clamp(0.5 * (cBefore - cAfter) / denom, -0.5, 0.5);
  }
  outBest = vec2(d, bestC);
}`;

const FS_LR = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uL;
uniform sampler2D uR;
uniform ivec2 uSize;
uniform float uTol;
out float outD;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  float dL = texelFetch(uL, q, 0).r;
  int xr = int(floor(float(q.x) - dL + 0.5));
  if (dL < 0.0 || xr < 0 || xr >= uSize.x) { outD = 0.0; return; }
  float dR = texelFetch(uR, ivec2(xr, q.y), 0).r;
  outD = abs(dL - dR) <= uTol ? dL : 0.0;
}`;

const FS_MEDIAN = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uD;
uniform ivec2 uSize;
out float outD;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  float centre = texelFetch(uD, q, 0).r;
  if (centre <= 0.0) { outD = 0.0; return; }
  float v[9];
  int n = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 p = q + ivec2(dx, dy);
      if (p.x < 0 || p.y < 0 || p.x >= uSize.x || p.y >= uSize.y) continue;
      float d = texelFetch(uD, p, 0).r;
      if (d <= 0.0) continue;
      // insertion into the sorted prefix
      int j = n;
      while (j > 0 && v[j - 1] > d) { v[j] = v[j - 1]; j--; }
      v[j] = d;
      n++;
    }
  }
  outD = v[n / 2];
}`;

const FS_FINAL = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uD;
uniform ivec2 uSize;
uniform float uFxB;
uniform float uMinDisparity;
uniform int uHoleMin;
uniform int uPlaneRadius;
uniform float uPlaneMinFraction;
uniform float uPlaneMaxRms;
uniform float uPlaneConf;
out vec4 outColor;
float at(ivec2 p) {
  if (p.x < 0 || p.y < 0 || p.x >= uSize.x || p.y >= uSize.y) return 0.0;
  return texelFetch(uD, p, 0).r;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  float d = texelFetch(uD, q, 0).r;
  float conf = 1.0;
  if (d <= 0.0) {
    // Small holes: mean of the 5x5 neighbours.
    float s = 0.0;
    int n = 0;
    for (int dy = -2; dy <= 2; dy++) {
      for (int dx = -2; dx <= 2; dx++) {
        float v = at(q + ivec2(dx, dy));
        if (v > 0.0) { s += v; n++; }
      }
    }
    if (n >= uHoleMin) {
      d = s / float(n);
      conf = 0.5;
    } else {
      // Plane-aware fill: least squares d = a*x + b*y + c over the valid pixels of the
      // (2r+1)^2 neighbourhood (textureless desk between matched edges); needs enough support
      // and a planar neighbourhood (small RMS), else the hole stays invalid.
      float Sxx = 0.0, Sxy = 0.0, Syy = 0.0, Sx = 0.0, Sy = 0.0, Sd = 0.0, Sxd = 0.0, Syd = 0.0, Sdd = 0.0, N = 0.0;
      for (int dy = -uPlaneRadius; dy <= uPlaneRadius; dy++) {
        for (int dx = -uPlaneRadius; dx <= uPlaneRadius; dx++) {
          float v = at(q + ivec2(dx, dy));
          if (v <= 0.0) continue;
          float x = float(dx);
          float y = float(dy);
          Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y;
          Sd += v; Sxd += x * v; Syd += y * v; Sdd += v * v; N += 1.0;
        }
      }
      float side = float(2 * uPlaneRadius + 1);
      if (N < uPlaneMinFraction * (side * side - 1.0)) { outColor = vec4(0.0); return; }
      mat3 A = mat3(Sxx, Sxy, Sx, Sxy, Syy, Sy, Sx, Sy, N);
      if (abs(determinant(A)) < 1e-3) { outColor = vec4(0.0); return; }
      vec3 sol = inverse(A) * vec3(Sxd, Syd, Sd);
      float sse = max(0.0, Sdd - sol.x * Sxd - sol.y * Syd - sol.z * Sd);
      if (sqrt(sse / N) > uPlaneMaxRms) { outColor = vec4(0.0); return; }
      d = sol.z;
      conf = uPlaneConf;
    }
  }
  if (d < uMinDisparity) { outColor = vec4(0.0); return; }
  outColor = vec4(uFxB / d, conf, d, 0.0);
}`;

// ---------------------------------------------------------------------------
// GL helpers
// ---------------------------------------------------------------------------

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(`stereo shader compile failed: ${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fs: string): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fsh = compile(gl, gl.FRAGMENT_SHADER, fs);
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fsh);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fsh);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
    gl.deleteProgram(program);
    throw new Error(`stereo program link failed: ${log}`);
  }
  return { program, uniforms: new Map() };
}

function loc(gl: WebGL2RenderingContext, p: Program, name: string): WebGLUniformLocation | null {
  let l = p.uniforms.get(name);
  if (l === undefined) {
    l = gl.getUniformLocation(p.program, name);
    p.uniforms.set(name, l);
  }
  return l;
}

interface Target {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

function createTexture(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number, internalFormat: number, format: number, type: number): Target {
  const texture = createTexture(gl, gl.NEAREST);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('createFramebuffer failed');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(fbo);
    throw new Error(`stereo framebuffer incomplete (0x${status.toString(16)}) for format 0x${internalFormat.toString(16)} ${width}x${height}`);
  }
  void format;
  void type;
  return { texture, fbo, width, height };
}

function deleteTarget(gl: WebGL2RenderingContext, t: Target): void {
  gl.deleteTexture(t.texture);
  gl.deleteFramebuffer(t.fbo);
}

/** Everything sized by (work width, work height, disparity range); rebuilt when any changes. */
interface Buffers {
  width: number;
  height: number;
  maxDisparity: number;
  groups: number;
  tilesX: number;
  tilesY: number;
  eye: [WebGLTexture, WebGLTexture];
  gray: [Target, Target];
  rowMean: [Target, Target];
  census: [Target, Target];
  cost: [Target, Target];
  agg: [Target, Target];
  wta: [Target, Target];
  lr: Target;
  median: Target;
  final: Target;
  readback: Float32Array;
}

type Programs = Record<'remap' | 'rowmean' | 'census' | 'cost' | 'aggH' | 'wta' | 'lr' | 'median' | 'final', Program>;

interface MapTextures {
  key: RectifyMaps;
  left: WebGLTexture;
  right: WebGLTexture;
  width: number;
  height: number;
}

/** Atlas tiling for `groups` tiles of `w x h`: roughly square overall, within the texture limit. */
export function atlasLayout(groups: number, w: number, h: number, maxSize: number): { tilesX: number; tilesY: number } {
  let tilesX = Math.max(1, Math.min(groups, Math.round(Math.sqrt((groups * h) / w))));
  tilesX = Math.max(1, Math.min(tilesX, Math.floor(maxSize / w)));
  let tilesY = Math.ceil(groups / tilesX);
  while (tilesY * h > maxSize && tilesX < groups) {
    tilesX += 1;
    tilesY = Math.ceil(groups / tilesX);
  }
  if (tilesX * w > maxSize || tilesY * h > maxSize) throw new Error(`stereo cost atlas ${tilesX * w}x${tilesY * h} exceeds MAX_TEXTURE_SIZE ${maxSize}`);
  return { tilesX, tilesY };
}

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

export interface WebGL2StereoDepthOptions extends CreateStereoDepthOptions {
  /**
   * Which half is the left eye. 'auto' (default) matches both orderings on the first frames and
   * periodically, keeping the one with more left-right-consistent pixels: a pair fed in the wrong
   * order has negative disparities and matches almost nothing. `true` forces swapped input.
   */
  swapEyes?: boolean | 'auto';
}

export interface WebGL2StereoDepthStats extends StereoDepthStats {
  /** True when the estimator treats `frame.right` as the LEFT eye (see `swapEyes`). */
  eyesSwapped: boolean;
}

export class WebGL2StereoDepthEstimator implements StereoDepthEstimator {
  readonly status: DepthStatus = {
    state: 'idle',
    backend: 'none',
    modelId: 'stereo-census-webgl2',
    lastInferenceMs: 0,
    error: null,
    frames: 0,
    lastPublishedAt: -Infinity,
    fitMode: 'none',
  };
  readonly stats: WebGL2StereoDepthStats;
  latestDisparity: { data: Float32Array; width: number; height: number } | undefined = undefined;
  /** Per-pixel confidence of the newest map (1 consistent, 0.5 filled hole, 0 invalid). */
  latestConfidence: Float32Array | undefined = undefined;

  private map: DepthMap | undefined = undefined;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private readonly ownsContext: boolean;
  private programs: Programs | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffers: Buffers | null = null;
  private maps: MapTextures | null = null;
  private floatLinear = false;
  private maxTextureSize = 2048;

  private readonly workWidth: number;
  private readonly maxDisparityOpt: number | undefined;
  private readonly fxScale: () => number;
  private readonly fallback: DepthEstimator | null;
  private readonly swapMode: boolean | 'auto';
  private swapped = false;

  constructor(private readonly opts: WebGL2StereoDepthOptions) {
    this.workWidth = opts.workWidth ?? DEFAULT_WORK_WIDTH;
    this.maxDisparityOpt = opts.maxDisparity;
    this.fxScale = opts.fxScale ?? (() => 1);
    this.fallback = opts.fallback ?? null;
    this.ownsContext = !opts.gl;
    this.gl = opts.gl ?? null;
    this.swapMode = opts.swapEyes ?? 'auto';
    this.swapped = this.swapMode === true;
    this.stats = { workWidth: this.workWidth, workHeight: 0, maxDisparity: this.disparityRangeFor(this.workWidth), validFraction: 0, lastMs: 0, rectified: false, backend: 'none', eyesSwapped: this.swapped };
  }

  /** Disparity range for a work width: 64 at 336 px, scaled linearly, rounded up to a multiple of 4. */
  disparityRangeFor(width: number): number {
    const d = this.maxDisparityOpt ?? (DEFAULT_MAX_DISPARITY_AT_336 * width) / DEFAULT_WORK_WIDTH;
    return Math.max(4, Math.ceil(d / 4) * 4);
  }

  get latest(): DepthMap | undefined {
    return this.map ?? this.fallback?.latest;
  }

  async start(): Promise<void> {
    if (this.fallback) await this.fallback.start();
    if (this.programs) return;
    try {
      let gl = this.gl;
      if (!gl) {
        if (typeof document === 'undefined') throw new Error('no document for a WebGL2 canvas');
        const canvas = document.createElement('canvas');
        canvas.width = 4;
        canvas.height = 4;
        gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
        if (!gl) throw new Error('WebGL2 unavailable');
        this.canvas = canvas;
        this.gl = gl;
      }
      if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable (float render targets)');
      this.floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
      this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      this.vao = gl.createVertexArray();
      this.programs = {
        remap: createProgram(gl, FS_REMAP),
        rowmean: createProgram(gl, FS_ROWMEAN),
        census: createProgram(gl, FS_CENSUS),
        cost: createProgram(gl, FS_COST),
        aggH: createProgram(gl, FS_AGG_H),
        wta: createProgram(gl, FS_WTA),
        lr: createProgram(gl, FS_LR),
        median: createProgram(gl, FS_MEDIAN),
        final: createProgram(gl, FS_FINAL),
      };
      this.status.state = 'ready';
      this.status.backend = 'webgl2';
      this.status.error = null;
      this.stats.backend = 'webgl2';
    } catch (err) {
      this.status.state = 'unavailable';
      this.status.backend = 'none';
      this.status.error = `stereo: ${err instanceof Error ? err.message : String(err)}`;
      this.stats.backend = 'none';
    }
  }

  submit(frame: GrabbedFrame, pose: Pose, intrinsics: CameraIntrinsics): boolean {
    const gl = this.gl;
    const programs = this.programs;
    if (!gl || !programs || this.status.state !== 'ready' || !frame.right) {
      return this.fallback ? this.fallback.submit(frame, pose, intrinsics) : false;
    }
    const calib = this.opts.getCalibration();
    if (!calib) return false;
    const t0 = performance.now();
    try {
      const fxWork = calib.fxPx * (frame.width / calib.eyeWidth) * this.fxScale();
      let result = this.run(gl, programs, frame, calib.rectifyMaps, fxWork, calib.baselineM, this.swapped);
      if (this.swapMode === 'auto' && (this.status.frames < AUTO_SWAP_WARMUP_FRAMES || this.status.frames % AUTO_SWAP_PERIOD === 0)) {
        const other = this.run(gl, programs, frame, calib.rectifyMaps, fxWork, calib.baselineM, !this.swapped);
        if (other.validFraction > result.validFraction * AUTO_SWAP_HYSTERESIS) {
          this.swapped = !this.swapped;
          result = other;
        }
      }
      const ms = performance.now() - t0;
      this.map = {
        width: frame.width,
        height: frame.height,
        metric: result.metric,
        confidence: result.validFraction,
        weight: result.confidence,
        source: 'stereo',
        pose: { position: { ...pose.position }, rotation: { ...pose.rotation } },
        fovY: intrinsics.fovY,
        aspect: frame.width / frame.height,
        timestamp: frame.timestamp,
      };
      this.latestDisparity = { data: result.disparity, width: frame.width, height: frame.height };
      this.latestConfidence = result.confidence;
      this.status.lastInferenceMs = ms;
      this.status.frames += 1;
      this.status.lastPublishedAt = performance.now();
      this.status.fitMode = calib.rectifyMaps ? 'stereo-rectified' : 'stereo-unrectified';
      this.status.error = null;
      this.stats.workWidth = frame.width;
      this.stats.workHeight = frame.height;
      this.stats.maxDisparity = this.buffers?.maxDisparity ?? this.stats.maxDisparity;
      this.stats.validFraction = result.validFraction;
      this.stats.lastMs = ms;
      this.stats.rectified = calib.rectifyMaps !== null;
      this.stats.eyesSwapped = this.swapped;
      return true;
    } catch (err) {
      this.status.error = `stereo: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  private ensureBuffers(gl: WebGL2RenderingContext, width: number, height: number): Buffers {
    const maxDisparity = this.disparityRangeFor(width);
    const b = this.buffers;
    if (b && b.width === width && b.height === height && b.maxDisparity === maxDisparity) return b;
    if (b) this.deleteBuffers(gl, b);
    const groups = maxDisparity / 4;
    const { tilesX, tilesY } = atlasLayout(groups, width, height, this.maxTextureSize);
    const eye: [WebGLTexture, WebGLTexture] = [createTexture(gl, gl.LINEAR), createTexture(gl, gl.LINEAR)];
    for (const t of eye) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    }
    const r32f = (w: number, h: number): Target => createTarget(gl, w, h, gl.R32F, gl.RED, gl.FLOAT);
    const atlas = (): Target => createTarget(gl, tilesX * width, tilesY * height, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE);
    const buffers: Buffers = {
      width,
      height,
      maxDisparity,
      groups,
      tilesX,
      tilesY,
      eye,
      gray: [r32f(width, height), r32f(width, height)],
      rowMean: [r32f(1, height), r32f(1, height)],
      census: [createTarget(gl, width, height, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT), createTarget(gl, width, height, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT)],
      cost: [atlas(), atlas()],
      agg: [atlas(), atlas()],
      wta: [createTarget(gl, width, height, gl.RG32F, gl.RG, gl.FLOAT), createTarget(gl, width, height, gl.RG32F, gl.RG, gl.FLOAT)],
      lr: r32f(width, height),
      median: r32f(width, height),
      final: createTarget(gl, width, height, gl.RGBA32F, gl.RGBA, gl.FLOAT),
      readback: new Float32Array(width * height * 4),
    };
    this.buffers = buffers;
    return buffers;
  }

  private deleteBuffers(gl: WebGL2RenderingContext, b: Buffers): void {
    for (const t of b.eye) gl.deleteTexture(t);
    for (const t of [...b.gray, ...b.rowMean, ...b.census, ...b.cost, ...b.agg, ...b.wta, b.lr, b.median, b.final]) deleteTarget(gl, t);
    if (this.buffers === b) this.buffers = null;
  }

  private ensureMaps(gl: WebGL2RenderingContext, maps: RectifyMaps | null): MapTextures | null {
    if (!maps) return null;
    if (this.maps && this.maps.key === maps) return this.maps;
    if (this.maps) {
      gl.deleteTexture(this.maps.left);
      gl.deleteTexture(this.maps.right);
    }
    const filter = this.floatLinear ? gl.LINEAR : gl.NEAREST;
    const upload = (data: Float32Array): WebGLTexture => {
      const t = createTexture(gl, filter);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, maps.width, maps.height, 0, gl.RG, gl.FLOAT, data);
      return t;
    };
    this.maps = { key: maps, left: upload(maps.left), right: upload(maps.right), width: maps.width, height: maps.height };
    return this.maps;
  }

  private bindTex(gl: WebGL2RenderingContext, p: Program, name: string, unit: number, texture: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc(gl, p, name), unit);
  }

  private draw(gl: WebGL2RenderingContext, p: Program, target: Target): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private run(
    gl: WebGL2RenderingContext,
    P: Programs,
    frame: GrabbedFrame,
    rectifyMaps: RectifyMaps | null,
    fxWork: number,
    baselineM: number,
    swapped: boolean,
  ): { metric: Float32Array; disparity: Float32Array; confidence: Float32Array; validFraction: number } {
    const { width, height } = frame;
    const b = this.ensureBuffers(gl, width, height);
    const maps = this.ensureMaps(gl, rectifyMaps);
    const rowSearch = maps ? 0 : UNRECTIFIED_ROW_SEARCH;
    const eyes: [Uint8ClampedArray, Uint8ClampedArray] = swapped ? [frame.right as Uint8ClampedArray, frame.rgba] : [frame.rgba, frame.right as Uint8ClampedArray];

    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    // 1. upload + remap to luma
    for (let e = 0; e < 2; e++) {
      const rgba = eyes[e]!;
      gl.bindTexture(gl.TEXTURE_2D, b.eye[e]!);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    }
    gl.useProgram(P.remap.program);
    gl.uniform2f(loc(gl, P.remap, 'uWork'), width, height);
    gl.uniform1i(loc(gl, P.remap, 'uHasMap'), maps ? 1 : 0);
    if (maps) gl.uniform2f(loc(gl, P.remap, 'uMapSize'), maps.width, maps.height);
    for (let e = 0; e < 2; e++) {
      this.bindTex(gl, P.remap, 'uEye', 0, b.eye[e]!);
      if (maps) this.bindTex(gl, P.remap, 'uMap', 1, e === 0 ? maps.left : maps.right);
      this.draw(gl, P.remap, b.gray[e]!);
    }

    // 2. row means
    gl.useProgram(P.rowmean.program);
    gl.uniform1i(loc(gl, P.rowmean, 'uWidth'), width);
    for (let e = 0; e < 2; e++) {
      this.bindTex(gl, P.rowmean, 'uGray', 0, b.gray[e]!.texture);
      this.draw(gl, P.rowmean, b.rowMean[e]!);
    }

    // 3. census (right eye equalised to the left eye's row means)
    gl.useProgram(P.census.program);
    gl.uniform2i(loc(gl, P.census, 'uSize'), width, height);
    for (let e = 0; e < 2; e++) {
      this.bindTex(gl, P.census, 'uGray', 0, b.gray[e]!.texture);
      this.bindTex(gl, P.census, 'uMeanSelf', 1, b.rowMean[e]!.texture);
      this.bindTex(gl, P.census, 'uMeanRef', 2, b.rowMean[0]!.texture);
      this.draw(gl, P.census, b.census[e]!);
    }

    // 4. raw cost volumes (left-ref: right at x - d; right-ref: left at x + d)
    gl.useProgram(P.cost.program);
    gl.uniform2i(loc(gl, P.cost, 'uSize'), width, height);
    gl.uniform1i(loc(gl, P.cost, 'uTilesX'), b.tilesX);
    gl.uniform1i(loc(gl, P.cost, 'uRowSearch'), rowSearch);
    for (let e = 0; e < 2; e++) {
      this.bindTex(gl, P.cost, 'uCRef', 0, b.census[e]!.texture);
      this.bindTex(gl, P.cost, 'uCOther', 1, b.census[1 - e]!.texture);
      gl.uniform1i(loc(gl, P.cost, 'uDir'), e === 0 ? -1 : 1);
      this.draw(gl, P.cost, b.cost[e]!);
    }

    // 5. horizontal aggregation
    gl.useProgram(P.aggH.program);
    gl.uniform2i(loc(gl, P.aggH, 'uSize'), width, height);
    for (let e = 0; e < 2; e++) {
      this.bindTex(gl, P.aggH, 'uCost', 0, b.cost[e]!.texture);
      this.draw(gl, P.aggH, b.agg[e]!);
    }

    // 6. vertical aggregation + WTA + sub-pixel
    gl.useProgram(P.wta.program);
    gl.uniform2i(loc(gl, P.wta, 'uSize'), width, height);
    gl.uniform1i(loc(gl, P.wta, 'uTilesX'), b.tilesX);
    gl.uniform1i(loc(gl, P.wta, 'uGroups'), b.groups);
    for (let e = 0; e < 2; e++) {
      this.bindTex(gl, P.wta, 'uAgg', 0, b.agg[e]!.texture);
      this.draw(gl, P.wta, b.wta[e]!);
    }

    // 7. left-right check
    gl.useProgram(P.lr.program);
    gl.uniform2i(loc(gl, P.lr, 'uSize'), width, height);
    gl.uniform1f(loc(gl, P.lr, 'uTol'), LR_TOLERANCE_PX);
    this.bindTex(gl, P.lr, 'uL', 0, b.wta[0]!.texture);
    this.bindTex(gl, P.lr, 'uR', 1, b.wta[1]!.texture);
    this.draw(gl, P.lr, b.lr);

    // 8. median
    gl.useProgram(P.median.program);
    gl.uniform2i(loc(gl, P.median, 'uSize'), width, height);
    this.bindTex(gl, P.median, 'uD', 0, b.lr.texture);
    this.draw(gl, P.median, b.median);

    // 9. hole fill + depth
    gl.useProgram(P.final.program);
    gl.uniform2i(loc(gl, P.final, 'uSize'), width, height);
    gl.uniform1f(loc(gl, P.final, 'uFxB'), fxWork * baselineM);
    gl.uniform1f(loc(gl, P.final, 'uMinDisparity'), MIN_DISPARITY);
    gl.uniform1i(loc(gl, P.final, 'uHoleMin'), HOLE_FILL_MIN_NEIGHBOURS);
    gl.uniform1i(loc(gl, P.final, 'uPlaneRadius'), PLANE_FILL_RADIUS);
    gl.uniform1f(loc(gl, P.final, 'uPlaneMinFraction'), PLANE_FILL_MIN_VALID_FRACTION);
    gl.uniform1f(loc(gl, P.final, 'uPlaneMaxRms'), PLANE_FILL_MAX_RMS_PX);
    gl.uniform1f(loc(gl, P.final, 'uPlaneConf'), PLANE_FILL_CONFIDENCE);
    this.bindTex(gl, P.final, 'uD', 0, b.median.texture);
    this.draw(gl, P.final, b.final);

    // Single readback: (depth, confidence, disparity, 0) per pixel, row 0 = top row (no flips anywhere).
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, b.readback);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const n = width * height;
    const metric = new Float32Array(n);
    const disparity = new Float32Array(n);
    const confidence = new Float32Array(n);
    let consistent = 0;
    const rb = b.readback;
    for (let i = 0; i < n; i++) {
      const c = rb[i * 4 + 1] as number;
      metric[i] = rb[i * 4] as number;
      confidence[i] = c;
      disparity[i] = rb[i * 4 + 2] as number;
      if (c >= 1) consistent += 1;
    }
    return { metric, disparity, confidence, validFraction: n > 0 ? consistent / n : 0 };
  }

  sample(width: number, height: number, pose: Pose, fovY: number, aspect: number): DepthSample | null {
    const map = this.map;
    if (!map) return this.fallback ? this.fallback.sample(width, height, pose, fovY, aspect) : null;
    const metric = resampleDepth(map.metric, map.width, map.height, width, height);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < metric.length; i++) {
      const d = metric[i] as number;
      if (d > 0) {
        sum += d;
        n += 1;
      }
    }
    const mean = n > 0 ? sum / n : 2;
    // Triangulation error grows with Z^2: ~1% at 1 m, ~3% at 3 m for the ZED 2 at HD720.
    return { metric, source: 'stereo', confidence: map.confidence, toleranceM: Math.max(0.03, 0.01 * mean * mean) };
  }

  dispose(): void {
    const gl = this.gl;
    if (gl) {
      if (this.buffers) this.deleteBuffers(gl, this.buffers);
      if (this.maps) {
        gl.deleteTexture(this.maps.left);
        gl.deleteTexture(this.maps.right);
        this.maps = null;
      }
      if (this.programs) for (const p of Object.values(this.programs)) gl.deleteProgram(p.program);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.ownsContext) gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.programs = null;
    this.vao = null;
    this.gl = null;
    this.canvas = null;
    this.map = undefined;
    this.latestDisparity = undefined;
    this.latestConfidence = undefined;
    this.status.state = 'idle';
    this.fallback?.dispose();
  }
}

export function createStereoDepthEstimator(opts: WebGL2StereoDepthOptions): WebGL2StereoDepthEstimator {
  return new WebGL2StereoDepthEstimator(opts);
}

registerStereoDepth(createStereoDepthEstimator);
