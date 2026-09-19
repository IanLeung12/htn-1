/**
 * startApp: wires core store + resolver, XR session/input/scene-understanding/
 * depth, three.js renderer/views/plates/shell/hud, interaction, and the
 * capture pipeline together. No top-level side effects - everything happens
 * inside startApp() so sim.html and index.html can both import this module
 * safely (see src/app/entry.ts).
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
  nearestObjects,
} from '@/core';
import type { EditableObject, FrameSample, Pose, QualityDecision, RuntimeConditions, Vec3, VisualMode } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import type { AppHandle, AppOptions, CaptureGuide, StartApp, XRFeatureReport } from './contract';
import { requestARSession, endARSession } from '@/xr/session';
import { XRInput } from '@/xr/input';
import { SceneUnderstanding } from '@/xr/scene-understanding';
import { DepthOcclusion } from '@/xr/depth';
import { createRenderer } from '@/render/renderer';
import { ObjectViews } from '@/render/objects';
import { PlateRenderer } from '@/render/plates';
import { ShellRenderer } from '@/render/shell';
import { InXRHud, DomHud, GuideOverlay } from '@/render/hud';
import { InteractionController } from './interaction';
import { createProxyPhysics } from '@/core/physics';
import { createPhysicsBridge } from './physics-bridge';
import { installVoiceAndMenu } from './voice-install';
import { createDiagnostics, tryUpdateTargetFrameRate } from '@/render/diagnostics';
import type { DiagnosticsState } from '@/render/diagnostics';
import { RegionManager } from './regions';
import { INACTIVE_GUIDE, makeActiveGuide, planCaptureViewpoints, wrapSourceForGuide } from './guide';
import { createCapturePipeline } from '@/capture';
import { createPlateTextureRegistry } from '@/capture';
import { createFrameStore, ROOM_SHELL_FRAME_ID } from '@/capture/frame-store';
import type { CameraFrame, CameraFrameSource } from '@/capture/contract';
import { BackgroundHull } from '@/render/background-hull';
import { planRoomShellViewpoints } from './room-shell';

declare global {
  interface Window {
    __cameraFrameSource?: CameraFrameSource;
  }
}

const NO_CAMERA_SOURCE: CameraFrameSource = {
  available: false,
  async capture() {
    return null;
  },
};

function poseFromMatrix(camera: THREE.Camera): Pose {
  const p = camera.position;
  const q = camera.quaternion;
  return { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } };
}

export const startApp: StartApp = async (options: AppOptions = {}): Promise<AppHandle> => {
  const container = options.container ?? document.body;
  const headless = options.headless ?? false;

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
    const adapter = createLocalStorageAdapter('reality-editor');
    await restore(store, adapter, options.persistKey);
    autoPersist(store, adapter, options.persistKey);
  }

  const { renderer, dispose: disposeRenderer } = createRenderer(container);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 50);
  scene.add(camera);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 2, 1);
  scene.add(dirLight);

  const input = new XRInput(renderer);
  scene.add(input.group);

  const sceneUnderstanding = new SceneUnderstanding({
    registerSurface(surface) {
      store.dispatch(
        { intent: { kind: 'registerSurface', surface }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
    },
    removeSurface(surfaceId) {
      store.dispatch(
        { intent: { kind: 'removeSurface', surfaceId }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
    },
  });

  const depth = new DepthOcclusion(renderer);

  const views = new ObjectViews();
  scene.add(views.group);
  const previewGroup = new THREE.Group();
  scene.add(previewGroup);

  const textureRegistry = createPlateTextureRegistry();
  const plates = new PlateRenderer(textureRegistry);
  scene.add(plates.group);

  // Shared with the capture pipeline: holds the raw frames behind a clean
  // plate (per object id) and the room-shell orbit capture (ROOM_SHELL_FRAME_ID)
  // so the renderer can reproject the real background from wherever the head is.
  const frameStore = createFrameStore();

  const shell = new ShellRenderer(frameStore);
  scene.add(shell.occluderGroup, shell.visibleGroup);

  const backgroundHull = new BackgroundHull(frameStore);
  scene.add(backgroundHull.group);

  const interaction = new InteractionController(store);

  // Proxy physics: fixed-step settle/collide on compact proxies; moves are committed
  // through the store as system intents (no undo pollution), never from inside physics.
  const physics = createProxyPhysics();
  const physicsBridge = createPhysicsBridge(store, physics, conditions);

  // Voice is a convenience layer over the same resolver; the hand menu mirrors the HUD buttons.
  const voiceAndMenu = installVoiceAndMenu({
    store,
    interaction,
    scene,
    input,
    camera,
    conditions,
    captureCleanPlate: (id) => captureCleanPlate(id),
    spawnPrimitive: (kind) => spawnPrimitive(kind === 'cube' ? 'box' : 'sphere'),
    setMode: (mode) =>
      store.dispatch(
        { intent: { kind: 'setMode', mode }, source: 'voice', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      ),
    speak: !headless,
  });

  // On-device diagnostics panel (feature report, frame rate, counts, perf); DOM writes are throttled inside.
  const diagnostics = createDiagnostics();
  if (!headless) diagnostics.attach(container);
  const diagState: DiagnosticsState = {
    xrPresent: typeof navigator !== 'undefined' && !!navigator.xr,
    arSupported: null,
    inSession: false,
    featureReport: null,
    referenceSpaceType: null,
    frameRate: null,
    supportedFrameRates: null,
    targetFrameRateRequest: 'not-attempted',
    handTrackingAvailable: false,
    planeCount: 0,
    meshCount: 0,
    depthAgeMs: Infinity,
    qualityTier: quality.decision.tier,
    perfP50: 0,
    perfP95: 0,
    perfP99: 0,
    qualityHistory: quality.history,
  };
  if (diagState.xrPresent) {
    navigator.xr!.isSessionSupported('immersive-ar').then((ok) => { diagState.arSupported = ok; }).catch(() => { diagState.arSupported = false; });
  }
  let lastDiagAt = -Infinity;
  let frameRateRequested = false;

  const capture = createCapturePipeline({ frameStore });

  const inXRHud = new InXRHud();
  scene.add(inXRHud.panel);
  const guideOverlay = new GuideOverlay();
  scene.add(guideOverlay.group);

  let guide: CaptureGuide = INACTIVE_GUIDE;

  let features: XRFeatureReport | null = null;
  let inSession = false;
  let firstFrameResolve: (() => void) | null = null;
  let firstFramePromise: Promise<void> | null = null;
  let lastFrameTime: number | null = null;
  let refSpace: XRReferenceSpace | null = null;

  function conditions(): RuntimeConditions {
    const headPose = poseFromMatrix(camera);
    return {
      now: performance.now(),
      headPose,
      trackingOk: true,
      localizedAnchors: sceneUnderstanding.localizedAnchors,
      depthAgeMs: depth.state.ageMs,
      tier: quality.decision.tier,
    };
  }

  function applyModeFromQuality(decision: QualityDecision): void {
    const snapshot = store.current;
    const desiredMode: VisualMode = decision.allowCapturedShell ? snapshot.mode : 'live-overlay';
    if (!decision.allowCapturedShell && snapshot.mode !== 'live-overlay') {
      store.dispatch(
        { intent: { kind: 'setMode', mode: 'live-overlay' }, source: 'system', issuedAt: decision.at, basedOnVersion: snapshot.version },
        conditions(),
      );
    }
    void desiredMode;
  }

  quality.subscribe((decision: QualityDecision) => applyModeFromQuality(decision));

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

  let spawnCounter = 0;
  function spawnPrimitive(kind: 'box' | 'sphere'): void {
    spawnCounter += 1;
    const headPose = poseFromMatrix(camera);
    const forward = new THREE.Vector3(0, 0, -0.6).applyQuaternion(camera.quaternion).add(camera.position);
    const pose: Pose = { position: { x: forward.x, y: forward.y, z: forward.z }, rotation: { ...IDENTITY_QUAT } };
    const object: EditableObject = {
      id: `spawn-${spawnCounter}-${Date.now()}`,
      label: 'other',
      userName: `Spawned ${kind} ${spawnCounter}`,
      origin: 'spawned',
      originalPose: pose,
      currentPose: pose,
      visual: { kind: 'primitive', color: kind === 'box' ? 0x66aaff : 0xff8866 },
      interactionProxy: kind === 'box' ? { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } } : { kind: 'sphere', radius: 0.08 },
      collisionProxy: kind === 'box' ? { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } } : { kind: 'sphere', radius: 0.08 },
      occlusionProxy: kind === 'box' ? { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } } : { kind: 'sphere', radius: 0.08 },
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
    const result = await requestARSession(renderer, {
      onEnd: () => {
        inSession = false;
        features = null;
      },
    });
    features = result.featureReport;
    inSession = !!result.session;

    if (!firstFramePromise) {
      firstFramePromise = new Promise((resolve) => {
        firstFrameResolve = resolve;
      });
    }
    return features;
  }

  async function exitAR(): Promise<void> {
    endARSession(renderer.xr.getSession());
    inSession = false;
  }

  async function runCandidateDiscovery(): Promise<string[]> {
    const volumes = sceneUnderstanding.latestVolumes;
    const candidates = capture.discover(volumes, store.current);
    const ids: string[] = [];
    for (const candidate of candidates) {
      const result = store.dispatch(
        { intent: { kind: 'registerObject', object: candidate.object }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
      if (result.ok) ids.push(candidate.object.id);
    }
    return ids;
  }

  async function captureCleanPlate(objectId: string): Promise<{ tier: string; coverage: number }> {
    const snapshot = store.current;
    const obj = snapshot.objects[objectId];
    if (!obj) return { tier: 'E', coverage: 0 };

    const supportSurface = obj.supportSurfaces[0] ? snapshot.surfaces[obj.supportSurfaces[0]] : undefined;
    const source = window.__cameraFrameSource ?? NO_CAMERA_SOURCE;
    const plan = planCaptureViewpoints(obj, supportSurface, poseFromMatrix(camera));

    let step = 0;
    guide = makeActiveGuide(obj, 1, plan.capture.length, plan.capture[0] ?? poseFromMatrix(camera));
    const guidedSource = wrapSourceForGuide(source, (viewpoint) => {
      step += 1;
      // Only the primary guided arc advances the visible step count; the
      // off-path verification pass (also routed through this source) does not.
      if (step <= plan.capture.length) {
        const target = plan.capture[Math.min(step - 1, plan.capture.length - 1)] ?? viewpoint ?? poseFromMatrix(camera);
        guide = makeActiveGuide(obj, step, plan.capture.length, target);
      }
    });

    try {
      const acquireResult = await capture.acquireCleanPlate({ object: obj, supportSurface, viewpoints: plan.capture }, guidedSource);
      const verified = await capture.verify(acquireResult, plan.verify, guidedSource);

      store.dispatch(
        { intent: { kind: 'updateBackground', objectId, plate: acquireResult.plate }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );
      store.dispatch(
        { intent: { kind: 'setTier', objectId, tier: verified.tier, confidence: verified.tierConfidence }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
        conditions(),
      );

      return { tier: verified.tier, coverage: acquireResult.plate.coverage };
    } finally {
      guide = INACTIVE_GUIDE;
    }
  }

  async function captureRoomShell(): Promise<{ framesCaptured: number }> {
    const source = window.__cameraFrameSource ?? NO_CAMERA_SOURCE;
    if (!source.available) {
      frameStore.delete(ROOM_SHELL_FRAME_ID);
      return { framesCaptured: 0 };
    }
    const plan = planRoomShellViewpoints(store.current);
    const frames: CameraFrame[] = [];
    for (const viewpoint of plan.viewpoints) {
      const frame = await source.capture(viewpoint);
      if (frame) frames.push(frame);
    }
    frameStore.put(ROOM_SHELL_FRAME_ID, frames);
    return { framesCaptured: frames.length };
  }

  // ---- Frame loop -----------------------------------------------------
  const tmpTarget = new THREE.Vector3();

  renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
    const now = performance.now();
    const frameMs = lastFrameTime !== null ? now - lastFrameTime : 16.7;
    lastFrameTime = now;

    if (frame) {
      const session = renderer.xr.getSession();
      refSpace = renderer.xr.getReferenceSpace();
      void session;
      input.update(frame, refSpace);
      sceneUnderstanding.update(frame, refSpace);
    }

    depth.update(now);

    const snapshot = store.current;
    const cond = conditions();

    interaction.update(input.state, cond);
    physicsBridge.update(now);
    voiceAndMenu.update(now);
    views.hoveredId = interaction.hoveredId;
    views.selectedId = interaction.selectedId;
    views.grabbedId = interaction.selectedId;

    const obstructionPoints: Vec3[] = [cond.headPose.position];
    if (input.state.left.active) {
      obstructionPoints.push({ x: input.state.left.position.x, y: input.state.left.position.y, z: input.state.left.position.z });
    }
    if (input.state.right.active) {
      obstructionPoints.push({ x: input.state.right.position.x, y: input.state.right.position.y, z: input.state.right.position.z });
    }
    regionManager.tick(cond, snapshot.mode, quality.decision, obstructionPoints);

    views.update(store.current);
    views.updatePreview(store.current, previewGroup);
    plates.update(store.current, cond.headPose);
    backgroundHull.update(store.current, cond.headPose);
    shell.update(store.current, sceneUnderstanding.latestGlobalMeshes);
    // Floor is at y=0 in local-floor space (see docs/testing.md's IWER coordinate-frame note).
    guideOverlay.update(guide, 0);

    if (now - lastDiagAt > 250) {
      lastDiagAt = now;
      const session = frame ? renderer.xr.getSession() : null;
      diagState.inSession = inSession;
      diagState.featureReport = features;
      diagState.referenceSpaceType = session ? 'local-floor' : null;
      diagState.frameRate = session?.frameRate ?? null;
      diagState.supportedFrameRates = session?.supportedFrameRates ? Array.from(session.supportedFrameRates) : null;
      if (session && !frameRateRequested) {
        frameRateRequested = true;
        void tryUpdateTargetFrameRate(session, 90).then((r) => { diagState.targetFrameRateRequest = r; });
      }
      diagState.handTrackingAvailable = input.state.left.active || input.state.right.active;
      diagState.planeCount = Object.keys(store.current.surfaces).length;
      diagState.meshCount = sceneUnderstanding.latestGlobalMeshes.length;
      diagState.depthAgeMs = depth.state.ageMs;
      diagState.qualityTier = quality.decision.tier;
      const ps = perf.stats('frameMs');
      diagState.perfP50 = ps.p50;
      diagState.perfP95 = ps.p95;
      diagState.perfP99 = ps.p99;
      diagState.qualityHistory = quality.history;
      diagnostics.update(diagState);
    }

    // Rendering order (see xr/depth.ts): shell first (already added to scene
    // before objects), depth occlusion mesh second, editable objects last.
    // three.js draws scene graph children in insertion/renderOrder; the depth
    // occlusion mesh is injected here explicitly each frame.
    const occlusionMesh = depth.getOcclusionMesh();
    if (occlusionMesh && occlusionMesh.parent !== scene) {
      scene.add(occlusionMesh);
    }

    camera.getWorldPosition(tmpTarget);
    inXRHud.attachTo(camera);
    inXRHud.update(
      {
        tier: cond.tier,
        frameP95: perf.stats('frameMs').p95,
        depthAgeMs: depth.state.ageMs,
        mode: snapshot.mode,
        selectedObjectId: interaction.selectedId,
        lastRejection: interaction.lastRejection,
        guide,
      },
      now,
    );
    domHud.update(
      {
        tier: cond.tier,
        frameP95: perf.stats('frameMs').p95,
        depthAgeMs: depth.state.ageMs,
        mode: snapshot.mode,
        selectedObjectId: interaction.selectedId,
        lastRejection: interaction.lastRejection,
        guide,
      },
      quality.decision,
      now,
    );

    const sample: FrameSample = {
      t: now,
      frameMs,
      depthAgeMs: depth.state.ageMs,
      trackingOk: cond.trackingOk,
      droppedFrames: frameMs > 33.4 ? 1 : 0,
      thermalThrottled: false,
      memoryPressure: false,
      handConfidence: Math.max(input.state.left.confidence, input.state.right.confidence),
      registrationErrorM: 0,
      appMs: performance.now() - now,
    };
    perf.push(sample);
    quality.observe(sample);

    if (renderer.xr.isPresenting) {
      renderer.render(scene, camera);
    } else if (!headless) {
      // Desktop preview: render with the default camera so main.ts is testable outside XR.
      camera.position.set(0, 1.5, 2);
      camera.lookAt(0, 1, 0);
      renderer.render(scene, camera);
    }

    options.onFrame?.({ time, headPose: cond.headPose, snapshot: store.current, decision: quality.decision });

    if (firstFrameResolve) {
      firstFrameResolve();
      firstFrameResolve = null;
    }
  });

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
    captureRoomShell,
    grab(objectId: string, hand: 'left' | 'right'): boolean {
      return interaction.grab(objectId, hand);
    },
    release(hand: 'left' | 'right'): void {
      interaction.release(hand, conditions());
    },
    reportObstruction(point: Vec3): void {
      regionManager.reportObstructionAt(point, conditions());
    },
    get guide(): CaptureGuide {
      return guide;
    },
    voice: voiceAndMenu.voice,
    dispose(): void {
      voiceAndMenu.dispose();
      void exitAR();
      disposeRenderer();
      views.dispose();
      plates.dispose();
      backgroundHull.dispose();
      shell.dispose();
      input.dispose();
      sceneUnderstanding.dispose();
      inXRHud.dispose();
      domHud.dispose();
      guideOverlay.dispose();
    },
  };

  window.__realityEditor = handle;
  void nearestObjects;
  return handle;
};

export default startApp;
