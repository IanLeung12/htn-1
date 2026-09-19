import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderStereoPair } from './helpers/stereo-pair';
import { stereoDepthCpu } from '@/camera/stereo/census';
import { paintSyntheticStereo, ensureSyntheticStereoY4m } from '../e2e/y4m';
import type { GrabbedFrame } from '@/camera/contract';

const EYE_W = 336;
const EYE_H = 188;
const FX = 132;
const BASELINE = 0.12;
const MAX_DISPARITY = 32;

function darken(rgba: Uint8ClampedArray, factor: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = Math.round((rgba[i] as number) * factor);
    out[i + 1] = Math.round((rgba[i + 1] as number) * factor);
    out[i + 2] = Math.round((rgba[i + 2] as number) * factor);
    out[i + 3] = rgba[i + 3] as number;
  }
  return out;
}

/** Shift `rgba` down by `rows`, replicating the top edge into the vacated rows. */
function shiftDown(rgba: Uint8ClampedArray, w: number, h: number, rows: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < h; y++) {
    const srcY = Math.max(0, y - rows);
    const srcRow = srcY * w * 4;
    const dstRow = y * w * 4;
    out.set(rgba.subarray(srcRow, srcRow + w * 4), dstRow);
  }
  return out;
}

function relErrorStats(metric: Float32Array, valid: Uint8Array, truth: Float32Array, minM: number, maxM: number): { median: number; p90: number; count: number } {
  const errs: number[] = [];
  for (let i = 0; i < metric.length; i++) {
    if (!valid[i]) continue;
    const t = truth[i] as number;
    if (!(t >= minM && t <= maxM)) continue;
    const m = metric[i] as number;
    if (!(m > 0)) continue;
    errs.push(Math.abs(m - t) / t);
  }
  errs.sort((a, b) => a - b);
  const median = errs.length ? (errs[Math.floor(errs.length / 2)] as number) : Infinity;
  const p90 = errs.length ? (errs[Math.min(errs.length - 1, Math.floor(errs.length * 0.9))] as number) : Infinity;
  return { median, p90, count: errs.length };
}

describe('stereo census CPU pipeline', () => {
  const pair = renderStereoPair({ eyeWidth: EYE_W, eyeHeight: EYE_H, fxPx: FX, baselineM: BASELINE });
  const result = stereoDepthCpu(pair.left, pair.left.right as Uint8ClampedArray, {
    fxPx: FX,
    baselineM: BASELINE,
    maxDisparity: MAX_DISPARITY,
  });

  it('recovers depth over most of the frame', () => {
    expect(result.validFraction).toBeGreaterThan(0.6);
  });

  it('is accurate (median <3%, p90 <8%) over valid 1-3m pixels', () => {
    const stats = relErrorStats(result.metric, result.valid, pair.truthDepth, 1, 3);
    expect(stats.count).toBeGreaterThan(50);
    expect(stats.median).toBeLessThan(0.03);
    expect(stats.p90).toBeLessThan(0.08);
  });

  it('resolves the box to roughly its true depth (~1.9-2.1 m)', () => {
    const boxDepths: number[] = [];
    for (let i = 0; i < result.metric.length; i++) {
      if (!result.valid[i]) continue;
      const t = pair.truthDepth[i] as number;
      if (t >= 1.85 && t <= 2.15) {
        const m = result.metric[i] as number;
        if (m > 0) boxDepths.push(m);
      }
    }
    expect(boxDepths.length).toBeGreaterThan(20);
    boxDepths.sort((a, b) => a - b);
    const median = boxDepths[Math.floor(boxDepths.length / 2)] as number;
    expect(median).toBeGreaterThan(1.9);
    expect(median).toBeLessThan(2.1);
  });

  it('is unaffected by the left/right exposure difference (row equalisation)', () => {
    const darkenedRight = darken(pair.left.right as Uint8ClampedArray, 0.7);
    const darkenedResult = stereoDepthCpu(pair.left, darkenedRight, { fxPx: FX, baselineM: BASELINE, maxDisparity: MAX_DISPARITY });

    let sumAbsRelDiff = 0;
    let n = 0;
    for (let i = 0; i < result.metric.length; i++) {
      if (!result.valid[i] || !darkenedResult.valid[i]) continue;
      const a = result.metric[i] as number;
      const b = darkenedResult.metric[i] as number;
      if (!(a > 0) || !(b > 0)) continue;
      sumAbsRelDiff += Math.abs(a - b) / a;
      n++;
    }
    expect(n).toBeGreaterThan(50);
    // Within ~1% modulo 8-bit rounding noise from darkening+re-equalising the row means.
    expect(sumAbsRelDiff / n).toBeLessThan(0.02);
  });

  it('recovers depth with rowSearch when the right eye is vertically misaligned by 1 row', () => {
    const shiftedRight = shiftDown(pair.left.right as Uint8ClampedArray, EYE_W, EYE_H, 1);
    const shiftedResult = stereoDepthCpu(pair.left, shiftedRight, {
      fxPx: FX,
      baselineM: BASELINE,
      maxDisparity: MAX_DISPARITY,
      rowSearch: 1,
    });
    const stats = relErrorStats(shiftedResult.metric, shiftedResult.valid, pair.truthDepth, 1, 3);
    expect(stats.count).toBeGreaterThan(30);
    expect(stats.median).toBeLessThan(0.04);
  });
});

describe('paintSyntheticStereo / ensureSyntheticStereoY4m', () => {
  it('paints distinct left and right halves', () => {
    const width = 1344;
    const height = 376;
    const rgb = new Uint8ClampedArray(width * height * 3);
    paintSyntheticStereo(0, width, height, rgb);

    const eyeWidth = width / 2;
    let leftSum = 0;
    let rightSum = 0;
    let diffCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < eyeWidth; x++) {
        const l = rgb[(y * width + x) * 3] as number;
        const r = rgb[(y * width + eyeWidth + x) * 3] as number;
        leftSum += l;
        rightSum += r;
        if (l !== r) diffCount++;
      }
    }
    expect(leftSum).toBeGreaterThan(0);
    expect(rightSum).toBeGreaterThan(0);
    // Left is rendered dimmer (x0.8) and from a different viewpoint, so most pixels differ.
    expect(diffCount).toBeGreaterThan((width * height) / 4);
    expect(rightSum).toBeGreaterThan(leftSum);
  });

  it('writes a synthetic-stereo.y4m of the expected size', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-y4m-'));
    try {
      const outPath = ensureSyntheticStereoY4m(outDir, { frames: 3 });
      expect(fs.existsSync(outPath)).toBe(true);
      expect(path.basename(outPath)).toBe('synthetic-stereo.y4m');

      const width = 1344;
      const height = 376;
      const ySize = width * height;
      const chromaSize = (width / 2) * (height / 2);
      const frameDataSize = 6 + ySize + 2 * chromaSize;
      const header = `YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`;
      const expectedSize = Buffer.byteLength(header, 'ascii') + 3 * frameDataSize;

      const stat = fs.statSync(outPath);
      expect(stat.size).toBe(expectedSize);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// Sanity: GrabbedFrame's `right` field is what stereoDepthCpu expects as its second argument.
function _typeCheck(frame: GrabbedFrame): void {
  if (frame.right) void stereoDepthCpu(frame, frame.right, { fxPx: 1, baselineM: 1, maxDisparity: 1 });
}
void _typeCheck;
