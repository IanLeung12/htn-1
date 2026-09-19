/**
 * startCameraApp: the general-camera sibling of src/app/main.ts's startApp
 * (see docs/general-camera/architecture.md, "Decision: sibling entry").
 *
 * Same core store/resolver/regions/quality/perf, same renderers, same
 * InteractionController and voice grammar - but the world is a <video>
 * element under a transparent three.js canvas, the head pose comes from a
 * PoseSource (static tripod or device orientation), planes come from a
 * SurfaceEstimator (floor prior now, RANSAC on estimated depth later), and
 * input is mouse/touch through PointerInputAdapter. Nothing in the frame
 * loop awaits; estimation runs off-loop and publishes stamped results.
 *
 * The returned handle implements AppHandle so the HUD, voice layer, tests,
 * and diagnostics reuse the same surface: `enterAR()` starts the camera,
 * `inSession` means the video is playing.
 */
import * as THREE from 'three';
import {
  createSceneStore,
  createRegionStateMachine,
  createQualityManager,
  createPerfTracker,
  createFreshnessBus,
  createLocalStorageAdapter,
  autoPersist,
  restore,
} from '@/core';
import type { EditableObject, FrameSample, Pose, QualityDecision, RuntimeConditions, SceneSnapshot, Vec3, VisualMode } from '@/core/types';
import { IDENTITY_QUAT, ROOM_ANCHOR_ID } from '@/core/types';
import { quatRotateVec3 } from '@/core/math';
import type { AppHandle, CaptureGuide, XRFeatureReport } from '@/app/contract';
import { createRenderer } from '@/render/renderer';
import { ObjectViews } from '@/render/objects';
import { PlateRenderer } from '@/render/plates';
import { ShellRenderer } from '@/render/shell';
import { DomHud, GuideOverlay } from '@/render/hud';
import { BackgroundHull } from '@/render/background-hull';
import { InteractionController } from '@/app/interaction';
import { createProxyPhysics } from '@/core/physics';
import { createPhysicsBridge } from '@/app/physics-bridge';
import { createVoiceController } from '@/app/voice';
import { spawnAsset as spawnCatalogAsset } from '@/app/spawn';
import { CATALOG } from '@/app/catalog';
import { fitProxiesToBounds } from '@/app/catalog-fit';
import { RegionManager } from '@/app/regions';
import { INACTIVE_GUIDE, makeActiveGuide } from '@/app/guide';
import { createCapturePipeline, createPlateTextureRegistry } from '@/capture';
import { appearanceFrameKey, createFrameStore, ROOM_SHELL_FRAME_ID } from '@/capture/frame-store';
import type { CameraFrame, CameraFrameSource } from '@/capture/contract';
import type { CameraAppConfig, DepthEstimator, FrameSource, PoseSource, SurfaceEstimator } from './contract';
import { DEFAULT_CAMERA_CONFIG } from './contract';
import { createFrameSource } from './frame-source';
import { createPoseSource } from './pose';
import { rayPlaneY } from './surfaces/floor-prior';
import { WorkerSurfaceEstimator } from './surfaces/worker-estimator';
import { SurfaceRegistry } from './surfaces/registry';
import { SceneDebugOverlay } from './debug-overlay';
import { ImpostorViews, isImpostorActive } from './impostor';
import { ZedStereoFrameSource } from './stereo/zed-frame-source';
import { createZedSdkBackend } from './zedsdk';
import { loadZedCalibration } from './stereo/zed-calib';
import { getStereoDepthFactory, type StereoCalibrationInput, type StereoDepthEstimator } from './stereo/contract';
// Side effect: the WebGL2 census matcher registers itself with the stereo contract's factory.
import './stereo/stereo-depth';
import { PointerInputAdapter, intersectPlaneY, type PointerRay } from './input/pointer';
import { StaticPoseSource } from './pose/static';
import type { VisualPoseSource } from './pose/visual';
import { ModelDepthEstimator } from './depth/model';
import { TuningStore, type CameraTuning } from './tuning';
import { DepthOccluder } from './depth-occluder';
import { TuningPanel } from './tuning-panel';
import { synthesizeSupportPlate, tierForSyntheticPlate } from './synthetic-plate';
import { footprintFromProxy } from '@/capture';
import { pickFromMapRobust, pickOnSurfaceThroughHole, type PickResult } from './pick';
import { surfaceBelow } from '@/core';
import { CameraDiagnostics, type CameraDiagnosticsState } from './diagnostics';
import { createDepthEstimator } from './depth';
import { capTierForEstimatedDepth } from './tier-cap';
import { SilhouetteTracker, depthFrameFromMap, type SilhouetteMask } from './edit/silhouette';
import { checkObjectGone } from './edit/gone-check';
import { StaticCameraEraser } from './edit/eraser';
import { averageFrames } from './edit/average-frames';
import { pushAppearanceFrame, APPEARANCE_FRAME_COUNT, cameraMovedFromAppearance } from './edit/appearance';
import { capTierForSingleViewpoint } from './edit/single-viewpoint-tier';

export interface CameraAppOptions {
  container?: HTMLElement;
  headless?: boolean;
  persistKey?: string;
  config?: Partial<CameraAppConfig>;
  /** Start the camera immediately (no user gesture needed for a fake device / file source). */
  autoStart?: boolean;
  onFrame?: (info: { time: number; headPose: Pose; snapshot: SceneSnapshot; decision: QualityDecision }) => void;
}

/** Camera-specific handle exposed as `window.__camera` next to `window.__realityEditor`. */
export interface CameraHandle {
  readonly config: CameraAppConfig;
  readonly frameSource: FrameSource;
  readonly poseSource: PoseSource;
  readonly surfaceEstimator: SurfaceEstimator;
  readonly depthEstimator: DepthEstimator;
  readonly pointer: PointerInputAdapter;
  readonly diagnostics: CameraDiagnosticsState;
  /** World point under a CSS-pixel position on the overlay canvas (floor hit, or default depth). */
  worldAtPixel(clientX: number, clientY: number): Vec3;
  /**
   * Inverse of `worldAtPixel`'s NDC step: projects a world point through the current overlay
   * camera to normalized device coordinates ([-1, 1], y up), or null if it's behind the
   * camera. Also useful for tests/diagnostics that need to know where something rendered
   * (e.g. sampling the video/canvas at the screen position of a discovered object).
   */
  projectToNdc(worldPos: Vec3): { x: number; y: number } | null;
  /** `ndcToVideoUv`'s object-fit:cover mapping, exposed for tests/diagnostics. */
  ndcToVideoUv(ndcX: number, ndcY: number): { u: number; v: number };
  /** Debug: world positions of the static-camera eraser's current quads (tests/diagnostics). */
  debugEraserPositions(): { pos: Vec3; visible: boolean }[];
  /** Change the camera height above the floor (metres). */
  setCameraHeight(h: number): void;
  setFovY(rad: number): void;
  /** Renderer-side counts for tests/diagnostics (hull meshes drawn over the video, object views). */
  renderStats(): { hullChildren: number; viewChildren: number; appearanceActive: number; impostors: number; eraserActive: number; masksTracked: number };
  /** Live tunables (persisted in localStorage; `t` toggles the slider panel). */
  readonly tuning: TuningStore;
  /** World point the estimated depth sees at a canvas NDC position (snapped onto the surface below); null without depth. */
  pickWorld(ndcX: number, ndcY: number): Vec3 | null;
  /**
   * `pickWorld` with provenance: 'depth' (confidence 1) when the pixel has depth, 'surface'
   * (confidence 0.5) when it is a hole and a fitted horizontal surface crosses the pixel ray
   * within 5 cm of the nearest valid depth (<= 24 px away) - the bare desk between matched edges.
   */
  pickWorldDetailed(ndcX: number, ndcY: number): PickResult | null;
  /** Capture appearance + synthetic support plate for a discovered real object (tier D) so it can be moved. */
  prepareRealObject(objectId: string): Promise<{ tier: string; donorFraction: number }>;
  /**
   * One-click metric calibration: the thing seen at canvas NDC (ndcX, ndcY) is `distanceM`
   * metres from the camera. Sets tuning.depthScale so the newest depth map agrees; returns
   * the factor applied, or null when no model depth is available there.
   */
  calibrateAt(ndcX: number, ndcY: number, distanceM: number): number | null;
  /**
   * Two-point calibration: the pixel at ndcNear is mNear metres away, the one at ndcFar is
   * mFar. Solves scale and shift of the model's relative inverse depth (re-evaluated every
   * frame from those pixels) and persists both anchors in tuning. Returns false when the
   * model has no output yet.
   */
  calibrateNearFar(ndcNear: { x: number; y: number }, mNear: number, ndcFar: { x: number; y: number }, mFar: number): boolean;
  /** Forget the two-point anchors (back to the ground-plane fit). */
  clearAnchors(): void;
  /** Live-depth occlusion state (see depth-occluder.ts), for tests/diagnostics. `o` toggles it. */
  readonly occluder: { enabled: boolean; lastUploadTs: number; textureWidth: number; textureHeight: number };
}

export interface CameraApp {
  handle: AppHandle;
  camera: CameraHandle;
}

declare global {
  interface Window {
    __camera?: CameraHandle;
  }
}

