/**
 * ZED 2 factory calibration: parsing the `.conf` file Stereolabs ships per
 * unit (public/zed/SN<serial>.conf, or fetched live from calib.stereolabs.com),
 * plus pure-math stereo rectification (Rodrigues, OpenCV-style stereoRectify,
 * and initUndistortRectifyMap) with no OpenCV dependency. No DOM here; the
 * frame-source (zed-frame-source.ts) is the only consumer that touches the
 * browser.
 *
 * ZED calibration conventions used throughout this file:
 *  - Distances in the .conf file (Baseline, TY, TZ) are millimetres; we
 *    convert to metres immediately on parse.
 *  - RX_<res>/CV_<res>/RZ_<res> are the components of a Rodrigues rotation
 *    vector (radians) describing the rotation FROM the left camera frame TO
 *    the right camera frame: X_right = R * X_left + T, with
 *    R = rodrigues(RX, CV, RZ) and T = [-baselineM, TY_m, TZ_m]. CV is the
 *    vector's Y component (Stereolabs' naming, not ours).
 *  - Disparity convention after rectification: with the left camera as the
 *    rectified-frame origin and the right camera at +baseline along the
 *    rectified X axis, xLeft - xRight = fxRect * baseline / Z > 0 for any
 *    point in front of both cameras, i.e. disparity is POSITIVE and shrinks
 *    with depth (near objects have larger disparity). P2's x-translation
 *    term is therefore -fxRect * baseline (see stereoRectify below).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CameraIntrinsicsCalib {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  k3: number;
  p1: number;
  p2: number;
}

export type ZedResolution = 'vga' | 'hd720' | 'hd1080' | '2k';

export interface ZedModeCalibration {
  left: CameraIntrinsicsCalib;
  right: CameraIntrinsicsCalib;
  /** Rodrigues rotation vector components (radians) for this resolution, left-to-right. */
  rx: number;
  cv: number;
  rz: number;
  /** Per-eye frame size at this resolution. */
  width: number;
  height: number;
}

export interface ZedCalibration {
  serial: string | null;
  /** Baseline (metres), converted from the .conf file's millimetres. */
  baselineM: number;
  /** Y/Z translation components (metres), converted from millimetres. */
  ty: number;
  tz: number;
  modes: Record<ZedResolution, ZedModeCalibration | undefined>;
}

// ---------------------------------------------------------------------------
// .conf parsing
// ---------------------------------------------------------------------------

/** Per-eye frame sizes (px) for each ZED 2 stereo mode. */
const EYE_SIZES: Record<ZedResolution, { width: number; height: number }> = {
  vga: { width: 672, height: 376 },
  hd720: { width: 1280, height: 720 },
  hd1080: { width: 1920, height: 1080 },
  '2k': { width: 2208, height: 1242 },
};

/** Section-name suffix used by the .conf file for each resolution. */
const SECTION_SUFFIX: Record<ZedResolution, string> = {
  vga: 'VGA',
  hd720: 'HD',
  hd1080: 'FHD',
  '2k': '2K',
};

type IniSections = Record<string, Record<string, string>>;

function parseIni(text: string): IniSections {
  const sections: IniSections = {};
  let current: Record<string, string> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1] ?? '';
      current = {};
      sections[name] = current;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !current) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    current[key] = value;
  }
  return sections;
}

