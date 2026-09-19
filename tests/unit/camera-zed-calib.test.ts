import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRectifyMap, parseZedConf, rodrigues, stereoRectify } from '@/camera/stereo/zed-calib';

const CONF_PATH = fileURLToPath(new URL('../../public/zed/SN25491304.conf', import.meta.url));
const confText = readFileSync(CONF_PATH, 'utf8');

function matMul3(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[i * 3 + k] ?? 0) * (b[k * 3 + j] ?? 0);
      out[i * 3 + j] = sum;
    }
  }
  return out;
}

function transpose3(a: readonly number[]): number[] {
  return [a[0] ?? 0, a[3] ?? 0, a[6] ?? 0, a[1] ?? 0, a[4] ?? 0, a[7] ?? 0, a[2] ?? 0, a[5] ?? 0, a[8] ?? 0];
}

function det3(a: readonly number[]): number {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0, a[6] ?? 0, a[7] ?? 0, a[8] ?? 0];
  return a0 * (a4 * a8 - a5 * a7) - a1 * (a3 * a8 - a5 * a6) + a2 * (a3 * a7 - a4 * a6);
}

describe('parseZedConf', () => {
  const calib = parseZedConf(confText, '25491304');

  it('reads the baseline (mm -> m)', () => {
    const rawBaselineLine = confText.match(/Baseline=([\d.]+)/);
    expect(rawBaselineLine).not.toBeNull();
    const rawBaselineMm = Number(rawBaselineLine![1]);
    expect(calib.baselineM).toBeCloseTo(rawBaselineMm / 1000, 9);
    expect(calib.baselineM).toBeCloseTo(0.12, 2);
  });

  it('reads HD (HD720) left intrinsics', () => {
    const hd = calib.modes.hd720;
    expect(hd).toBeDefined();
    expect(hd!.left.fx).toBeCloseTo(533.855, 3);
  });

  it('reads VGA with the right per-eye size', () => {
    const vga = calib.modes.vga;
    expect(vga).toBeDefined();
    expect(vga!.width).toBe(672);
    expect(vga!.height).toBe(376);
  });

  it('serial passthrough', () => {
    expect(calib.serial).toBe('25491304');
  });
});

describe('rodrigues', () => {
  it('maps the zero vector to the identity', () => {
    const R = rodrigues(0, 0, 0);
    for (let i = 0; i < 9; i++) {
      const expected = i % 4 === 0 ? 1 : 0;
      expect(R[i]).toBeCloseTo(expected, 9);
    }
  });

  it('approximates the skew-symmetric matrix for a small angle', () => {
    const eps = 1e-4;
    const R = rodrigues(eps, 0, 0);
    // Rotation about x by a small angle: y'=y*cos-z*sin, z'=y*sin+z*cos ~= I + [r]x.
    expect(R[0]).toBeCloseTo(1, 6);
    expect(R[5]).toBeCloseTo(-eps, 6); // -sin(eps) ~= -eps
    expect(R[7]).toBeCloseTo(eps, 6); // sin(eps) ~= eps
  });

  it('produces a proper rotation matrix for an arbitrary vector', () => {
    const R = rodrigues(0.3, -0.2, 0.1);
    const Rt = transpose3(R);
    const shouldBeIdentity = matMul3(R, Rt);
    for (let i = 0; i < 9; i++) expect(shouldBeIdentity[i]).toBeCloseTo(i % 4 === 0 ? 1 : 0, 6);
    expect(det3(R)).toBeCloseTo(1, 6);
  });
});

