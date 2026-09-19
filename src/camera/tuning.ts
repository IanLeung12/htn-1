/**
 * Live-tunable parameters for the camera backend, adjustable while pointing
 * a real camera at a room (see docs/general-camera/architecture.md). Pure TS
 * except for the localStorage adapter, which is feature-detected and never
 * throws (private browsing, quota, disabled storage). Exposed to the owner
 * as `window.__camera.tuning` and edited through `TuningPanel`.
 */

export interface CameraTuning {
  /** Camera height above the floor, metres (see pose/static.ts). */
  cameraHeightM: number;
  /** Pitch in degrees; negative looks down. */
  pitchDeg: number;
  /** Vertical field of view, degrees. */
  fovYDeg: number;
  /** Multiplier applied to the fitted metric depth. */
  depthScale: number;
  /** Metres added to the fitted metric depth after scaling. */
  depthShiftM: number;
  /** EMA weight (0..1) on the previous depth map. */
  depthSmoothing: number;
  /** RANSAC inlier distance threshold, metres (see surfaces/ransac.ts). */
  ransacThresholdM: number;
  /** RANSAC iteration count. */
  ransacIterations: number;
  /** Minimum inlier count for a plane to be accepted. */
  planeMinInliers: number;
  /** Smallest larger-side extent, metres, for a horizontal plane to count as a surface rather than an object top. */
  planeMinExtentM: number;
  /** Cluster grid cell size, metres (see surfaces/ransac.ts clusterAbovePlane). */
  clusterCellM: number;
  /** Minimum point count for a cluster to become a volume. */
  clusterMinCount: number;
  /** Minimum height above the support plane for a point to be clustered, metres. */
  clusterMinHeightM: number;
  /** Largest side, metres, a detected volume's AABB may have. */
  volumeMaxSideM: number;
  /** Minimum time between surface-estimation (RANSAC) runs, ms. */
  surfaceIntervalMs: number;
  /** Pixel stride used when building the depth point cloud. */
  pointStride: number;
  /** 1 = estimate camera pitch/roll from the dominant depth plane; 0 = keep pitchDeg. */
  autoAttitude: number;
  /** Two-point metric anchors (video UV 0..1 and metres); a distance of 0 = unset. */
  anchorNearU: number;
  anchorNearV: number;
  anchorNearM: number;
  anchorFarU: number;
  anchorFarV: number;
  anchorFarM: number;
  /** Stereo: multiplier on the calibrated/nominal focal length (single-point distance calibration). */
  stereoFxScale: number;
  /** 1 = draw the live-depth occlusion quad (spawned objects hide behind real ones); 0 = off. */
  occluderEnabled: number;
  /** Metres added to the live depth before it's written to the depth buffer (see depth-occluder.ts). */
  occluderBiasM: number;
}

export const DEFAULT_TUNING: Readonly<CameraTuning> = Object.freeze({
  cameraHeightM: 0.45,
  pitchDeg: -6,
  fovYDeg: 50,
  depthScale: 1,
  depthShiftM: 0,
  depthSmoothing: 0.3,
  ransacThresholdM: 0.05,
  ransacIterations: 200,
  planeMinInliers: 100,
  planeMinExtentM: 0.4,
  clusterCellM: 0.05,
  clusterMinCount: 30,
  clusterMinHeightM: 0.04,
  volumeMaxSideM: 1.2,
  surfaceIntervalMs: 400,
  pointStride: 2,
  autoAttitude: 1,
  anchorNearU: 0,
  anchorNearV: 0,
  anchorNearM: 0,
  anchorFarU: 0,
  anchorFarV: 0,
  anchorFarM: 0,
  stereoFxScale: 1,
  occluderEnabled: 1,
  occluderBiasM: 0.02,
});

export interface TuningSpecEntry {
  min: number;
  max: number;
  step: number;
  label: string;
  group: 'camera' | 'depth' | 'planes' | 'volumes' | 'occlusion';
}

