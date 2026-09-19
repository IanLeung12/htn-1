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
import { PointerInputAdapter, intersectPlaneY, type PointerRay } from './input/pointer';
import { StaticPoseSource } from './pose/static';
import type { VisualPoseSource } from './pose/visual';
import { ModelDepthEstimator } from './depth/model';
import { TuningStore, type CameraTuning } from './tuning';
import { TuningPanel } from './tuning-panel';
import { synthesizeSupportPlate, tierForSyntheticPlate } from './synthetic-plate';
import { footprintFromProxy } from '@/capture';
import { unprojectPixel } from '@/capture/geom';
import { surfaceBelow } from '@/core';
import { CameraDiagnostics, type CameraDiagnosticsState } from './diagnostics';
import { createDepthEstimator } from './depth';
import { capTierForEstimatedDepth } from './tier-cap';

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
  /** Change the camera height above the floor (metres). */
  setCameraHeight(h: number): void;
  setFovY(rad: number): void;
  /** Renderer-side counts for tests/diagnostics (hull meshes drawn over the video, object views). */
  renderStats(): { hullChildren: number; viewChildren: number };
  /** Live tunables (persisted in localStorage; `t` toggles the slider panel). */
  readonly tuning: TuningStore;
  /** World point the estimated depth sees at a canvas NDC position (snapped onto the surface below); null without depth. */
  pickWorld(ndcX: number, ndcY: number): Vec3 | null;
  /** Capture appearance + synthetic support plate for a discovered real object (tier D) so it can be moved. */
  prepareRealObject(objectId: string): Promise<{ tier: string; donorFraction: number }>;
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
/** Farthest a spawned object is placed from the camera along the floor (m). */
const SPAWN_MAX_M = 2.0;
/** Clean-plate shots requested from a moving (non-static) camera; see tier-cap.ts's agreement rule. */
const MULTI_SHOT_COUNT = 3;
const MULTI_SHOT_BEARING_RAD = (16 * Math.PI) / 180;
const MULTI_SHOT_TIMEOUT_MS = 8000;

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
  const frameSource = createFrameSource(config);
  const poseSource = createPoseSource(config);
  // Floor prior until estimated depth is confident enough for RANSAC planes/volumes (computed in a worker).
  const surfaceEstimator = new WorkerSurfaceEstimator({ cameraHeightM: config.cameraHeightM, getTuning: () => tuning.value });
  const depthEstimator = createDepthEstimator(config, () => surfaceEstimator.cameraHeightM);
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
    }
  };
  applyDepthAdjust();
  tuning.subscribe((t, key) => {
    if (key === null || key === 'cameraHeightM') {
      poseSource.setHeight(t.cameraHeightM);
      surfaceEstimator.setHeight(t.cameraHeightM);
    }
    if ((key === null || key === 'pitchDeg') && staticBase) staticBase.setPitch((t.pitchDeg * Math.PI) / 180);
    if (key === null || key === 'fovYDeg') frameSource.setFovY((t.fovYDeg * Math.PI) / 180);
    if (key === null || key === 'depthScale' || key === 'depthShiftM' || key === 'depthSmoothing') applyDepthAdjust();
  });

  // ---- Renderer: video under a transparent canvas ---------------------
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.style.background = '#000';
  const video = frameSource.video;
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
  const pointer = new PointerInputAdapter({ element: canvas, store, rayFromNdc });

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
  };
  const diagnostics = new CameraDiagnostics(container, !headless);
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
    const map = depthEstimator.latest;
    if (!map || map.confidence < 0.3 || map.source === 'plane-prior') return null;
    if (performance.now() - map.timestamp > 3000) return null;
    const { u, v } = ndcToVideoUv(ndcX, ndcY);
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const px = Math.min(map.width - 1, Math.floor(u * map.width));
    const py = Math.min(map.height - 1, Math.floor(v * map.height));
    const d = map.metric[py * map.width + px] as number;
    if (!(d > 0)) return null;
    const point = unprojectPixel(px + 0.5, py + 0.5, d, map.pose, map.fovY, map.aspect, map.width, map.height);
    const below = surfaceBelow(store.current, { x: point.x, y: point.y + 0.05, z: point.z });
    if (below && point.y + 0.05 - below.aabb.max.y < 0.2) point.y = below.aabb.max.y;
    return point;
  }

  function spawnTarget(): Vec3 {
    const pw = pointer.pointerWorld;
    if (pointer.state.right.active && pointer.hoverId === null) {
      // Prefer what the depth sees under the pointer (a desk, a bed), else the ground plane.
      const picked = pickWorld(pointer.lastNdcX, pointer.lastNdcY);
      if (picked) return picked;
      if (Math.abs(pw.y) < 0.01) return { x: pw.x, y: 0, z: pw.z };
    }
    const centre = pickWorld(0, -0.2);
    if (centre) return centre;
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
      if (candidate.object.supportSurfaces.length > 0) {
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
    await captureObjectAppearance(objectId);
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
  async function captureCleanPlate(objectId: string): Promise<{ tier: string; coverage: number }> {
    const snapshot = store.current;
    const obj = snapshot.objects[objectId];
    if (!obj) return { tier: 'E', coverage: 0 };
    const supportSurface = obj.supportSurfaces[0] ? snapshot.surfaces[obj.supportSurfaces[0]] : undefined;
    // A static camera gets one shot. A moving one (orientation/visual pose) is asked for
    // MULTI_SHOT_COUNT shots from bearings at least MULTI_SHOT_BEARING_RAD apart, which is
    // what the multi-view agreement check in tier-cap.ts needs to lift the tier-B cap.
    const shots = poseSource.quality.mode === 'static' ? 1 : MULTI_SHOT_COUNT;
    const viewpoints: Pose[] = [];
    guide = makeActiveGuide(obj, 1, shots, poseSource.pose);
    let shotIndex = 0;
    const shotSource: CameraFrameSource = {
      get available() {
        return cameraFrameSource.available;
      },
      async capture(): Promise<CameraFrame | null> {
        shotIndex += 1;
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
      const capped = capTierForEstimatedDepth(acquired.plate, verified, acquired.frames);
      tierCapFrames.set(objectId, acquired.frames);
      store.dispatch(
        { intent: { kind: 'updateBackground', objectId, plate: capped.plate }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
      store.dispatch(
        { intent: { kind: 'setTier', objectId, tier: capped.tier, confidence: capped.confidence }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
      return { tier: capped.tier, coverage: capped.plate.coverage };
    } finally {
      guide = INACTIVE_GUIDE;
    }
  }

  async function captureObjectAppearance(objectId: string): Promise<{ frames: number }> {
    const obj = store.current.objects[objectId];
    if (!obj) return { frames: 0 };
    const frame = await cameraFrameSource.capture(poseSource.pose);
    const frames = frame ? [frame] : [];
    frameStore.put(appearanceFrameKey(objectId), frames);
    if (frames.length > 0) {
      store.dispatch(
        { intent: { kind: 'setVisual', objectId, visual: { kind: 'baked' } }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
    }
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

  const registeredSurfaceSeenAt = new Map<string, number>();
  const SURFACE_FORGET_MS = 3000;
  function registerEstimatedSurfaces(now: number): void {
    for (const est of surfaceEstimator.surfaces) {
      registeredSurfaceSeenAt.set(est.surface.id, now);
      const existing = store.current.surfaces[est.surface.id];
      if (existing && existing.lastChanged === est.surface.lastChanged) continue;
      store.dispatch(
        { intent: { kind: 'registerSurface', surface: est.surface }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
    }
    // RANSAC results flicker; only forget a surface after it has been missing for a while.
    for (const [id, seenAt] of registeredSurfaceSeenAt) {
      if (now - seenAt < SURFACE_FORGET_MS) continue;
      registeredSurfaceSeenAt.delete(id);
      if (store.current.surfaces[id]) {
        store.dispatch(
          { intent: { kind: 'removeSurface', surfaceId: id }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
          conditions(),
        );
      }
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
    const correction = surfaceEstimator.correction;
    if (correction && correction.at !== lastCorrectionAt) {
      lastCorrectionAt = correction.at;
      diagState.estPitchDeg = (correction.pitchRad * 180) / Math.PI;
      diagState.estRollDeg = (correction.rollRad * 180) / Math.PI;
      // A static camera learns its attitude from the dominant plane (smoothed); sensors keep theirs.
      if (staticBase && tuning.value.autoAttitude >= 1 && correction.confidence >= 0.3) {
        const k = 0.35;
        const pitch = staticBase.pitch + k * (correction.pitchRad - staticBase.pitch);
        const roll = staticBase.roll + k * (correction.rollRad - staticBase.roll);
        staticBase.setPitch(pitch);
        staticBase.setRoll(Math.max(-0.5, Math.min(0.5, roll)));
        const pitchDeg = (pitch * 180) / Math.PI;
        if (Math.abs(pitchDeg - tuning.value.pitchDeg) > 0.5 && now - lastTuningSyncAt > 1000) {
          lastTuningSyncAt = now;
          tuning.set('pitchDeg', Math.round(pitchDeg * 10) / 10);
        }
      }
    }
    if (!floorRegistered || now - lastSurfaceRegisterAt > 250) {
      lastSurfaceRegisterAt = now;
      registerEstimatedSurfaces(now);
    }

    // Grab a downscaled frame every GRAB_INTERVAL_MS for optical flow (motion / tracking loss)
    // and, when the estimator is ready, for depth - at most one inference in flight, never awaited.
    if (inSession && frameSource.ready && now - lastGrabAt > GRAB_INTERVAL_MS) {
      lastGrabAt = now;
      const grabbed = frameSource.grab(CAPTURE_WIDTH);
      if (grabbed) {
        visualPose?.pushFrame(grabbed, intr, now);
        if (depthEstimator.status.state === 'ready' && now - lastDepthSubmitAt > DEPTH_SUBMIT_INTERVAL_MS && depthEstimator.submit(grabbed, pose, intr)) {
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

    const frameSnapshot = store.current;
    views.update(frameSnapshot);
    views.updatePreview(frameSnapshot, previewGroup);
    plates.update(frameSnapshot, cond.headPose);
    backgroundHull.update(frameSnapshot, cond.headPose);
    shell.update(frameSnapshot, []);
    guideOverlay.update(guide, 0);

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
      diagState.fovYDeg = fovDeg;
      const ds = depthEstimator.status;
      diagState.depthState = ds.state;
      diagState.depthBackend = ds.backend;
      diagState.depthModel = ds.modelId;
      diagState.depthInferenceMs = ds.lastInferenceMs;
      diagState.depthAgeMs = depthAgeMs(now);
      diagState.depthConfidence = depthEstimator.latest?.confidence ?? 0;
      diagState.floorConfidence = surfaceEstimator.surfaces[0]?.confidence ?? 0;
      diagState.surfaceCount = Object.keys(frameSnapshot.surfaces).length;
      diagState.volumeCount = surfaceEstimator.volumes.length;
      diagState.tables = surfaceEstimator.lastStats.tables;
      diagState.walls = surfaceEstimator.lastStats.walls;
      diagState.surfaceRunMs = surfaceEstimator.lastStats.runMs;
      diagState.motionPx = visualPose?.motionPx ?? 0;
      diagState.tierCap = depthEstimator.latest?.source === 'monocular' ? 'B' : 'C';
      diagState.qualityTier = quality.decision.tier;
      diagState.frameP95 = perf.stats('frameMs').p95;
      diagState.objectCount = Object.keys(frameSnapshot.objects).length;
      diagState.hoverId = pointer.hoverId;
      diagState.pointerWorld = pointer.state.right.active ? { x: pointer.pointerWorld.x, y: pointer.pointerWorld.y, z: pointer.pointerWorld.z } : null;
      diagState.error = ds.error ?? diagState.error;
      diagnostics.update(diagState);
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
      return { hullChildren: backgroundHull.group.children.length, viewChildren: views.group.children.length };
    },
    tuning,
    pickWorld,
    prepareRealObject,
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