describe('stereoRectify (HD mode of the shipped ZED 2 calibration)', () => {
  const calib = parseZedConf(confText, '25491304');
  const hd = calib.modes.hd720!;
  const R = rodrigues(hd.rx, hd.cv, hd.rz);
  const T: [number, number, number] = [-calib.baselineM, calib.ty, calib.tz];
  const result = stereoRectify(hd.left, hd.right, R, T, hd.width, hd.height);

  function assertProperRotation(M: readonly number[]): void {
    const Mt = transpose3(M);
    const shouldBeIdentity = matMul3(M, Mt);
    for (let i = 0; i < 9; i++) expect(shouldBeIdentity[i]).toBeCloseTo(i % 4 === 0 ? 1 : 0, 6);
    expect(det3(M)).toBeCloseTo(1, 6);
  }

  it('R1 and R2 are proper (orthonormal, det=1) rotations', () => {
    assertProperRotation(result.R1);
    assertProperRotation(result.R2);
  });

  it('P1 and P2 share one rectified focal length and principal point', () => {
    expect(result.P1[0]).toBeCloseTo(result.fxRect, 9);
    expect(result.P2[0]).toBeCloseTo(result.fxRect, 9);
    expect(result.P1[2]).toBeCloseTo(result.cxRect, 9);
    expect(result.P2[2]).toBeCloseTo(result.cxRect, 9);
    expect(result.P1[6]).toBeCloseTo(result.cyRect, 9);
    expect(result.P2[6]).toBeCloseTo(result.cyRect, 9);
  });

  it("P2's x-translation term is -fxRect * baseline (near objects get positive disparity xLeft - xRight)", () => {
    // baseline used for P2 is |T| (rotation preserves the vector's norm), which
    // is ~= calib.baselineM since TY/TZ are tiny relative to the baseline.
    const baseline = Math.sqrt(T[0] * T[0] + T[1] * T[1] + T[2] * T[2]);
    expect(result.P2[3]).toBeCloseTo(-result.fxRect * baseline, 6);
    expect(baseline).toBeCloseTo(calib.baselineM, 4);
  });

  it('buildRectifyMap: image centre maps close to itself (small correction only)', () => {
    const leftMap = buildRectifyMap(hd.left, result.R1, result.P1, hd.width, hd.height);
    const cx = Math.round(hd.width / 2);
    const cy = Math.round(hd.height / 2);
    const idx = 2 * (cy * hd.width + cx);
    const sx = leftMap[idx]!;
    const sy = leftMap[idx + 1]!;
    expect(Number.isFinite(sx)).toBe(true);
    expect(Number.isFinite(sy)).toBe(true);
    expect(Math.abs(sx - cx)).toBeLessThan(30);
    expect(Math.abs(sy - cy)).toBeLessThan(30);
  });

  it('buildRectifyMap is finite everywhere on a coarse grid', () => {
    const rightMap = buildRectifyMap(hd.right, result.R2, result.P2, hd.width, hd.height);
    for (let y = 0; y < hd.height; y += 40) {
      for (let x = 0; x < hd.width; x += 40) {
        const idx = 2 * (y * hd.width + x);
        expect(Number.isFinite(rightMap[idx])).toBe(true);
        expect(Number.isFinite(rightMap[idx + 1])).toBe(true);
      }
    }
  });

  it('a far scene point projects to nearly the same rectified row in both eyes', () => {
    // Project a synthetic far point (50m, roughly centred) through the ORIGINAL
    // (unrectified) left and right cameras using the calibration's own R, T,
    // then rectify each 2D projection by composing with each eye's own
    // rectifying rotation + rectified projection matrix. Rectification's job
    // is exactly to make these two rectified rows agree (epipolar lines are
    // horizontal), so |dv| should be tiny regardless of depth.
    const depth = 50; // metres
    const worldLeft: [number, number, number] = [0.02, 0.01, depth]; // near the left camera's optical axis

    // World point in the right camera's frame: X_right = R*X_left + T (see zed-calib.ts header).
    const worldRight: [number, number, number] = [
      (R[0] ?? 0) * worldLeft[0] + (R[1] ?? 0) * worldLeft[1] + (R[2] ?? 0) * worldLeft[2] + T[0],
      (R[3] ?? 0) * worldLeft[0] + (R[4] ?? 0) * worldLeft[1] + (R[5] ?? 0) * worldLeft[2] + T[1],
      (R[6] ?? 0) * worldLeft[0] + (R[7] ?? 0) * worldLeft[1] + (R[8] ?? 0) * worldLeft[2] + T[2],
    ];

    function rectifiedRow(worldInOriginalCam: [number, number, number], Rn: readonly number[], P: readonly number[]): number {
      // Rotate the (undistorted, pinhole) ray into the rectified frame: X_rect = Rn * X_original.
      const xr = (Rn[0] ?? 0) * worldInOriginalCam[0] + (Rn[1] ?? 0) * worldInOriginalCam[1] + (Rn[2] ?? 0) * worldInOriginalCam[2];
      const yr = (Rn[3] ?? 0) * worldInOriginalCam[0] + (Rn[4] ?? 0) * worldInOriginalCam[1] + (Rn[5] ?? 0) * worldInOriginalCam[2];
      const zr = (Rn[6] ?? 0) * worldInOriginalCam[0] + (Rn[7] ?? 0) * worldInOriginalCam[1] + (Rn[8] ?? 0) * worldInOriginalCam[2];
      const fy = P[5] ?? 1;
      const cy = P[6] ?? 0;
      return (fy * yr) / zr + cy;
    }

    const vLeft = rectifiedRow(worldLeft, result.R1, result.P1);
    const vRight = rectifiedRow(worldRight, result.R2, result.P2);
    expect(Math.abs(vLeft - vRight)).toBeLessThan(0.5);
  });
});