export const TUNING_SPEC: Record<keyof CameraTuning, TuningSpecEntry> = {
  cameraHeightM: { min: 0.05, max: 3, step: 0.01, label: 'Camera height (m)', group: 'camera' },
  pitchDeg: { min: -80, max: 30, step: 0.5, label: 'Pitch (deg)', group: 'camera' },
  fovYDeg: { min: 25, max: 110, step: 0.5, label: 'Vertical FOV (deg)', group: 'camera' },
  depthScale: { min: 0.25, max: 4, step: 0.01, label: 'Depth scale', group: 'depth' },
  depthShiftM: { min: -1, max: 1, step: 0.01, label: 'Depth shift (m)', group: 'depth' },
  depthSmoothing: { min: 0, max: 0.9, step: 0.01, label: 'Depth smoothing', group: 'depth' },
  ransacThresholdM: { min: 0.005, max: 0.15, step: 0.005, label: 'RANSAC threshold (m)', group: 'planes' },
  ransacIterations: { min: 50, max: 800, step: 10, label: 'RANSAC iterations', group: 'planes' },
  planeMinInliers: { min: 20, max: 1000, step: 10, label: 'Plane min inliers', group: 'planes' },
  planeMinExtentM: { min: 0.1, max: 1.5, step: 0.01, label: 'Plane min extent (m)', group: 'planes' },
  clusterCellM: { min: 0.02, max: 0.2, step: 0.005, label: 'Cluster cell (m)', group: 'volumes' },
  clusterMinCount: { min: 5, max: 300, step: 5, label: 'Cluster min count', group: 'volumes' },
  clusterMinHeightM: { min: 0.01, max: 0.2, step: 0.005, label: 'Cluster min height (m)', group: 'volumes' },
  volumeMaxSideM: { min: 0.3, max: 4, step: 0.05, label: 'Volume max side (m)', group: 'volumes' },
  surfaceIntervalMs: { min: 100, max: 2000, step: 10, label: 'Surface interval (ms)', group: 'planes' },
  pointStride: { min: 1, max: 8, step: 1, label: 'Point stride', group: 'volumes' },
  autoAttitude: { min: 0, max: 1, step: 1, label: 'Auto pitch/roll from depth', group: 'camera' },
  anchorNearU: { min: 0, max: 1, step: 0.001, label: 'Near anchor u', group: 'depth' },
  anchorNearV: { min: 0, max: 1, step: 0.001, label: 'Near anchor v', group: 'depth' },
  anchorNearM: { min: 0, max: 10, step: 0.01, label: 'Near anchor (m)', group: 'depth' },
  anchorFarU: { min: 0, max: 1, step: 0.001, label: 'Far anchor u', group: 'depth' },
  anchorFarV: { min: 0, max: 1, step: 0.001, label: 'Far anchor v', group: 'depth' },
  anchorFarM: { min: 0, max: 20, step: 0.01, label: 'Far anchor (m)', group: 'depth' },
  stereoFxScale: { min: 0.5, max: 2, step: 0.005, label: 'Stereo fx scale', group: 'depth' },
  occluderEnabled: { min: 0, max: 1, step: 1, label: 'Depth occlusion (o)', group: 'occlusion' },
  occluderBiasM: { min: 0, max: 0.2, step: 0.005, label: 'Occluder bias (m)', group: 'occlusion' },
};

export type TuningPresetId = 'laptop-desk' | 'phone-handheld' | 'tripod-room';

export interface TuningPreset {
  label: string;
  description: string;
  values: Partial<CameraTuning>;
}

export const TUNING_PRESETS: Record<TuningPresetId, TuningPreset> = {
  'laptop-desk': {
    label: 'Laptop / desk',
    description: 'Laptop camera above the desk it looks along, roughly level.',
    values: {
      cameraHeightM: 0.45,
      pitchDeg: 0,
      fovYDeg: 50,
      autoAttitude: 1,
      ransacThresholdM: 0.05,
      planeMinExtentM: 0.35,
      clusterMinCount: 30,
    },
  },
  'phone-handheld': {
    label: 'Phone (handheld)',
    description: 'Handheld phone at chest/eye height, angled down, moving.',
    values: {
      cameraHeightM: 1.3,
      pitchDeg: -30,
      fovYDeg: 60,
      autoAttitude: 1,
      depthSmoothing: 0.2,
      clusterMinCount: 40,
    },
  },
  'tripod-room': {
    label: 'Tripod (room)',
    description: 'Stationary tripod overlooking a room from a moderate height.',
    values: {
      cameraHeightM: 1.2,
      pitchDeg: -15,
      fovYDeg: 50,
      autoAttitude: 1,
      depthSmoothing: 0.5,
      surfaceIntervalMs: 600,
    },
  },
};