function num(section: Record<string, string> | undefined, key: string): number | undefined {
  const raw = section?.[key];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseIntrinsics(section: Record<string, string> | undefined): CameraIntrinsicsCalib | undefined {
  if (!section) return undefined;
  const fx = num(section, 'fx');
  const fy = num(section, 'fy');
  const cx = num(section, 'cx');
  const cy = num(section, 'cy');
  const k1 = num(section, 'k1');
  const k2 = num(section, 'k2');
  const k3 = num(section, 'k3');
  const p1 = num(section, 'p1');
  const p2 = num(section, 'p2');
  if (
    fx === undefined || fy === undefined || cx === undefined || cy === undefined ||
    k1 === undefined || k2 === undefined || k3 === undefined || p1 === undefined || p2 === undefined
  ) {
    return undefined;
  }
  return { fx, fy, cx, cy, k1, k2, k3, p1, p2 };
}

/** Parse a Stereolabs ZED `.conf` factory calibration file (INI format). */
export function parseZedConf(text: string, serial?: string): ZedCalibration {
  const sections = parseIni(text);
  const stereo = sections['STEREO'];
  const baselineMm = num(stereo, 'Baseline') ?? 0;
  const tyMm = num(stereo, 'TY') ?? 0;
  const tzMm = num(stereo, 'TZ') ?? 0;

  const modes = {} as Record<ZedResolution, ZedModeCalibration | undefined>;
  for (const res of Object.keys(EYE_SIZES) as ZedResolution[]) {
    const suffix = SECTION_SUFFIX[res];
    const left = parseIntrinsics(sections[`LEFT_CAM_${suffix}`]);
    const right = parseIntrinsics(sections[`RIGHT_CAM_${suffix}`]);
    const rx = num(stereo, `RX_${suffix}`);
    const cv = num(stereo, `CV_${suffix}`);
    const rz = num(stereo, `RZ_${suffix}`);
    if (!left || !right || rx === undefined || cv === undefined || rz === undefined) {
      modes[res] = undefined;
      continue;
    }
    const { width, height } = EYE_SIZES[res];
    modes[res] = { left, right, rx, cv, rz, width, height };
  }

  return {
    serial: serial ?? null,
    baselineM: baselineMm / 1000,
    ty: tyMm / 1000,
    tz: tzMm / 1000,
    modes,
  };
}

/**
 * Fetch and parse the ZED calibration for `serial`, trying (in order):
 * the app's own `public/zed/SN<serial>.conf`, Stereolabs' calibration
 * server directly, then the dev-server proxy (see vite.config.ts, needed
 * because calib.stereolabs.com does not send CORS headers). Never throws;
 * returns null when every source fails (offline, unknown serial, etc.).
 */
export async function loadZedCalibration(serial: string, fetchImpl: typeof fetch = fetch): Promise<ZedCalibration | null> {
  const urls = [`/zed/SN${serial}.conf`, `https://calib.stereolabs.com/?SN=${serial}`, `/zed-calib?sn=${serial}`];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || !text.includes('[STEREO]')) continue;
      return parseZedConf(text, serial);
    } catch {
      // try the next source
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rodrigues rotation
// ---------------------------------------------------------------------------

/** Rodrigues' rotation formula: angle-axis vector (radians) -> row-major 3x3 rotation matrix. */
export function rodrigues(rx: number, ry: number, rz: number): number[] {
  const theta = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (theta < 1e-12) {
    // First-order approximation: R ~= I + [r]x for tiny rotations.
    return [1, -rz, ry, rz, 1, -rx, -ry, rx, 1];
  }
  const ux = rx / theta;
  const uy = ry / theta;
  const uz = rz / theta;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  return [
    t * ux * ux + c, t * ux * uy - s * uz, t * ux * uz + s * uy,
    t * ux * uy + s * uz, t * uy * uy + c, t * uy * uz - s * ux,
    t * ux * uz - s * uy, t * uy * uz + s * ux, t * uz * uz + c,
  ];
}

/** Inverse of `rodrigues`: row-major 3x3 rotation matrix -> angle-axis vector (radians). */
function rotationMatrixToVector(R: readonly number[]): [number, number, number] {
  const r0 = R[0] ?? 0, r1 = R[1] ?? 0, r2 = R[2] ?? 0;
  const r3 = R[3] ?? 0, r4 = R[4] ?? 0, r5 = R[5] ?? 0;
  const r6 = R[6] ?? 0, r7 = R[7] ?? 0, r8 = R[8] ?? 0;
  const trace = r0 + r4 + r8;
  const cosTheta = Math.min(1, Math.max(-1, (trace - 1) / 2));
  const theta = Math.acos(cosTheta);
  if (theta < 1e-8) {
    // Near-identity: axis*theta ~= vee(R - R^T) / 2.
    return [(r7 - r5) / 2, (r2 - r6) / 2, (r3 - r1) / 2];
  }
  const s = Math.sin(theta);
  const ax = (r7 - r5) / (2 * s);
  const ay = (r2 - r6) / (2 * s);
  const az = (r3 - r1) / (2 * s);
  return [ax * theta, ay * theta, az * theta];
}

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

function matTranspose3(a: readonly number[]): number[] {
  return [a[0] ?? 0, a[3] ?? 0, a[6] ?? 0, a[1] ?? 0, a[4] ?? 0, a[7] ?? 0, a[2] ?? 0, a[5] ?? 0, a[8] ?? 0];
}

function matVec3(a: readonly number[], v: readonly [number, number, number]): [number, number, number] {
  return [
    (a[0] ?? 0) * v[0] + (a[1] ?? 0) * v[1] + (a[2] ?? 0) * v[2],
    (a[3] ?? 0) * v[0] + (a[4] ?? 0) * v[1] + (a[5] ?? 0) * v[2],
    (a[6] ?? 0) * v[0] + (a[7] ?? 0) * v[1] + (a[8] ?? 0) * v[2],
  ];
}

function cross3(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm3(v: readonly [number, number, number]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function normalize3(v: readonly [number, number, number]): [number, number, number] {
  const n = norm3(v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

// ---------------------------------------------------------------------------
// Stereo rectification
// ---------------------------------------------------------------------------

export interface StereoRectifyResult {
  /** Rectifying rotation for the left camera (rectified = R1 * original-left-ray). */
  R1: number[];
  /** Rectifying rotation for the right camera (rectified = R2 * original-right-ray). */
  R2: number[];
  /** Rectified LEFT projection, 3x4 row-major. */
  P1: number[];
  /** Rectified RIGHT projection, 3x4 row-major; P2[3] = -fxRect * baseline (see file header). */
  P2: number[];
  fxRect: number;
  cxRect: number;
  cyRect: number;
}

/**
 * Standard (OpenCV `stereoRectify`-equivalent, alpha=0/"keep everything",
 * no valid-ROI cropping) planar stereo rectification.
 *
 * `R`, `T` map left camera coordinates to right camera coordinates:
 * X_right = R * X_left + T (T in the same units as the returned baseline,
 * here metres). Both cameras are rotated by "half" of R, in opposite
 * directions, so the rectified frame sits symmetrically between them (this
 * is what OpenCV's cvStereoRectify does, rather than only rotating one eye,
 * so neither eye is favoured for FOV / distortion purposes).
 */
export function stereoRectify(
  left: CameraIntrinsicsCalib,
  right: CameraIntrinsicsCalib,
  R: number[],
  T: [number, number, number],
  _width: number,
  _height: number,
): StereoRectifyResult {
  const om = rotationMatrixToVector(R);
  const halfNeg: [number, number, number] = [-om[0] / 2, -om[1] / 2, -om[2] / 2];
  // Rotate the right camera by -om/2 ...
  const RhalfRight = rodrigues(halfNeg[0], halfNeg[1], halfNeg[2]);
  // ... and the left camera by +om/2 (its transpose, since rodrigues(-v) == rodrigues(v)^T).
  const RhalfLeft = matTranspose3(RhalfRight);

  // Rotate T into the shared halfway frame to find the new baseline direction.
  const tHalf = matVec3(RhalfRight, T);
  // New x axis along the baseline, with the sign chosen so it points the same way as the
  // original +x (OpenCV's `uu[idx] = c > 0 ? 1 : -1`): T = [-baseline, ...] points to -x, and
  // using it unsigned rotates both rectified images by 180 degrees (disparity sign flips,
  // depth map upside down against the displayed eye).
  const e = normalize3(tHalf[0] < 0 ? [-tHalf[0], -tHalf[1], -tHalf[2]] : tHalf);
  const zAxis: [number, number, number] = [0, 0, 1];
  let e2 = cross3(zAxis, e);
  if (norm3(e2) < 1e-9) e2 = [0, 1, 0]; // baseline parallel to z (degenerate for a horizontal stereo rig)
  e2 = normalize3(e2);
  const e3 = cross3(e, e2);
  const Rrect = [e[0], e[1], e[2], e2[0], e2[1], e2[2], e3[0], e3[1], e3[2]];

  const R1 = matMul3(Rrect, RhalfLeft);
  const R2 = matMul3(Rrect, RhalfRight);

  // alpha=0 style: keep the full field of view, share one focal length and
  // principal point between eyes so disparity is a pure horizontal shift.
  const fxRect = (left.fx + right.fx) / 2;
  const fyRect = fxRect;
  const cxRect = (left.cx + right.cx) / 2;
  const cyRect = (left.cy + right.cy) / 2;
  const baseline = norm3(tHalf);

  const P1 = [fxRect, 0, cxRect, 0, 0, fyRect, cyRect, 0, 0, 0, 1, 0];
  // See file header: xLeft - xRight = fxRect*baseline/Z > 0, so the right
  // projection's x-translation term is negative.
  const P2 = [fxRect, 0, cxRect, -fxRect * baseline, 0, fyRect, cyRect, 0, 0, 0, 1, 0];

  return { R1, R2, P1, P2, fxRect, cxRect, cyRect };
}

/**
 * Build an `initUndistortRectifyMap`-equivalent lookup: for every pixel of
 * the RECTIFIED `width x height` image, the (sx, sy) pixel to sample from
 * the ORIGINAL (distorted, unrectified) camera image. Two floats per pixel,
 * row-major: `map[2*(y*width+x)] = sx`, `[...+1] = sy`. Coordinates outside
 * [0,width)x[0,height) are left as-is (the sampler is expected to clamp).
 */
export function buildRectifyMap(cam: CameraIntrinsicsCalib, Rn: number[], P: number[], width: number, height: number): Float32Array {
  const fxRect = P[0] ?? 1;
  const fyRect = P[5] ?? 1;
  const cxRect = P[2] ?? 0;
  const cyRect = P[6] ?? 0;
  const RnT = matTranspose3(Rn);
  const out = new Float32Array(width * height * 2);

  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const xr = (u - cxRect) / fxRect;
      const yr = (v - cyRect) / fyRect;
      // Back-project the rectified ray into the original (unrectified) camera frame.
      const dir = matVec3(RnT, [xr, yr, 1]);
      const z = dir[2] === 0 ? 1e-12 : dir[2];
      const x = dir[0] / z;
      const y = dir[1] / z;

      // OpenCV Brown-Conrady distortion.
      const r2 = x * x + y * y;
      const radial = 1 + cam.k1 * r2 + cam.k2 * r2 * r2 + cam.k3 * r2 * r2 * r2;
      const xd = x * radial + 2 * cam.p1 * x * y + cam.p2 * (r2 + 2 * x * x);
      const yd = y * radial + cam.p1 * (r2 + 2 * y * y) + 2 * cam.p2 * x * y;

      const sx = cam.fx * xd + cam.cx;
      const sy = cam.fy * yd + cam.cy;
      const idx = 2 * (v * width + u);
      out[idx] = sx;
      out[idx + 1] = sy;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nominal (uncalibrated) stereo parameters
// ---------------------------------------------------------------------------

const NOMINAL_FX_PX: Record<ZedResolution, number> = {
  vga: 264,
  hd720: 528,
  hd1080: 1055,
  '2k': 1067,
};

const NOMINAL_BASELINE_M = 0.12;

/** Manufacturer-nominal (not factory-calibrated) stereo parameters for a ZED 2 mode. */
export function nominalStereo(mode: ZedResolution): { fxPx: number; baselineM: number; width: number; height: number } {
  const { width, height } = EYE_SIZES[mode];
  return { fxPx: NOMINAL_FX_PX[mode], baselineM: NOMINAL_BASELINE_M, width, height };
}