const TARGET_FRAME_MS = 1000 / 60;
/** Width of frames handed to the capture pipeline and the depth estimator. */
const CAPTURE_WIDTH = 320;
const DEPTH_SUBMIT_INTERVAL_MS = 150;
const GRAB_INTERVAL_MS = 120;
/** Stereo: match every other video frame at half the eye width. */
const STEREO_SUBMIT_INTERVAL_MS = 60;
const STEREO_WORK_WIDTH = 336;
/** Attitude is only learned from planes at least this large (points), smoothed with this time constant. */
const ATTITUDE_MIN_INLIERS = 2000;
const ATTITUDE_TAU_MS = 2000;
const ATTITUDE_MIN_EXTENT_M = 1.0;
const ATTITUDE_STABLE_RUNS = 3;
const ATTITUDE_STABLE_RAD = (3 * Math.PI) / 180;
const ATTITUDE_PITCH_CLAMP_RAD = (10 * Math.PI) / 180;
/** Farthest a spawned object is placed from the camera along the floor (m). */
const SPAWN_MAX_M = 2.0;
/** Clean-plate shots requested from a moving (non-static) camera; see tier-cap.ts's agreement rule. */
const MULTI_SHOT_COUNT = 3;
const MULTI_SHOT_BEARING_RAD = (16 * Math.PI) / 180;
const MULTI_SHOT_TIMEOUT_MS = 8000;
/** Static-camera `Capture plate`: shots averaged for noise reduction, spread over ~1 s. */
const AVERAGE_SHOT_COUNT = 6;
const AVERAGE_SHOT_INTERVAL_MS = 166;
/** How far a discovered object may drift from its registered pose (physics settle, not a drag) and still count as "present, keep tracking its silhouette". */
const STILL_AT_ORIGINAL_SPOT_M = 0.03;

function bearingDelta(a: Pose, b: Pose): number {
  const fa = quatRotateVec3(a.rotation, { x: 0, y: 0, z: -1 });
  const fb = quatRotateVec3(b.rotation, { x: 0, y: 0, z: -1 });
  let d = Math.abs(Math.atan2(fa.x, -fa.z) - Math.atan2(fb.x, -fb.z));
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

function poseFromCamera(camera: THREE.Camera): Pose {
  const p = camera.position;
  const q = camera.quaternion;
  return { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } };
}

