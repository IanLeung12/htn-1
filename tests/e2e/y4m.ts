/**
 * Node-only helper to build a synthetic Y4M (uncompressed YUV4MPEG2, I420) video
 * for Chromium's `--use-file-for-fake-video-capture`, which only reads Y4M (see
 * docs/general-camera/architecture.md, "Fake camera in tests"). Used by Playwright
 * specs, never bundled into the app.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderStereoPair } from '../unit/helpers/stereo-pair';

const HEADER_PREFIX = 'YUV4MPEG2';
const FRAME_MARKER = 'FRAME\n';

function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

interface RgbToYuv {
  y: number;
  u: number;
  v: number;
}

function rgbToYuvBt601(r: number, g: number, b: number): RgbToYuv {
  const y = 16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256;
  const u = 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256;
  const v = 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256;
  return { y: clampByte(y), u: clampByte(u), v: clampByte(v) };
}

export interface EncodeY4mOptions {
  width: number;
  height: number;
  frames: number;
  fps?: number;
  paint: (frame: number, rgb: Uint8ClampedArray) => void;
}

/**
 * Encode `opts.frames` frames of planar I420 (4:2:0, BT.601 limited range) into a
 * single Y4M buffer. Width and height must be even (required for 4:2:0 chroma
 * subsampling).
 */
export function encodeY4m(opts: EncodeY4mOptions): Buffer {
  const { width, height, frames } = opts;
  const fps = opts.fps ?? 30;
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(`encodeY4m: width and height must be even (got ${width}x${height})`);
  }
  if (width <= 0 || height <= 0 || frames <= 0) {
    throw new Error('encodeY4m: width, height, and frames must be positive');
  }

  const header = `${HEADER_PREFIX} W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`;
  const headerBuf = Buffer.from(header, 'ascii');
  const frameMarkerBuf = Buffer.from(FRAME_MARKER, 'ascii');

  const ySize = width * height;
  const chromaWidth = width / 2;
  const chromaHeight = height / 2;
  const chromaSize = chromaWidth * chromaHeight;
  const frameDataSize = ySize + 2 * chromaSize;

  const totalSize = headerBuf.length + frames * (frameMarkerBuf.length + frameDataSize);
  const out = Buffer.alloc(totalSize);
  headerBuf.copy(out, 0);
  let offset = headerBuf.length;

  const rgb = new Uint8ClampedArray(width * height * 3);
  const yPlane = new Uint8Array(ySize);
  const uPlane = new Uint8Array(chromaSize);
  const vPlane = new Uint8Array(chromaSize);

  for (let frame = 0; frame < frames; frame++) {
    rgb.fill(0);
    opts.paint(frame, rgb);

    for (let cy = 0; cy < chromaHeight; cy++) {
      for (let cx = 0; cx < chromaWidth; cx++) {
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const px = cx * 2 + dx;
            const py = cy * 2 + dy;
            const idx = (py * width + px) * 3;
            rSum += rgb[idx] as number;
            gSum += rgb[idx + 1] as number;
            bSum += rgb[idx + 2] as number;
          }
        }
        const r = rSum / 4;
        const g = gSum / 4;
        const b = bSum / 4;
        const { u, v } = rgbToYuvBt601(r, g, b);
        const chromaIdx = cy * chromaWidth + cx;
        uPlane[chromaIdx] = u;
        vPlane[chromaIdx] = v;
      }
    }

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const idx = (py * width + px) * 3;
        const r = rgb[idx] as number;
        const g = rgb[idx + 1] as number;
        const b = rgb[idx + 2] as number;
        const { y } = rgbToYuvBt601(r, g, b);
        yPlane[py * width + px] = y;
      }
    }

    frameMarkerBuf.copy(out, offset);
    offset += frameMarkerBuf.length;
    Buffer.from(yPlane.buffer, yPlane.byteOffset, yPlane.byteLength).copy(out, offset);
    offset += ySize;
    Buffer.from(uPlane.buffer, uPlane.byteOffset, uPlane.byteLength).copy(out, offset);
    offset += chromaSize;
    Buffer.from(vPlane.buffer, vPlane.byteOffset, vPlane.byteLength).copy(out, offset);
    offset += chromaSize;
  }

  return out;
}

const WALL_COLOR: readonly [number, number, number] = [120, 120, 125];
const TILE_LIGHT: readonly [number, number, number] = [170, 150, 120];
const TILE_DARK: readonly [number, number, number] = [140, 120, 95];
const BOX_COLOR: readonly [number, number, number] = [200, 60, 50];

function setPixel(rgb: Uint8ClampedArray, width: number, x: number, y: number, color: readonly [number, number, number]): void {
  const idx = (y * width + x) * 3;
  rgb[idx] = color[0];
  rgb[idx + 1] = color[1];
  rgb[idx + 2] = color[2];
}

/**
 * Deterministic synthetic room: a flat grey wall over the top 45%, a
 * light/dark checkerboard floor below it whose tiles grow toward the bottom
 * (rough perspective), and a red box that drifts slowly frame to frame so
 * consecutive frames differ (needed for optical-flow / motion tests).
 */