const DEFAULT_KEY = 'reality-editor-camera:tuning';

function clamp(key: keyof CameraTuning, value: number): number {
  const spec = TUNING_SPEC[key];
  if (!Number.isFinite(value)) return DEFAULT_TUNING[key];
  return Math.min(spec.max, Math.max(spec.min, value));
}

/** Feature-detect a usable Storage; never throws. */
function safeStorage(storage?: Storage | null): Storage | null {
  if (storage === null) return null;
  const candidate = storage !== undefined ? storage : typeof localStorage !== 'undefined' ? localStorage : null;
  if (!candidate) return null;
  try {
    const probeKey = '__reality-editor-camera-tuning-probe__';
    candidate.setItem(probeKey, '1');
    candidate.removeItem(probeKey);
    return candidate;
  } catch {
    return null;
  }
}

function safeGetItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Quota exceeded, private mode, disabled storage: silently ignore.
  }
}

export function loadTuning(storage?: Storage | null, key: string = DEFAULT_KEY): CameraTuning {
  const result: CameraTuning = { ...DEFAULT_TUNING };
  const s = safeStorage(storage);
  if (!s) return result;
  const raw = safeGetItem(s, key);
  if (!raw) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object') return result;
  const obj = parsed as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_TUNING) as (keyof CameraTuning)[]) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      result[k] = clamp(k, v);
    }
  }
  return result;
}

export function saveTuning(t: CameraTuning, storage?: Storage | null, key: string = DEFAULT_KEY): void {
  const s = safeStorage(storage);
  if (!s) return;
  try {
    safeSetItem(s, key, JSON.stringify(t));
  } catch {
    // never throw
  }
}

export type TuningListener = (t: CameraTuning, changedKey: keyof CameraTuning | null) => void;

export interface TuningStoreOptions {
  storage?: Storage | null;
  key?: string;
  initial?: Partial<CameraTuning>;
}

export class TuningStore {
  private current: CameraTuning;
  private readonly storage: Storage | null;
  private readonly key: string;
  private readonly listeners = new Set<TuningListener>();

  constructor(opts: TuningStoreOptions = {}) {
    this.storage = opts.storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : opts.storage;
    this.key = opts.key ?? DEFAULT_KEY;
    const loaded = loadTuning(this.storage, this.key);
    if (opts.initial) {
      for (const k of Object.keys(DEFAULT_TUNING) as (keyof CameraTuning)[]) {
        const v = opts.initial[k];
        if (typeof v === 'number' && Number.isFinite(v)) {
          loaded[k] = clamp(k, v);
        }
      }
    }
    this.current = loaded;
  }

  get value(): CameraTuning {
    return this.current;
  }

  set(key: keyof CameraTuning, value: number): void {
    const clamped = clamp(key, value);
    if (this.current[key] === clamped) return;
    this.current = { ...this.current, [key]: clamped };
    saveTuning(this.current, this.storage, this.key);
    this.notify(key);
  }

  patch(partial: Partial<CameraTuning>): void {
    let changedKey: keyof CameraTuning | null = null;
    let changedCount = 0;
    const next = { ...this.current };
    for (const k of Object.keys(partial) as (keyof CameraTuning)[]) {
      const v = partial[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const clamped = clamp(k, v);
      if (next[k] !== clamped) {
        next[k] = clamped;
        changedKey = k;
        changedCount += 1;
      }
    }
    if (changedCount === 0) return;
    this.current = next;
    saveTuning(this.current, this.storage, this.key);
    this.notify(changedCount === 1 ? changedKey : null);
  }

  reset(): void {
    this.current = { ...DEFAULT_TUNING };
    saveTuning(this.current, this.storage, this.key);
    this.notify(null);
  }

  /** Apply a named preset's values on top of the current tuning (persists, notifies with null). */
  applyPreset(id: TuningPresetId): void {
    this.patch(TUNING_PRESETS[id].values);
  }

  /** Reset a single parameter back to its default. */
  resetKey(key: keyof CameraTuning): void {
    this.set(key, DEFAULT_TUNING[key]);
  }

  subscribe(listener: TuningListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(changedKey: keyof CameraTuning | null): void {
    for (const listener of this.listeners) listener(this.current, changedKey);
  }
}