export async function startCameraApp(options: CameraAppOptions = {}): Promise<CameraApp> {
  const container = options.container ?? document.body;
  const headless = options.headless ?? false;
  const config: CameraAppConfig = { ...DEFAULT_CAMERA_CONFIG, ...options.config };

  // Live tunables: persisted values win over defaults; values given explicitly in
  // options.config (URL params) win over persisted ones.
  const initialTuning: Partial<CameraTuning> = {};
  if (options.config?.cameraHeightM !== undefined) initialTuning.cameraHeightM = options.config.cameraHeightM;
  if (options.config?.pitchRad !== undefined) initialTuning.pitchDeg = (options.config.pitchRad * 180) / Math.PI;
  if (options.config?.fovY !== undefined) initialTuning.fovYDeg = (options.config.fovY * 180) / Math.PI;
  const tuning = new TuningStore({ storage: typeof localStorage !== 'undefined' ? localStorage : null, initial: initialTuning });
  config.cameraHeightM = tuning.value.cameraHeightM;
  config.pitchRad = (tuning.value.pitchDeg * Math.PI) / 180;
  config.fovY = (tuning.value.fovYDeg * Math.PI) / 180;

  const store = createSceneStore();
  const perf = createPerfTracker();
  const quality = createQualityManager();
  const freshness = createFreshnessBus();
  const regionMachine = createRegionStateMachine();
  const regionManager = new RegionManager({ store, regionMachine });
  store.subscribe((_snapshot, applied) => {
    if (!applied) return;
    regionManager.onCommit(applied, conditions());
  });

  if (options.persistKey) {
    const adapter = createLocalStorageAdapter('reality-editor-camera');
    await restore(store, adapter, options.persistKey);
    autoPersist(store, adapter, options.persistKey, 250, 1000);
  }

  // ---- Estimators -----------------------------------------------------
  // A ZED 2 (side-by-side UVC stereo) is a stereo source: its left eye is the passthrough,
  // both eyes feed the GPU stereo matcher, which replaces the monocular model.
  // ZED SDK bridge (src/camera/zedsdk): one WebSocket supplies the passthrough, SDK depth and SDK tracking.
  const zedSdk = config.source === 'zed-sdk' ? createZedSdkBackend(config) : null;
  const wantsStereo = !zedSdk && (config.source === 'stereo' || /zed/i.test(config.device ?? '') || (config.stereo === 'sbs' && !!config.url));
  const zedSerial = config.zedSerial ?? (wantsStereo ? '25491304' : undefined);
  const zedCalibration = wantsStereo && zedSerial ? await loadZedCalibration(zedSerial) : null;
  const stereoSource = wantsStereo
    ? new ZedStereoFrameSource({ fovY: config.fovY, deviceLabel: config.device ?? 'zed', mode: config.stereoMode ?? (config.stereo === 'sbs' ? 'hd720' : 'vga'), calibration: zedCalibration, url: config.stereo === 'sbs' ? config.url : undefined })
    : null;
  const frameSource: FrameSource = zedSdk?.frameSource ?? stereoSource ?? createFrameSource(config);
  if (stereoSource) config.source = 'stereo';
  const poseSource = zedSdk?.poseSource ?? createPoseSource(config);
  // Floor prior until estimated depth is confident enough for RANSAC planes/volumes (computed in a worker).
  const surfaceEstimator = new WorkerSurfaceEstimator({ cameraHeightM: config.cameraHeightM, getTuning: () => tuning.value, trustPose: !!zedSdk });
  // The GPU matcher lives in its own module (src/camera/stereo/contract.ts describes it); when it
  // is not registered the monocular estimator answers and diagnostics say so.
  const stereoFactory = stereoSource ? getStereoDepthFactory() : null;
  const monocularFallback = config.depth === 'none' ? null : createDepthEstimator({ depth: config.depth === 'stereo' ? 'auto' : config.depth }, () => surfaceEstimator.cameraHeightM);
  const stereoDepth: StereoDepthEstimator | null =
    stereoSource && stereoFactory
      ? stereoFactory({
          getCalibration: (): StereoCalibrationInput | undefined => {
            const sp = stereoSource.stereo;
            if (!sp) return undefined;
            const mode = config.stereoMode ?? 'vga';
            return {
              baselineM: sp.baselineM,
              fxPx: sp.fxPx,
              eyeWidth: sp.eyeWidth,
              eyeHeight: sp.eyeHeight,
              rectifyMaps: stereoSource.rectifyMaps(mode),
              calibration: stereoSource.calibration,
              mode,
              calibrationId: sp.calibrationId,
            };
          },
          workWidth: STEREO_WORK_WIDTH,
          fxScale: () => tuning.value.stereoFxScale,
          fallback: monocularFallback,
        })
      : null;
  const depthEstimator: DepthEstimator = zedSdk?.depthEstimator ?? stereoDepth ?? (stereoSource ? (monocularFallback ?? createDepthEstimator({ depth: 'prior' }, () => 0)) : createDepthEstimator(config, () => surfaceEstimator.cameraHeightM));
  const staticBase: StaticPoseSource | null = (() => {
    const base = (poseSource as VisualPoseSource).base as unknown;
    return base instanceof StaticPoseSource ? base : poseSource instanceof StaticPoseSource ? poseSource : null;
  })();
  const visualPose = 'pushFrame' in poseSource ? (poseSource as VisualPoseSource) : null;
  const applyDepthAdjust = (): void => {
    if (depthEstimator instanceof ModelDepthEstimator) {
      depthEstimator.adjust.scale = tuning.value.depthScale;
      depthEstimator.adjust.shiftM = tuning.value.depthShiftM;
      depthEstimator.adjust.smoothing = tuning.value.depthSmoothing;
      const t = tuning.value;
      depthEstimator.anchors.near = t.anchorNearM > 0 ? { u: t.anchorNearU, v: t.anchorNearV, metres: t.anchorNearM } : null;
      depthEstimator.anchors.far = t.anchorFarM > 0 ? { u: t.anchorFarU, v: t.anchorFarV, metres: t.anchorFarM } : null;
    }
  };
  applyDepthAdjust();
  tuning.subscribe((t, key) => {
    if (key === null || key === 'cameraHeightM') {
      poseSource.setHeight(t.cameraHeightM);
      surfaceEstimator.setHeight(t.cameraHeightM);
    }
    if ((key === null || key === 'pitchDeg') && staticBase) {
      staticBase.setPitch((t.pitchDeg * Math.PI) / 180);
      presetPitchDeg = t.pitchDeg;
    }
    if (key === null || key === 'fovYDeg') frameSource.setFovY((t.fovYDeg * Math.PI) / 180);
    if (key === null || key === 'depthScale' || key === 'depthShiftM' || key === 'depthSmoothing' || key.startsWith('anchor')) applyDepthAdjust();
  });

  // ---- Renderer: video under a transparent canvas ---------------------
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.style.background = '#000';
  // Stereo: show the LEFT eye (a canvas the source keeps updated), never the side-by-side video.
  const video: HTMLElement = zedSdk ? zedSdk.frameSource.display : stereoSource ? stereoSource.display : frameSource.video;
  if (stereoSource || zedSdk) {
    frameSource.video.style.display = 'none';
    container.appendChild(frameSource.video);
  }
  video.style.position = 'absolute';
  video.style.inset = '0';
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'cover';
  video.style.zIndex = '0';
  container.appendChild(video);

  const { renderer, canvas, dispose: disposeRenderer } = createRenderer(container);
  renderer.xr.enabled = false;
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.zIndex = '1';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera((config.fovY * 180) / Math.PI, 4 / 3, 0.01, 50);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 2, 1);
  scene.add(dirLight);

  const frameStore = createFrameStore();
  // Live-depth occlusion: spawned/virtual objects hide behind real ones (see
  // depth-occluder.ts's module doc for the render-order rationale). Added
  // first so its renderOrder (-1) is unambiguous relative to everything
  // else, though three sorts by renderOrder regardless of add order.
  const depthOccluder = new DepthOccluder();
  scene.add(depthOccluder.mesh);
  const views = new ObjectViews(frameStore);
  scene.add(views.group);
  const previewGroup = new THREE.Group();
  scene.add(previewGroup);
  const textureRegistry = createPlateTextureRegistry();
  const plates = new PlateRenderer(textureRegistry);
  scene.add(plates.group);
  const shell = new ShellRenderer(frameStore);
  scene.add(shell.occluderGroup, shell.visibleGroup, shell.roomShellGroup);
  const backgroundHull = new BackgroundHull(frameStore);
  scene.add(backgroundHull.group);
  const guideOverlay = new GuideOverlay();
  scene.add(guideOverlay.group);
  // Camera-facing impostors for moved real objects (a single-view depth mesh looks edge-on).
  const impostors = new ImpostorViews(frameStore);
  scene.add(impostors.group);
  // Per-object depth-blob silhouette, tracked (median of last 5) while the object sits at its
  // original pose; frozen once it moves/is deleted so the impostor cutout and the static-camera
  // eraser both use the object's actual shape instead of its occlusion box (docs/general-camera).
  const silhouetteTracker = new SilhouetteTracker();
  let lastTrackedPhysicalIds = new Set<string>();
  impostors.setMaskSource((objectId) => {
    const mask = silhouetteTracker.peek(objectId);
    const grid = depthEstimator.latest;
    if (!mask || !grid) return undefined;
    return { mask, gridW: grid.width, gridH: grid.height };
  });
  // Static-camera fast path for Delete: composites the clean-plate frame's own pixels into the
  // tracked silhouette instead of BackgroundHull's reprojected 3D depth mesh (exact when the
  // camera hasn't moved). A world-space quad in the main scene (see edit/eraser.ts), drawn over
  // the hull's own (renderOrder 0.5-1) meshes.
  const staticEraser = new StaticCameraEraser(frameStore);
  scene.add(staticEraser.group);
  const debugOverlay = new SceneDebugOverlay();
  debugOverlay.setVisible(false);
  scene.add(debugOverlay.group);

  // ---- Input ------------------------------------------------------------
  const interaction = new InteractionController(store);
  const rayOrigin = new THREE.Vector3();
  const rayDir = new THREE.Vector3();
  const rayFromNdc = (ndcX: number, ndcY: number, out: PointerRay): void => {
    rayOrigin.setFromMatrixPosition(camera.matrixWorld);
    rayDir.set(ndcX, ndcY, 0.5).unproject(camera).sub(rayOrigin).normalize();
    out.origin.x = rayOrigin.x;
    out.origin.y = rayOrigin.y;
    out.origin.z = rayOrigin.z;
    out.direction.x = rayDir.x;
    out.direction.y = rayDir.y;
    out.direction.z = rayDir.z;
  };
  // Events over the video / stereo display canvas (under the overlay) count too: synthetic dispatches
  // and any element that ends up above the overlay bubble to the container.
  const pointer = new PointerInputAdapter({ element: canvas, extraTargets: [container], store, rayFromNdc, depthPick: (x, y) => pickWorld(x, y) });

  const physics = createProxyPhysics();
  const physicsBridge = createPhysicsBridge(store, physics, conditions);

  // ---- State ------------------------------------------------------------
  let inSession = false;
  let sessionPending = false;
  let features: XRFeatureReport | null = null;
  let guide: CaptureGuide = INACTIVE_GUIDE;
  let lastFrameTime: number | null = null;
  let lastDepthSubmitAt = -Infinity;
  let lastGrabAt = -Infinity;
  let lastCorrectionAt = -Infinity;
  let lastTuningSyncAt = -Infinity;
  let lastAttitudeApplyAt = -Infinity;
  const pitchHistory: number[] = [];
  /** Pitch the user/preset configured; auto attitude may only deviate +-10 degrees from it. */
  let presetPitchDeg = tuning.value.pitchDeg;
  let lastSurfaceRegisterAt = -Infinity;
  let floorRegistered = false;
  const localizedAnchors = new Set<string>();
  const tierCapFrames = new Map<string, CameraFrame[]>();

  function conditions(): RuntimeConditions {
    const q = poseSource.quality;
    localizedAnchors.clear();
    if (q.trackingOk) localizedAnchors.add(ROOM_ANCHOR_ID);
    return {
      now: performance.now(),
      headPose: poseSource.pose,
      trackingOk: q.trackingOk,
      localizedAnchors,
      depthAgeMs: depthAgeMs(performance.now()),
      tier: quality.decision.tier,
    };
  }

  function depthAgeMs(now: number): number {
    const latest = depthEstimator.latest;
    return latest ? now - latest.timestamp : Infinity;
  }

  quality.subscribe((decision: QualityDecision) => {
    const snapshot = store.current;
    if (!decision.allowCapturedShell && snapshot.mode !== 'live-overlay') {
      store.dispatch(
        { intent: { kind: 'setMode', mode: 'live-overlay' }, source: 'system', issuedAt: decision.at, basedOnVersion: snapshot.version },
        conditions(),
      );
    }
  });

  // ---- Capture source: newest video frame + newest depth + current pose --
  const cameraFrameSource: CameraFrameSource = {
    get available() {
      return frameSource.ready;
    },
    async capture(_viewpoint?: Pose): Promise<CameraFrame | null> {
      // A real camera captures from where it is; `viewpoint` is advisory (the guide asks the user to move).
      const grabbed = frameSource.grab(CAPTURE_WIDTH);
      if (!grabbed) return null;
      const intr = frameSource.intrinsics;
      const pose = poseSource.pose;
      const frame: CameraFrame = {
        width: grabbed.width,
        height: grabbed.height,
        rgba: grabbed.rgba,
        pose: { position: { ...pose.position }, rotation: { ...pose.rotation } },
        fovY: intr.fovY,
        aspect: grabbed.width / grabbed.height,
        timestamp: grabbed.timestamp,
        poseConfidence: poseSource.quality.confidence,
      };
      const depth = depthEstimator.sample(grabbed.width, grabbed.height, pose, intr.fovY, grabbed.width / grabbed.height);
      if (depth) {
        frame.depth = depth.metric;
        frame.depthSource = depth.source;
        frame.depthConfidence = depth.confidence;
        frame.depthToleranceM = depth.toleranceM;
      }
      return frame;
    },
  };
  const capture = createCapturePipeline({ frameStore, registry: textureRegistry });

  // ---- Voice --------------------------------------------------------------
  const voice = createVoiceController({
    store,
    getConditions: conditions,
    getSelectedId: () => interaction.selectedId ?? undefined,
    actions: {
      captureCleanPlate: (id) => {
        void captureCleanPlate(id);
      },
      spawn: (shape) => spawnPrimitive(shape === 'cube' ? 'box' : 'sphere'),
      spawnAsset: (entryId) => {
        spawnAsset(entryId);
      },
      explainLast: () => {
        const r = interaction.lastRejection;
        return r ? `${r.reason}: ${r.explanation}` : 'Nothing has been rejected recently.';
      },
      list: () => {
        const objects = Object.values(store.current.objects).filter((o) => o.approved);
        return objects.length === 0
          ? 'Nothing is approved for editing yet.'
          : objects.map((o) => `${o.userName} (tier ${o.tier}${o.visible ? '' : ', hidden'})`).join(', ');
      },
      setMode: (mode) =>
        store.dispatch(
          { intent: { kind: 'setMode', mode }, source: 'voice', issuedAt: performance.now(), basedOnVersion: store.current.version },
          conditions(),
        ),
      select: (id) => {
        interaction.selectedId = id;
      },
    },
    onTranscript: (_text, result) => {
      if (result.status === 'rejected') {
        interaction.lastRejection = { reason: result.reason, explanation: result.explanation, at: performance.now() };
      }
    },
    speak: !headless,
  });

  // ---- HUD + diagnostics -------------------------------------------------
  const domHud = new DomHud(container, headless, {
    onEnterAR: () => {
      void enterAR();
    },
    onDiscover: () => {
      void runCandidateDiscovery();
    },
    onCapturePlate: () => {
      if (interaction.selectedId) void captureCleanPlate(interaction.selectedId);
    },
    onDelete: () => interaction.deleteSelected(conditions()),
    onRestore: () => interaction.restoreSelected(conditions()),
    onUndo: () => store.dispatch({ intent: { kind: 'undo' }, source: 'ui', issuedAt: performance.now(), basedOnVersion: store.current.version }, conditions()),
    onRedo: () => store.dispatch({ intent: { kind: 'redo' }, source: 'ui', issuedAt: performance.now(), basedOnVersion: store.current.version }, conditions()),
    onModeToggle: () => {
      const mode: VisualMode = store.current.mode === 'live-overlay' ? 'captured-shell' : 'live-overlay';
      store.dispatch({ intent: { kind: 'setMode', mode }, source: 'ui', issuedAt: performance.now(), basedOnVersion: store.current.version }, conditions());
    },
    onSpawnCube: () => spawnPrimitive('box'),
    onSpawnSphere: () => spawnPrimitive('sphere'),
  });
  domHud.root.style.zIndex = '10';
  const enterButton = domHud.root.querySelector<HTMLButtonElement>('[data-action="enter-ar"]');
  if (enterButton) enterButton.textContent = 'Start camera';

  const diagState: CameraDiagnosticsState = {
    source: config.source,
    videoReady: false,
    videoSize: '',
    videoFps: 0,
    poseMode: poseSource.quality.mode,
    poseConfidence: 0,
    trackingOk: true,
    poseSampleAgeMs: Infinity,
    cameraHeightM: config.cameraHeightM,
    tuningHeightM: tuning.value.cameraHeightM,
    fovYDeg: (config.fovY * 180) / Math.PI,
    depthState: 'idle',
    depthBackend: 'none',
    depthModel: null,
    depthInferenceMs: 0,
    depthAgeMs: Infinity,
    depthConfidence: 0,
    floorConfidence: 0,
    surfaceCount: 0,
    volumeCount: 0,
    tierCap: 'C',
    qualityTier: quality.decision.tier,
    frameP95: 0,
    appMs: 0,
    objectCount: 0,
    hoverId: null,
    pointerWorld: null,
    error: null,
    estPitchDeg: null,
    estRollDeg: null,
    tables: 0,
    walls: 0,
    surfaceRunMs: 0,
    motionPx: 0,
    depthFrames: 0,
    depthPublishedAgoMs: Infinity,
    depthFitMode: 'none',
    stereoLine: '',
    depthScale: tuning.value.depthScale,
    rollCorroborated: false,
    appliedPitchDeg: tuning.value.pitchDeg,
    appliedRollDeg: 0,
    attitudeNote: 'waiting for a plane',
    getLines: () => CameraDiagnostics.lines(diagState),
  };
  const diagnostics = new CameraDiagnostics(container, !headless);
  // One-line workflow hint under the HUD: what the next useful action is on this backend.
  const hintEl = document.createElement('div');
  hintEl.id = 'camera-hint';
  hintEl.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:10;font:12px system-ui,sans-serif;color:#f2f2f5;background:rgba(0,0,0,0.55);padding:6px 10px;border-radius:6px;max-width:420px;pointer-events:none;';
  hintEl.style.display = headless ? 'none' : 'block';
  container.appendChild(hintEl);
  let lastHint = '';
  /**
   * A one-shot status hint (e.g. from `Capture plate`) that overrides `workflowHint()`'s
   * per-frame, selection-derived text for `ttlMs`: without this, the periodic 250ms diag
   * tick below recomputes `workflowHint()` (which knows nothing about "just captured" and
   * often has no selection to key off of) and stomps a directly-set message within one tick.
   */
  let transientHint: { text: string; expiresAt: number } | null = null;
  function setTransientHint(text: string, ttlMs = 4000): void {
    transientHint = { text, expiresAt: performance.now() + ttlMs };
    hintEl.textContent = text;
    lastHint = text;
  }
  // `c`: calibrate depth scale from the object under the pointer (asks for its distance).
  // `c` twice: first the NEAR anchor (hover something close, e.g. a can at 0.5 m), then the FAR
  // anchor (the wall); together they pin scale and shift. `C` (shift) clears the anchors.
  let pendingNear: { ndc: { x: number; y: number }; m: number } | null = null;
  const onCalibrateKey = (e: KeyboardEvent): void => {
    if ((e.key !== 'c' && e.key !== 'C') || e.ctrlKey || e.metaKey || e.altKey || headless) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (e.key === 'C') {
      cameraHandle.clearAnchors();
      pendingNear = null;
      hintEl.textContent = 'Depth anchors cleared; back to the ground-plane scale.';
      lastHint = hintEl.textContent;
      return;
    }
    if (stereoDepth) {
      const answer1 = window.prompt('Distance from the camera to the thing under the pointer (metres):', '1.0');
      const d1 = answer1 === null ? NaN : Number(answer1);
      if (!Number.isFinite(d1) || d1 <= 0) return;
      const f = cameraHandle.calibrateAt(pointer.lastNdcX, pointer.lastNdcY, d1);
      hintEl.textContent = f === null ? 'Calibration needs stereo depth under the pointer.' : `Stereo fx scale set to x${f.toFixed(3)}.`;
      lastHint = hintEl.textContent ?? '';
      return;
    }
    const which = pendingNear ? 'FAR' : 'NEAR';
    const answer = window.prompt(`${which} anchor: distance from the camera to the thing under the pointer (metres):`, pendingNear ? '2.5' : '0.5');
    const d = answer === null ? NaN : Number(answer);
    if (!Number.isFinite(d) || d <= 0) return;
    const ndc = { x: pointer.lastNdcX, y: pointer.lastNdcY };
    if (!pendingNear) {
      pendingNear = { ndc, m: d };
      hintEl.textContent = `Near anchor ${d} m stored. Now hover something far and press c again.`;
    } else {
      const ok = cameraHandle.calibrateNearFar(pendingNear.ndc, pendingNear.m, ndc, d);
      hintEl.textContent = ok ? `Two-point calibration set (${pendingNear.m} m / ${d} m); scale mode 'anchors'.` : 'Calibration needs model depth.';
      pendingNear = null;
    }
    lastHint = hintEl.textContent ?? '';
  };
  window.addEventListener('keydown', onCalibrateKey);
  const onOverlayKey = (e: KeyboardEvent): void => {
    if (e.key !== 'v' || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    debugOverlay.setVisible(!debugOverlay.group.visible);
  };
  window.addEventListener('keydown', onOverlayKey);
  const onOccluderKey = (e: KeyboardEvent): void => {
    if (e.key !== 'o' || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    tuning.set('occluderEnabled', tuning.value.occluderEnabled >= 1 ? 0 : 1);
  };
  window.addEventListener('keydown', onOccluderKey);
  function workflowHint(): string {
    if (transientHint) {
      if (performance.now() < transientHint.expiresAt) return transientHint.text;
      transientHint = null;
    }
    const snap = store.current;
    const sel = interaction.selectedId ? snap.objects[interaction.selectedId] : undefined;
    if (!inSession) return 'Start the camera to begin.';
    if (sel && sel.origin === 'physical') {
      if (!sel.visible) return `${sel.userName} is deleted: Restore or Undo brings it back (say "put it back").`;
      if (sel.tier === 'D') return `${sel.userName}: drag to move (tier D). To delete it, take it out of the picture, then press Capture plate.`;
      if (sel.tier === 'B' || sel.tier === 'C') return `${sel.userName}: clean plate captured (tier ${sel.tier}); Delete hides it behind the captured background.`;
      if (sel.tier === 'E') return `${sel.userName} has no support surface; only restore/undo.`;
    }
    if (sel) return `${sel.userName}: drag along the surface, wheel to lift, two fingers to scale/turn.`;
    const real = Object.values(snap.objects).filter((o) => o.origin === 'physical').length;
    if (real === 0 && surfaceEstimator.volumes.length > 0) return `${surfaceEstimator.volumes.length} real object(s) seen: press Discover to make them editable.`;
    if (real === 0) return 'Spawn a cube, or point the camera at objects on a table/floor and press Discover.';
    return 'Click an object to select it; drag to move. d: diagnostics, t: tuning, v: scene wireframes, o: depth occlusion.';
  }
  const tuningPanel = new TuningPanel(container, tuning, { visible: false });
  let lastDiagAt = -Infinity;
  let videoFrameCounter = 0;
  let videoFpsWindowStart = 0;
  let lastVideoFrameAt = -1;

  // ---- Actions ------------------------------------------------------------
  function spawnAsset(entryId: string): string | null {
    return spawnCatalogAsset(store, entryId, spawnHeadPose(), conditions());
  }

  /**
   * Catalog spawn places assets 0.7 m ahead and 0.3 m below the "head"; a
   * webcam at 1.1 m looking down would then spawn things in mid-air far from
   * the pointer. Synthesize a head pose hovering just above the floor point
   * under the pointer (or ahead of the camera) so assets land where the
   * user is looking, then physics settles them.
   */
  function spawnHeadPose(): Pose {
    const target = spawnTarget();
    return { position: { x: target.x, y: target.y + 0.5, z: target.z + 0.7 }, rotation: { ...IDENTITY_QUAT } };
  }

  /**
   * Map overlay NDC to video UV, accounting for the object-fit: cover crop
   * (the overlay camera's FOV was widened/cropped to match, see the frame loop).
   */
  function ndcToVideoUv(ndcX: number, ndcY: number): { u: number; v: number } {
    const intr = frameSource.intrinsics;
    const viewAspect = (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight);
    let u = ndcX * 0.5 + 0.5;
    let v = 0.5 - ndcY * 0.5;
    if (viewAspect > intr.aspect) {
      // Viewport wider than the video: video scaled to the width, top/bottom cropped.
      const frac = intr.aspect / viewAspect;
      v = 0.5 + (v - 0.5) * frac;
    } else if (viewAspect < intr.aspect) {
      const frac = viewAspect / intr.aspect;
      u = 0.5 + (u - 0.5) * frac;
    }
    return { u, v };
  }

  /** World point the newest estimated depth sees at an NDC position, snapped onto the surface below it. */
  function pickWorld(ndcX: number, ndcY: number): Vec3 | null {
    return pickWorldDetailed(ndcX, ndcY)?.point ?? null;
  }

  function pickWorldDetailed(ndcX: number, ndcY: number): PickResult | null {
    const map = depthEstimator.latest;
    if (!map || map.confidence < 0.25 || map.source === 'plane-prior') return null;
    // (stereo maps carry validFraction as confidence; holes are 0 depth and fall through to the surface pick)
    if (performance.now() - map.timestamp > 3000) return null;
    const { u, v } = ndcToVideoUv(ndcX, ndcY);
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const px = Math.min(map.width - 1, Math.floor(u * map.width));
    const py = Math.min(map.height - 1, Math.floor(v * map.height));
    // Same unprojection + frame the RANSAC cloud used, so picks land on the fitted planes.
    const point = pickFromMapRobust(map, px, py, surfaceEstimator.lastFrame);
    if (!point) {
      // Textureless hole (stereo): a fitted horizontal surface crossing the pixel ray near the nearest valid depth.
      return pickOnSurfaceThroughHole(map, px, py, surfaceEstimator.lastFrame, Object.values(store.current.surfaces), 24, 0.05, 0.3, !!zedSdk);
    }
    // Measured depth of a desk seen edge-on scatters +-6 cm around the fitted top: snap from further below.
    const snapUp = zedSdk ? 0.12 : 0.05;
    const below = surfaceBelow(store.current, { x: point.x, y: point.y + snapUp, z: point.z });
    if (below && point.y + snapUp - below.aabb.max.y < 0.2) point.y = below.aabb.max.y;
    return { point, confidence: 1, mode: 'depth' };
  }

  /** Drop a world point onto the nearest detected horizontal surface below it (any distance), if one exists. */
  function dropToSupport(p: Vec3): Vec3 {
    const below = surfaceBelow(store.current, { x: p.x, y: p.y + (zedSdk ? 0.12 : 0.02), z: p.z });
    return below ? { x: p.x, y: below.aabb.max.y, z: p.z } : p;
  }

  function spawnTarget(): Vec3 {
    // The last pointer position counts even after the pointer left the canvas to press a
    // HUD button (owner report: spawn ignored the pointer because the hover track was gone).
    const recentPointer = performance.now() - pointer.lastPointerAt < 15_000;
    if (recentPointer) {
      const picked = pickWorld(pointer.lastNdcX, pointer.lastNdcY);
      if (picked) return dropToSupport(picked);
      // The hover already resolved a world point (depth hit or ground hit); use it as-is.
      const pw = pointer.pointerWorld;
      if (Number.isFinite(pw.x) && Math.hypot(pw.x, pw.z) > 0 && pw.y >= -0.05 && pw.y < 3) return dropToSupport({ x: pw.x, y: pw.y, z: pw.z });
      const ray: PointerRay = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };
      rayFromNdc(pointer.lastNdcX, pointer.lastNdcY, ray);
      const ground = intersectPlaneY(ray, 0);
      if (ground && Math.hypot(ground.x - ray.origin.x, ground.z - ray.origin.z) <= SPAWN_MAX_M) return dropToSupport(ground);
    }
    const centre = pickWorld(0, -0.2);
    if (centre) return dropToSupport(centre);
    const pose = poseSource.pose;
    const fwd = quatRotateVec3(pose.rotation, { x: 0, y: 0, z: -1 });
    const hit = rayPlaneY(pose.position, fwd, 0);
    const horiz = Math.hypot(fwd.x, fwd.z) || 1;
    // Where the camera's centre ray meets the floor, but no further than SPAWN_MAX_M ahead
    // (a gently pitched webcam looks at the floor metres away, where a new object would be tiny).
    if (hit) {
      const dist = Math.hypot(hit.x - pose.position.x, hit.z - pose.position.z);
      if (dist <= SPAWN_MAX_M) return hit;
    }
    return { x: pose.position.x + (fwd.x / horiz) * SPAWN_MAX_M, y: 0, z: pose.position.z + (fwd.z / horiz) * SPAWN_MAX_M };
  }

  views.onModelLoaded = (objectId, bounds) => {
    const obj = store.current.objects[objectId];
    if (!obj) return;
    const fitted = fitProxiesToBounds(obj, bounds);
    store.dispatch(
      {
        intent: { kind: 'setProxies', objectId, interaction: fitted.interactionProxy, collision: fitted.collisionProxy, occlusion: fitted.occlusionProxy },
        source: 'system',
        issuedAt: performance.now(),
        basedOnVersion: store.current.version,
      },
      conditions(),
    );
  };

  let spawnCounter = 0;
  function spawnPrimitive(kind: 'box' | 'sphere'): void {
    spawnCounter += 1;
    const half = 0.08;
    const target = spawnTarget();
    const pose: Pose = { position: { x: target.x, y: target.y + half, z: target.z }, rotation: { ...IDENTITY_QUAT } };
    const headPose = poseSource.pose;
    const proxy = kind === 'box' ? ({ kind: 'box', halfExtents: { x: half, y: half, z: half } } as const) : ({ kind: 'sphere', radius: half } as const);
    const object: EditableObject = {
      id: `spawn-${spawnCounter}-${Date.now()}`,
      label: 'other',
      userName: `Spawned ${kind} ${spawnCounter}`,
      origin: 'spawned',
      originalPose: pose,
      currentPose: pose,
      anchorId: ROOM_ANCHOR_ID,
      visual: { kind: 'primitive', color: kind === 'box' ? 0x66aaff : 0xff8866 },
      interactionProxy: proxy,
      collisionProxy: proxy,
      occlusionProxy: proxy,
      supportSurfaces: [],
      background: [],
      provenance: { method: 'spawned', capturedAt: performance.now(), capturePath: [headPose] },
      tier: 'A',
      tierConfidence: 1,
      envelope: { center: headPose.position, radius: 3, maxAngle: Math.PI },
      physical: { massKg: 0.3, friction: 0.5, restitution: 0.2, kinematic: false },
      approved: true,
      visible: true,
    };
    interaction.spawn(object, conditions());
  }

  async function enterAR(): Promise<XRFeatureReport> {
    if (inSession && features) return features;
    if (sessionPending) throw new Error('startCamera: a start is already in progress');
    sessionPending = true;
    const enabled: string[] = [];
    const missing: string[] = [];
    try {
      await frameSource.start();
      enabled.push(`video:${frameSource.kind}`);
      try {
        await poseSource.start();
        enabled.push(`pose:${poseSource.quality.mode}`);
      } catch (err) {
        missing.push(`pose:${poseSource.quality.mode}`);
        diagState.error = err instanceof Error ? err.message : String(err);
      }
      void depthEstimator.start().then(
        () => {
          if (depthEstimator.status.state === 'ready') enabled.push(`depth:${depthEstimator.status.backend}`);
          else missing.push('depth:model');
        },
        () => missing.push('depth:model'),
      );
      inSession = true;
      features = {
        supported: true,
        enabled,
        missing,
        blendMode: 'alpha-blend',
      };
      diagState.error = null;
      return features;
    } catch (err) {
      diagState.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      sessionPending = false;
    }
  }

  async function exitAR(): Promise<void> {
    if (!inSession) return;
    frameSource.stop();
    inSession = false;
    features = null;
  }

  /**
   * Discover real objects from the depth volumes and make them movable right
   * away. Pressing Discover is the approval gesture on this backend (there is
   * no per-object approval UI on a webcam page), so every candidate with a
   * support surface is approved, its appearance is captured from the live
   * frame, and a SYNTHETIC support plate (tier D: move/restore/undo, no
   * delete) fills the footprint it will leave behind. Candidates already
   * registered keep their state.
   */
  async function runCandidateDiscovery(): Promise<string[]> {
    const candidates = capture.discover([...surfaceEstimator.volumes], store.current);
    const ids: string[] = [];
    for (const candidate of candidates) {
      if (store.current.objects[candidate.object.id]) {
        ids.push(candidate.object.id);
        continue;
      }
      const result = store.dispatch(
        { intent: { kind: 'registerObject', object: candidate.object }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
      if (!result.ok) continue;
      ids.push(candidate.object.id);
      // Measured (ZED SDK) depth: the volume's base is trustworthy even when no registered surface sits under it.
      if (candidate.object.supportSurfaces.length > 0 || zedSdk) {
        store.dispatch(
          { intent: { kind: 'approve', objectId: candidate.object.id, approved: true }, source: 'ui', issuedAt: performance.now(), basedOnVersion: store.current.version },
          conditions(),
        );
        await prepareRealObject(candidate.object.id);
      }
    }
    return ids;
  }

  /** Appearance from the live frame + synthetic support plate so a discovered real object can be moved (tier D). */
  async function prepareRealObject(objectId: string): Promise<{ tier: string; donorFraction: number }> {
    const obj = store.current.objects[objectId];
    if (!obj) return { tier: 'E', donorFraction: 0 };
    // Seed up to APPEARANCE_FRAME_COUNT live frames right away: with a static camera they are
    // near-identical (still useful noise reduction for the impostor cutout via SilhouetteTracker's
    // median); with a moving one each capture is a different viewpoint.
    for (let i = 0; i < APPEARANCE_FRAME_COUNT; i++) {
      await captureObjectAppearance(objectId);
    }
    const frame = await cameraFrameSource.capture(poseSource.pose);
    if (!frame) return { tier: obj.tier, donorFraction: 0 };
    const support = obj.supportSurfaces[0] ? store.current.surfaces[obj.supportSurfaces[0]] : undefined;
    const half = obj.occlusionProxy.kind === 'box' ? obj.occlusionProxy.halfExtents : { x: 0.15, y: 0.15, z: 0.15 };
    const region = footprintFromProxy(obj.currentPose.position, half, support);
    const { plate, donorFraction } = synthesizeSupportPlate(obj, region, frame, { registry: textureRegistry });
    if (plate.provenance === 'unavailable') return { tier: obj.tier, donorFraction };
    store.dispatch(
      { intent: { kind: 'updateBackground', objectId, plate }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
      conditions(),
    );
    const tier = tierForSyntheticPlate();
    store.dispatch(
      { intent: { kind: 'setTier', objectId, tier, confidence: Math.min(0.6, donorFraction) }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
      conditions(),
    );
    return { tier, donorFraction };
  }

  /**
   * Clean-plate capture through the camera: the camera cannot be moved to
   * planned viewpoints, so the plate is acquired from the current pose (the
   * guide asks the user to move the camera between shots when a later phase
   * adds visual tracking). Estimated depth caps the tier (docs: truthfulness
   * contract) via `capTierForEstimatedDepth`.
   */
  async function captureCleanPlate(objectId: string): Promise<{ tier: string; coverage: number; blocked?: boolean }> {
    const snapshot = store.current;
    const obj = snapshot.objects[objectId];
    if (!obj) return { tier: 'E', coverage: 0 };
    const supportSurface = obj.supportSurfaces[0] ? snapshot.surfaces[obj.supportSurfaces[0]] : undefined;

    // Verify the object is actually gone before spending a capture on it: a static camera
    // cannot re-check from another angle the way a moving XR headset can (edit/gone-check.ts).
    const latestForGoneCheck = depthEstimator.latest;
    if (latestForGoneCheck) {
      const previousBlobDepthM = silhouetteTracker.peek(objectId)?.blobDepthM;
      const goneCheck = checkObjectGone(depthFrameFromMap(latestForGoneCheck), obj, supportSurface, previousBlobDepthM);
      if (!goneCheck.gone && goneCheck.reason === 'still-present') {
        setTransientHint('Remove the object from the desk, then press Capture plate again.');
        return { tier: obj.tier, coverage: 0, blocked: true };
      }
    }

    // A static camera gets one (noise-reduced) shot: several quick grabs from the same
    // viewpoint, averaged (edit/average-frames.ts). A moving one (orientation/visual pose) is
    // asked for MULTI_SHOT_COUNT shots from bearings at least MULTI_SHOT_BEARING_RAD apart,
    // which is what the multi-view agreement check in tier-cap.ts needs to lift the tier-B cap.
    const isStatic = poseSource.quality.mode === 'static';
    const shots = isStatic ? 1 : MULTI_SHOT_COUNT;
    const viewpoints: Pose[] = [];
    guide = makeActiveGuide(obj, 1, shots, poseSource.pose);
    let shotIndex = 0;
    const shotSource: CameraFrameSource = {
      get available() {
        return cameraFrameSource.available;
      },
      async capture(): Promise<CameraFrame | null> {
        shotIndex += 1;
        if (isStatic) {
          const raw: CameraFrame[] = [];
          for (let i = 0; i < AVERAGE_SHOT_COUNT; i++) {
            const f = await cameraFrameSource.capture(poseSource.pose);
            if (f) raw.push(f);
            if (i < AVERAGE_SHOT_COUNT - 1) await new Promise((r) => setTimeout(r, AVERAGE_SHOT_INTERVAL_MS));
          }
          viewpoints.push(poseSource.pose);
          return raw.length > 0 ? averageFrames(raw) : null;
        }
        if (shotIndex > 1) {
          const previous = viewpoints[viewpoints.length - 1];
          guide = { ...makeActiveGuide(obj, Math.min(shotIndex, shots), shots, poseSource.pose), hint: 'Move the camera to one side, keep the spot in view' };
          const deadline = performance.now() + MULTI_SHOT_TIMEOUT_MS;
          while (previous && bearingDelta(previous, poseSource.pose) < MULTI_SHOT_BEARING_RAD && performance.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        viewpoints.push(poseSource.pose);
        return cameraFrameSource.capture(poseSource.pose);
      },
    };
    try {
      const plan: Pose[] = [];
      for (let i = 0; i < shots; i++) plan.push(poseSource.pose);
      const acquired = await capture.acquireCleanPlate({ object: obj, supportSurface, viewpoints: plan }, shotSource);
      const verified = await capture.verify(acquired, [], cameraFrameSource);
      const capped = capTierForSingleViewpoint(capTierForEstimatedDepth(acquired.plate, verified, acquired.frames), acquired.frames);
      tierCapFrames.set(objectId, acquired.frames);
      store.dispatch(
        { intent: { kind: 'updateBackground', objectId, plate: capped.plate }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
      store.dispatch(
        { intent: { kind: 'setTier', objectId, tier: capped.tier, confidence: capped.confidence }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
      setTransientHint(`Clean plate captured (tier ${capped.tier}): Delete is now available.`);
      return { tier: capped.tier, coverage: capped.plate.coverage };
    } finally {
      guide = INACTIVE_GUIDE;
    }
  }

  /**
   * Keeps up to `APPEARANCE_FRAME_COUNT` live frames (RGB + depth + pose) for a discovered
   * object under `appearanceFrameKey` (see edit/appearance.ts): the impostor
   * (src/camera/impostor.ts) uses the most recent one as the primary render path with a static
   * camera; the depth-mesh appearance path (src/render/objects.ts) takes over once the camera
   * has moved away from every retained frame's viewpoint.
   */
  async function captureObjectAppearance(objectId: string): Promise<{ frames: number }> {
    const obj = store.current.objects[objectId];
    if (!obj) return { frames: 0 };
    const frame = await cameraFrameSource.capture(poseSource.pose);
    if (!frame) return { frames: frameStore.get(appearanceFrameKey(objectId))?.length ?? 0 };
    const frames = pushAppearanceFrame(frameStore.get(appearanceFrameKey(objectId)), frame, APPEARANCE_FRAME_COUNT);
    frameStore.put(appearanceFrameKey(objectId), frames);
    store.dispatch(
      { intent: { kind: 'setVisual', objectId, visual: { kind: 'baked' } }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
      conditions(),
    );
    return { frames: frames.length };
  }

  async function captureRoomShell(): Promise<{ framesCaptured: number }> {
    if (!cameraFrameSource.available) {
      frameStore.delete(ROOM_SHELL_FRAME_ID);
      return { framesCaptured: 0 };
    }
    const frame = await cameraFrameSource.capture(poseSource.pose);
    const frames = frame ? [frame] : [];
    frameStore.put(ROOM_SHELL_FRAME_ID, frames);
    return { framesCaptured: frames.length };
  }

  // Persistent, smoothed registry between the flickering estimator and the store (surfaces/registry.ts).
  const surfaceRegistry = new SurfaceRegistry({ keepAliveMs: 6000, smoothing: 0.3, minObservations: 2 });
  let lastIngestedRunAt = -Infinity;
  function registerEstimatedSurfaces(now: number): void {
    // Only ingest a NEW estimator run (the same run re-ingested would count as extra observations).
    if (surfaceEstimator.lastRunAt === lastIngestedRunAt && floorRegistered) return;
    lastIngestedRunAt = surfaceEstimator.lastRunAt;
    const delta = surfaceRegistry.ingest(surfaceEstimator.surfaces, now);
    for (const surface of delta.register) {
      store.dispatch(
        { intent: { kind: 'registerSurface', surface }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
    }
    for (const id of delta.remove) {
      if (!store.current.surfaces[id]) continue;
      store.dispatch(
        { intent: { kind: 'removeSurface', surfaceId: id }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
    }
    floorRegistered = true;
  }

  // ---- Frame loop ---------------------------------------------------------
  const tmpFwd = new THREE.Vector3();
  renderer.setAnimationLoop((time: number) => {
    const now = performance.now();
    const frameMs = lastFrameTime !== null ? now - lastFrameTime : 16.7;
    lastFrameTime = now;

    // Pose -> camera.
    poseSource.update(now);
    const pose = poseSource.pose;
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    camera.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
    const intr = frameSource.intrinsics;
    const fovDeg = (intr.fovY * 180) / Math.PI;
    const viewAspect = (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight);
    // The video is drawn with object-fit: cover, so the overlay camera must cover the same
    // field: keep the video's vertical FOV when the viewport is wider than the video,
    // otherwise widen the horizontal FOV to match (crop the vertical field).
    let effectiveFovDeg = fovDeg;
    if (viewAspect < intr.aspect) {
      const halfH = Math.tan(intr.fovY / 2) * intr.aspect; // half horizontal tan of the video
      const croppedHalfV = halfH / viewAspect;
      effectiveFovDeg = (2 * Math.atan(croppedHalfV) * 180) / Math.PI;
    }
    if (Math.abs(camera.fov - effectiveFovDeg) > 1e-3 || Math.abs(camera.aspect - viewAspect) > 1e-3) {
      camera.fov = effectiveFovDeg;
      camera.aspect = viewAspect;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);

    // Surfaces from depth (ground plane, tables at any height, walls, volumes) -> store.
    surfaceEstimator.update(depthEstimator.latest, pose, now);
    zedSdk?.onSurfaces(surfaceEstimator);
    const correction = surfaceEstimator.correction;
    if (correction && correction.at !== lastCorrectionAt) {
      lastCorrectionAt = correction.at;
      diagState.estPitchDeg = (correction.pitchRad * 180) / Math.PI;
      diagState.estRollDeg = (correction.rollRad * 180) / Math.PI;
      // A static camera learns its attitude from the dominant plane, but only from a LARGE,
      // confident, STABLE plane (a sloped duvet or a small noisy fit must not tilt the world),
      // clamped to the preset pitch +-10 degrees and smoothed with a 2 s time constant.
      pitchHistory.push(correction.pitchRad);
      if (pitchHistory.length > ATTITUDE_STABLE_RUNS) pitchHistory.shift();
      const stable = pitchHistory.length === ATTITUDE_STABLE_RUNS && Math.max(...pitchHistory) - Math.min(...pitchHistory) < ATTITUDE_STABLE_RAD;
      let note = '';
      if (!staticBase || tuning.value.autoAttitude < 1) note = 'auto attitude off';
      else if (correction.confidence <= 0.6) note = `plane conf ${correction.confidence.toFixed(2)} <= 0.6`;
      else if (correction.inliers <= ATTITUDE_MIN_INLIERS) note = `plane ${correction.inliers} pts <= ${ATTITUDE_MIN_INLIERS}`;
      else if (correction.extentM < ATTITUDE_MIN_EXTENT_M) note = `plane ${correction.extentM.toFixed(1)} m < ${ATTITUDE_MIN_EXTENT_M} m`;
      else if (!stable) note = `pitch not stable over ${ATTITUDE_STABLE_RUNS} runs`;
      if (staticBase && note === '') {
        note = 'applying (clamped to preset +-10 deg)';
        const dt = Number.isFinite(lastAttitudeApplyAt) ? now - lastAttitudeApplyAt : 400;
        lastAttitudeApplyAt = now;
        const k = 1 - Math.exp(-dt / ATTITUDE_TAU_MS);
        const presetPitch = (presetPitchDeg * Math.PI) / 180;
        const targetPitch = Math.max(presetPitch - ATTITUDE_PITCH_CLAMP_RAD, Math.min(presetPitch + ATTITUDE_PITCH_CLAMP_RAD, correction.pitchRad));
        const pitch = staticBase.pitch + k * (targetPitch - staticBase.pitch);
        const roll = staticBase.roll + k * (correction.rollRad - staticBase.roll);
        staticBase.setPitch(pitch);
        staticBase.setRoll(Math.max(-0.5, Math.min(0.5, roll)));
      }
      diagState.attitudeNote = note;
      if (staticBase) {
        diagState.appliedPitchDeg = (staticBase.pitch * 180) / Math.PI;
        diagState.appliedRollDeg = (staticBase.roll * 180) / Math.PI;
      }
    }
    if (!floorRegistered || now - lastSurfaceRegisterAt > 250) {
      lastSurfaceRegisterAt = now;
      registerEstimatedSurfaces(now);
      if (debugOverlay.group.visible) debugOverlay.update(surfaceEstimator.surfaces, surfaceEstimator.volumes);
    }

    // Grab a downscaled frame every GRAB_INTERVAL_MS for optical flow (motion / tracking loss)
    // and, when the estimator is ready, for depth - at most one inference in flight, never awaited.
    if (inSession && frameSource.ready && now - lastGrabAt > GRAB_INTERVAL_MS) {
      lastGrabAt = now;
      const grabbed = stereoSource && frameSource.grabStereo ? frameSource.grabStereo(STEREO_WORK_WIDTH) : frameSource.grab(CAPTURE_WIDTH);
      if (grabbed) {
        visualPose?.pushFrame(grabbed, intr, now);
        const interval = stereoSource ? STEREO_SUBMIT_INTERVAL_MS : DEPTH_SUBMIT_INTERVAL_MS;
        if (depthEstimator.status.state === 'ready' && now - lastDepthSubmitAt > interval && depthEstimator.submit(grabbed, pose, intr)) {
          lastDepthSubmitAt = now;
        }
      }
    }

    const cond = conditions();
    pointer.update();
    interaction.update(pointer.state, cond);
    physicsBridge.update(now);
    views.hoveredId = interaction.hoveredId;
    views.selectedId = interaction.selectedId;
    views.grabbedId = interaction.selectedId;

    const committed = store.current;
    regionManager.tick(cond, committed.mode, quality.decision, [cond.headPose.position]);
    regionManager.recoverTrackingFallbacks(cond);

    const frameSnapshot = store.current;

    // Track each present physical object's depth-blob silhouette against the
    // latest depth map while it still sits at its original pose; once it
    // moves/is hidden (or the depth briefly loses it, e.g. the user just
    // lifted it away for Capture plate), tracking stops feeding new frames
    // and `peek()` keeps returning the last frozen mask - the object's own
    // shape, needed by the impostor cutout and the static-camera eraser
    // below for exactly that moved/deleted state. Only forgotten (`clear`)
    // once the object is gone from the scene entirely.
    const trackedPhysicalIds = new Set<string>();
    const latestDepth = depthEstimator.latest;
    for (const obj of Object.values(frameSnapshot.objects)) {
      if (obj.origin !== 'physical') continue;
      trackedPhysicalIds.add(obj.id);
      if (!latestDepth || !obj.visible) continue;
      // Looser than the hull/impostor "has it moved" threshold (0.005 m, EPS_POS in
      // impostor.ts): physics settle on a non-kinematic discovered object nudges it a
      // centimetre or so even standing still, which must not stop live silhouette tracking.
      const stillAtOriginalSpot =
        Math.hypot(
          obj.originalPose.position.x - obj.currentPose.position.x,
          obj.originalPose.position.y - obj.currentPose.position.y,
          obj.originalPose.position.z - obj.currentPose.position.z,
        ) <= STILL_AT_ORIGINAL_SPOT_M;
      // Also stop once a clean plate has been captured (tier D -> B/C): that means removal was
      // already confirmed, so the object's real-world counterpart is gone and any further match
      // against live depth in its footprint is noise (e.g. floor/plane pixels coincidentally
      // within the depth-agreement tolerance), not the object - it would corrupt the frozen
      // mask the impostor/eraser still need. Tier D means "still there, being tracked".
      if (stillAtOriginalSpot && obj.tier === 'D') silhouetteTracker.update(obj.id, depthFrameFromMap(latestDepth), obj);
    }
    for (const id of lastTrackedPhysicalIds) {
      if (!trackedPhysicalIds.has(id)) silhouetteTracker.clear(id);
    }
    lastTrackedPhysicalIds = trackedPhysicalIds;

    views.update(frameSnapshot);
    views.updatePreview(frameSnapshot, previewGroup);
    impostors.update(frameSnapshot, camera, now);
    // Multi-frame appearance (edit/appearance.ts): the impostor (single-viewpoint billboard)
    // is the primary path only while the camera hasn't moved away from where its retained
    // appearance frames were captured; once it has, force the impostor hidden and fall back
    // to ObjectViews' own depth-mesh appearance (built from every retained frame at once,
    // src/render/objects.ts), which stays correct from other angles.
    for (const obj of Object.values(frameSnapshot.objects)) {
      if (obj.origin !== 'physical' || !isImpostorActive(impostors, obj.id)) continue;
      const frames = frameStore.get(appearanceFrameKey(obj.id));
      if (frames && frames.length > 0 && cameraMovedFromAppearance(frames, poseSource.pose)) {
        impostors.forceHide(obj.id);
      }
    }
    // The impostor (when still active) replaces ObjectViews' own depth-mesh appearance for
    // the same object.
    views.group.traverse((o) => {
      if (!o.name.startsWith('object-appearance:')) return;
      const id = o.name.slice('object-appearance:'.length);
      if (isImpostorActive(impostors, id)) o.visible = false;
    });
    plates.update(frameSnapshot, cond.headPose);
    backgroundHull.update(frameSnapshot, cond.headPose);

    // Static-camera fast path for Delete: composites the clean-plate frame's own pixels into
    // the tracked silhouette (exact when the camera hasn't moved); a world-space quad drawn
    // over the hull's own meshes. No-op (nothing built/shown) otherwise, so the hull stands.
    const eraserMasks = new Map<string, SilhouetteMask>();
    for (const obj of Object.values(frameSnapshot.objects)) {
      if (obj.origin !== 'physical') continue;
      const hidden = !obj.visible || Math.hypot(
        obj.originalPose.position.x - obj.currentPose.position.x,
        obj.originalPose.position.y - obj.currentPose.position.y,
        obj.originalPose.position.z - obj.currentPose.position.z,
      ) > 0.005;
      if (!hidden) continue;
      const mask = silhouetteTracker.peek(obj.id);
      if (mask) eraserMasks.set(obj.id, mask);
    }
    staticEraser.update(frameSnapshot, eraserMasks, visualPose?.motionPx ?? 0, latestDepth?.width ?? 0, latestDepth?.height ?? 0, camera);

    shell.update(frameSnapshot, []);
    guideOverlay.update(guide, 0);
    depthOccluder.update(depthEstimator.latest, now, tuning.value.occluderEnabled >= 1, tuning.value.occluderBiasM);

    // Video fps estimate for diagnostics.
    if (frameSource.lastFrameAt !== lastVideoFrameAt) {
      lastVideoFrameAt = frameSource.lastFrameAt;
      videoFrameCounter += 1;
    }
    if (now - videoFpsWindowStart > 1000) {
      diagState.videoFps = videoFrameCounter / ((now - videoFpsWindowStart) / 1000);
      videoFrameCounter = 0;
      videoFpsWindowStart = now;
    }

    if (now - lastDiagAt > 250) {
      lastDiagAt = now;
      const q = poseSource.quality;
      diagState.videoReady = frameSource.ready;
      diagState.videoSize = intr.width > 0 ? `${intr.width}x${intr.height}` : '';
      diagState.poseMode = q.mode;
      diagState.poseConfidence = q.confidence;
      diagState.trackingOk = q.trackingOk;
      diagState.poseSampleAgeMs = q.sampleAgeMs;
      diagState.cameraHeightM = surfaceEstimator.cameraHeightM;
      diagState.tuningHeightM = tuning.value.cameraHeightM;
      diagState.fovYDeg = fovDeg;
      const ds = depthEstimator.status;
      diagState.depthState = ds.state;
      diagState.depthBackend = ds.backend;
      diagState.depthModel = ds.modelId;
      diagState.depthInferenceMs = ds.lastInferenceMs;
      diagState.depthAgeMs = depthAgeMs(now);
      diagState.depthConfidence = depthEstimator.latest?.confidence ?? 0;
      diagState.depthFrames = ds.frames;
      diagState.depthPublishedAgoMs = Number.isFinite(ds.lastPublishedAt) ? now - ds.lastPublishedAt : Infinity;
      diagState.depthFitMode = ds.fitMode;
      if (stereoDepth) {
        const st = stereoDepth.stats;
        diagState.stereoLine = `stereo ${st.workWidth}x${st.workHeight} d0..${st.maxDisparity} valid ${(st.validFraction * 100).toFixed(0)}% ${st.lastMs.toFixed(0)} ms ${st.rectified ? 'rectified' : 'unrectified'}${stereoSource?.stereo?.calibrationId ? ` SN${stereoSource.stereo.calibrationId}` : ''}`;
      } else if (zedSdk) {
        diagState.stereoLine = zedSdk.statusLine();
      } else if (stereoSource) {
        diagState.stereoLine = `stereo source ${stereoSource.stereo?.eyeWidth ?? 0}x${stereoSource.stereo?.eyeHeight ?? 0}${stereoSource.calibration ? ` SN${stereoSource.calibration.serial ?? '?'} calibrated` : ' nominal'}; matcher not available, monocular fallback`;
      }
      diagState.depthScale = tuning.value.depthScale;
      diagState.rollCorroborated = surfaceEstimator.correction?.rollCorroborated ?? false;
      diagState.floorConfidence = surfaceEstimator.surfaces[0]?.confidence ?? 0;
      diagState.surfaceCount = Object.keys(frameSnapshot.surfaces).length;
      diagState.volumeCount = surfaceEstimator.volumes.length;
      diagState.tables = surfaceEstimator.lastStats.tables;
      diagState.walls = surfaceEstimator.lastStats.walls;
      diagState.surfaceRunMs = surfaceEstimator.lastStats.runMs;
      diagState.motionPx = visualPose?.motionPx ?? 0;
      diagState.tierCap = (depthEstimator.latest?.source === 'stereo' || depthEstimator.latest?.source === 'zed-sdk') && (depthEstimator.latest.confidence ?? 0) >= 0.8 ? 'A' : depthEstimator.latest?.source === 'monocular' || depthEstimator.latest?.source === 'stereo' ? 'B' : 'C';
      diagState.qualityTier = quality.decision.tier;
      diagState.frameP95 = perf.stats('frameMs').p95;
      diagState.objectCount = Object.keys(frameSnapshot.objects).length;
      diagState.hoverId = pointer.hoverId;
      diagState.pointerWorld = pointer.state.right.active ? { x: pointer.pointerWorld.x, y: pointer.pointerWorld.y, z: pointer.pointerWorld.z } : null;
      diagState.error = ds.error ?? diagState.error;
      diagnostics.update(diagState);
      const hint = workflowHint();
      if (hint !== lastHint) {
        lastHint = hint;
        hintEl.textContent = hint;
      }
      domHud.update(
        {
          tier: cond.tier,
          frameP95: perf.stats('frameMs').p95,
          depthAgeMs: cond.depthAgeMs,
          mode: frameSnapshot.mode,
          selectedObjectId: interaction.selectedId,
          lastRejection: interaction.lastRejection,
          guide,
        },
        quality.decision,
        now,
      );
    }

    const appMs = performance.now() - now;
    const sample: FrameSample = {
      t: now,
      frameMs,
      depthAgeMs: cond.depthAgeMs,
      trackingOk: cond.trackingOk,
      droppedFrames: Math.max(0, Math.round(frameMs / TARGET_FRAME_MS) - 1),
      thermalThrottled: false,
      memoryPressure: false,
      handConfidence: 1,
      registrationErrorM: poseSource.quality.driftM,
      appMs,
    };
    diagState.appMs = appMs;
    perf.push(sample);
    quality.observe(sample);

    renderer.render(scene, camera);

    camera.getWorldDirection(tmpFwd);
    options.onFrame?.({ time, headPose: cond.headPose, snapshot: store.current, decision: quality.decision });
  });

  // ---- Handles ----------------------------------------------------------------
  const handle: AppHandle = {
    store,
    perf,
    quality,
    freshness,
    enterAR,
    exitAR,
    get inSession() {
      return inSession;
    },
    get features() {
      return features;
    },
    runCandidateDiscovery,
    captureCleanPlate,
    captureObjectAppearance,
    captureRoomShell,
    grab(objectId, hand) {
      return interaction.grab(objectId, hand);
    },
    release(hand) {
      interaction.release(hand, conditions());
    },
    reportObstruction(point) {
      regionManager.reportObstructionAt(point, conditions());
    },
    get guide() {
      return guide;
    },
    voice: { submitText: (text) => voice.submitText(text), get listening() { return voice.listening; } },
    catalog: CATALOG,
    spawnAsset,
    get anchorStatus() {
      return { localized: poseSource.quality.trackingOk, relocalizationMs: 0, hasPersistentHandle: false };
    },
    dispose(): void {
      renderer.setAnimationLoop(null);
      voice.dispose();
      pointer.dispose();
      depthEstimator.dispose();
      surfaceEstimator.dispose();
      poseSource.dispose();
      frameSource.stop();
      views.dispose();
      plates.dispose();
      backgroundHull.dispose();
      shell.dispose();
      guideOverlay.dispose();
      domHud.dispose();
      diagnostics.dispose();
      tuningPanel.dispose();
      hintEl.remove();
      window.removeEventListener('keydown', onCalibrateKey);
      window.removeEventListener('keydown', onOverlayKey);
      window.removeEventListener('keydown', onOccluderKey);
      debugOverlay.dispose();
      impostors.dispose();
      depthOccluder.dispose();
      disposeRenderer();
      video.remove();
      if (window.__realityEditor === handle) delete window.__realityEditor;
      if (window.__camera === cameraHandle) delete window.__camera;
    },
  };

  const cameraHandle: CameraHandle = {
    config,
    frameSource,
    poseSource,
    surfaceEstimator,
    depthEstimator,
    pointer,
    diagnostics: diagState,
    projectToNdc(worldPos) {
      const v = new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z).project(camera);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.z > 1) return null;
      return { x: v.x, y: v.y };
    },
    ndcToVideoUv,
    debugEraserPositions: () => staticEraser.group.children.map((c) => ({ pos: c.position.clone(), visible: c.visible })),
    worldAtPixel(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
      const picked = pickWorld(ndcX, ndcY);
      if (picked) return picked;
      const ray: PointerRay = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };
      rayFromNdc(ndcX, ndcY, ray);
      return intersectPlaneY(ray, 0) ?? { x: ray.origin.x + ray.direction.x * 2.5, y: ray.origin.y + ray.direction.y * 2.5, z: ray.origin.z + ray.direction.z * 2.5 };
    },
    setCameraHeight(h) {
      poseSource.setHeight(h);
      surfaceEstimator.setHeight(h);
      diagState.cameraHeightM = h;
    },
    setFovY(rad) {
      frameSource.setFovY(rad);
    },
    renderStats() {
      let appearanceActive = 0;
      views.group.traverse((o) => {
        if (o.name.startsWith('object-appearance:') && o.visible && o.children.length > 1) appearanceActive += 1;
      });
      let impostorCount = 0;
      let masksTracked = 0;
      for (const id of Object.keys(store.current.objects)) {
        if (isImpostorActive(impostors, id)) impostorCount += 1;
        if (silhouetteTracker.peek(id)) masksTracked += 1;
      }
      return {
        hullChildren: backgroundHull.group.children.length,
        viewChildren: views.group.children.length,
        appearanceActive,
        impostors: impostorCount,
        eraserActive: staticEraser.activeCount,
        masksTracked,
      };
    },
    tuning,
    pickWorld,
    pickWorldDetailed,
    prepareRealObject,
    calibrateNearFar(ndcNear, mNear, ndcFar, mFar) {
      if (!(depthEstimator instanceof ModelDepthEstimator) || !depthEstimator.lastInverse) return false;
      const near = ndcToVideoUv(ndcNear.x, ndcNear.y);
      const far = ndcToVideoUv(ndcFar.x, ndcFar.y);
      tuning.patch({ anchorNearU: near.u, anchorNearV: near.v, anchorNearM: mNear, anchorFarU: far.u, anchorFarV: far.v, anchorFarM: mFar, depthScale: 1, depthShiftM: 0 });
      return true;
    },
    clearAnchors() {
      tuning.patch({ anchorNearM: 0, anchorFarM: 0 });
    },
    get occluder() {
      return { ...depthOccluder.state };
    },
    calibrateAt(ndcX, ndcY, distanceM) {
      const map = depthEstimator.latest;
      if (!map || (map.source !== 'monocular' && map.source !== 'stereo')) return null;
      const { u, v } = ndcToVideoUv(ndcX, ndcY);
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      const px = Math.min(map.width - 1, Math.floor(u * map.width));
      const py = Math.min(map.height - 1, Math.floor(v * map.height));
      // Median of a 5x5 patch: a single pixel of monocular depth is noisy.
      const vals: number[] = [];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = Math.min(map.width - 1, Math.max(0, px + dx));
          const y = Math.min(map.height - 1, Math.max(0, py + dy));
          const d = map.metric[y * map.width + x] as number;
          if (d > 0) vals.push(d);
        }
      }
      if (vals.length === 0 || !(distanceM > 0)) return null;
      vals.sort((a, b) => a - b);
      const current = vals[Math.floor(vals.length / 2)] as number;
      if (map.source === 'stereo') {
        // Z = fx * B / d: a distance error is a focal-length error; scale fx.
        const factor = (distanceM / current) * tuning.value.stereoFxScale;
        tuning.set('stereoFxScale', factor);
        return factor;
      }
      // `current` already includes the previous scale; the new factor is relative to the unscaled fit.
      const factor = (distanceM / current) * tuning.value.depthScale;
      tuning.set('depthScale', factor);
      return factor;
    },
  };

  window.__realityEditor = handle;
  window.__camera = cameraHandle;
  void poseFromCamera;

  if (options.autoStart) {
    try {
      await enterAR();
    } catch (err) {
      console.error('[camera] start failed', err);
    }
  }

  return { handle, camera: cameraHandle };
}

export default startCameraApp;