export function paintSyntheticRoom(frame: number, width: number, height: number, rgb: Uint8ClampedArray): void {
  const horizon = Math.round(height * 0.45);
  const baseTile = Math.max(1, height / 8);

  for (let y = 0; y < height; y++) {
    if (y < horizon) {
      for (let x = 0; x < width; x++) setPixel(rgb, width, x, y, WALL_COLOR);
      continue;
    }
    const denom = height - horizon;
    const t = denom > 0 ? (y - horizon) / denom : 0;
    const tileSize = Math.max(1, baseTile * (1 + 1.2 * t));
    const tileRow = Math.floor((y - horizon) / tileSize);
    for (let x = 0; x < width; x++) {
      const tileCol = Math.floor(x / tileSize);
      const isLight = (tileRow + tileCol) % 2 === 0;
      setPixel(rgb, width, x, y, isLight ? TILE_LIGHT : TILE_DARK);
    }
  }

  const boxWidth = Math.max(1, Math.round(width * 0.18));
  const boxHeight = Math.max(1, Math.round(height * 0.22));
  const drift = Math.sin(frame / 40) * width * 0.03;
  const boxCenterX = width * 0.6 + drift;
  const boxLeft = Math.round(boxCenterX - boxWidth / 2);
  const boxBottom = height - 1;
  const boxTop = Math.max(horizon, boxBottom - boxHeight);

  for (let y = boxTop; y <= boxBottom; y++) {
    if (y < 0 || y >= height) continue;
    for (let dx = 0; dx < boxWidth; dx++) {
      const x = boxLeft + dx;
      if (x < 0 || x >= width) continue;
      setPixel(rgb, width, x, y, BOX_COLOR);
    }
  }
}

/**
 * Write `<outDir>/synthetic-room.y4m` if it does not exist or is the wrong
 * size for the requested dimensions/frame count, and return its absolute
 * path.
 */
export function ensureSyntheticY4m(
  outDir: string,
  opts?: { width?: number; height?: number; frames?: number },
): string {
  const width = opts?.width ?? 320;
  const height = opts?.height ?? 240;
  const frames = opts?.frames ?? 60;

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'synthetic-room.y4m');

  const ySize = width * height;
  const chromaSize = (width / 2) * (height / 2);
  const frameDataSize = 6 /* "FRAME\n" */ + ySize + 2 * chromaSize;
  const header = `${HEADER_PREFIX} W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`;
  const expectedSize = Buffer.byteLength(header, 'ascii') + frames * frameDataSize;

  let needsWrite = true;
  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath);
    needsWrite = stat.size !== expectedSize;
  }

  if (needsWrite) {
    const buffer = encodeY4m({
      width,
      height,
      frames,
      paint: (frame, rgb) => paintSyntheticRoom(frame, width, height, rgb),
    });
    fs.writeFileSync(outPath, buffer);
  }

  return path.resolve(outPath);
}

const STEREO_EYE_WIDTH = 672;
const STEREO_EYE_HEIGHT = 376;
const STEREO_WIDTH = STEREO_EYE_WIDTH * 2;
const STEREO_FX_PX = 264;
const STEREO_BASELINE_M = 0.12;

/**
 * Paint a ZED-style side-by-side stereo frame: the left eye of the shared
 * ray-cast scene (tests/unit/helpers/stereo-pair.ts) in the left half of
 * `width`, the right eye in the right half, for a 1344x376 Y4M (eye
 * 672x376, fx 264 px, baseline 0.12 m). The box drifts slightly by frame so
 * consecutive frames differ.
 */
export function paintSyntheticStereo(frame: number, width: number, height: number, rgb: Uint8ClampedArray): void {
  const eyeWidth = Math.floor(width / 2);
  const eyeHeight = height;
  const boxOffsetX = Math.sin(frame / 40) * 0.05;
  const { left } = renderStereoPair({
    eyeWidth,
    eyeHeight,
    fxPx: STEREO_FX_PX,
    baselineM: STEREO_BASELINE_M,
    boxOffsetX,
  });
  const right = left.right as Uint8ClampedArray;

  for (let y = 0; y < eyeHeight; y++) {
    for (let x = 0; x < eyeWidth; x++) {
      const srcIdx = (y * eyeWidth + x) * 4;
      const gL = left.rgba[srcIdx] as number;
      const gR = right[srcIdx] as number;

      const leftDst = (y * width + x) * 3;
      rgb[leftDst] = gL;
      rgb[leftDst + 1] = gL;
      rgb[leftDst + 2] = gL;

      const rightDst = (y * width + eyeWidth + x) * 3;
      rgb[rightDst] = gR;
      rgb[rightDst + 1] = gR;
      rgb[rightDst + 2] = gR;
    }
  }
}

/**
 * Write `<outDir>/synthetic-stereo.y4m` (1344x376, side-by-side ZED VGA) if
 * it does not exist or is the wrong size, and return its absolute path.
 */
export function ensureSyntheticStereoY4m(outDir: string, opts?: { frames?: number }): string {
  const width = STEREO_WIDTH;
  const height = STEREO_EYE_HEIGHT;
  const frames = opts?.frames ?? 10;

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'synthetic-stereo.y4m');

  const ySize = width * height;
  const chromaSize = (width / 2) * (height / 2);
  const frameDataSize = 6 /* "FRAME\n" */ + ySize + 2 * chromaSize;
  const header = `${HEADER_PREFIX} W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`;
  const expectedSize = Buffer.byteLength(header, 'ascii') + frames * frameDataSize;

  let needsWrite = true;
  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath);
    needsWrite = stat.size !== expectedSize;
  }

  if (needsWrite) {
    const buffer = encodeY4m({ width, height, frames, paint: (frame, rgb) => paintSyntheticStereo(frame, width, height, rgb) });
    fs.writeFileSync(outPath, buffer);
  }

  return path.resolve(outPath);
}
