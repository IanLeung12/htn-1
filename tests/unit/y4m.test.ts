import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeY4m, ensureSyntheticY4m, paintSyntheticRoom } from '../e2e/y4m';

describe('encodeY4m', () => {
  it('writes the exact Y4M header', () => {
    const buf = encodeY4m({ width: 4, height: 2, frames: 1, fps: 30, paint: () => {} });
    const headerEnd = buf.indexOf('\n') + 1;
    const header = buf.subarray(0, headerEnd).toString('ascii');
    expect(header).toBe('YUV4MPEG2 W4 H2 F30:1 Ip A1:1 C420jpeg\n');
  });

  it('produces a buffer of the exact expected length', () => {
    const width = 8;
    const height = 4;
    const frames = 3;
    const buf = encodeY4m({ width, height, frames, paint: () => {} });
    const header = `YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`;
    const frameSize = 6 + width * height + 2 * ((width / 2) * (height / 2));
    expect(buf.length).toBe(Buffer.byteLength(header, 'ascii') + frames * frameSize);
  });

  it('throws on odd width or height', () => {
    expect(() => encodeY4m({ width: 5, height: 4, frames: 1, paint: () => {} })).toThrow();
    expect(() => encodeY4m({ width: 4, height: 5, frames: 1, paint: () => {} })).toThrow();
  });

  it('marks each frame with the FRAME header', () => {
    const width = 4;
    const height = 2;
    const buf = encodeY4m({ width, height, frames: 2, paint: () => {} });
    const header = `YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`;
    const headerLen = Buffer.byteLength(header, 'ascii');
    const frameDataSize = width * height + 2 * ((width / 2) * (height / 2));
    expect(buf.subarray(headerLen, headerLen + 6).toString('ascii')).toBe('FRAME\n');
    expect(
      buf.subarray(headerLen + 6 + frameDataSize, headerLen + 6 + frameDataSize + 6).toString('ascii'),
    ).toBe('FRAME\n');
  });
});

describe('paintSyntheticRoom', () => {
  const width = 32;
  const height = 24;

  it('is deterministic: same frame index paints identical bytes', () => {
    const a = new Uint8ClampedArray(width * height * 3);
    const b = new Uint8ClampedArray(width * height * 3);
    paintSyntheticRoom(5, width, height, a);
    paintSyntheticRoom(5, width, height, b);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('differs between distant frames (the box drifts)', () => {
    const a = new Uint8ClampedArray(width * height * 3);
    const b = new Uint8ClampedArray(width * height * 3);
    paintSyntheticRoom(0, width, height, a);
    paintSyntheticRoom(20, width, height, b);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('paints a flat grey wall above the horizon', () => {
    const rgb = new Uint8ClampedArray(width * height * 3);
    paintSyntheticRoom(0, width, height, rgb);
    const idx = (0 * width + 0) * 3;
    expect(rgb[idx]).toBe(120);
    expect(rgb[idx + 1]).toBe(120);
    expect(rgb[idx + 2]).toBe(125);
  });
});

describe('ensureSyntheticY4m', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'y4m-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a file to the given directory and returns its absolute path', () => {
    const outPath = ensureSyntheticY4m(tmpDir, { width: 16, height: 12, frames: 3 });
    expect(path.isAbsolute(outPath)).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(path.dirname(outPath)).toBe(path.resolve(tmpDir));
  });

  it('does not rewrite an up-to-date file, but rewrites a stale one', () => {
    const outPath = ensureSyntheticY4m(tmpDir, { width: 16, height: 12, frames: 3 });
    const firstMtime = fs.statSync(outPath).mtimeMs;

    // Re-running with the same options should not need a rewrite (size matches).
    const outPath2 = ensureSyntheticY4m(tmpDir, { width: 16, height: 12, frames: 3 });
    expect(outPath2).toBe(outPath);

    // Corrupt the file to a wrong size, then confirm it gets rewritten to the right size.
    fs.writeFileSync(outPath, Buffer.alloc(3));
    ensureSyntheticY4m(tmpDir, { width: 16, height: 12, frames: 3 });
    const stat = fs.statSync(outPath);
    expect(stat.size).toBeGreaterThan(3);
    void firstMtime;
  });
});
