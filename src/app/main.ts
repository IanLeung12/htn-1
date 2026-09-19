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
import type { EditableObject, FrameSample, Pose, QualityDecision, RuntimeConditions, VisualMode } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';
import type { AppHandle, AppOptions, StartApp, XRFeatureReport } from './contract';
import { requestARSession, endARSession } from '@/xr/session';
import { XRInput } from '@/xr/input';
import { SceneUnderstanding } from '@/xr/scene-understanding';
import { DepthOcclusion } from '@/xr/depth';
import { createRenderer } from '@/render/renderer';
import { ObjectViews } from '@/render/objects';
import { PlateRenderer } from '@/render/plates';
import { ShellRenderer } from '@/render/shell';
import { InXRHud, DomHud } from '@/render/hud';
import { InteractionController } from './interaction';
import { createCapturePipeline } from '@/capture';
import { createPlateTextureRegistry } from '@/capture';
import type { CameraFrameSource } from '@/capture/contract';

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

  const shell = new ShellRenderer();
  scene.add(shell.occluderGroup, shell.visibleGroup);

  const interaction = new InteractionController(store);

  const capture = createCapturePipeline();

  const inXRHud = new InXRHud();
  scene.add(inXRHud.panel);

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
    const viewpoints: Pose[] = [poseFromMatrix(camera)];

    const acquireResult = await capture.acquireCleanPlate({ object: obj, supportSurface, viewpoints }, source);
    const verified = await capture.verify(acquireResult, viewpoints, source);

    store.dispatch(
      { intent: { kind: 'updateBackground', objectId, plate: acquireResult.plate }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
      conditions(),
    );
    store.dispatch(
      { intent: { kind: 'setTier', objectId, tier: verified.tier, confidence: verified.tierConfidence }, source: 'system', issuedAt: performance.now(), basedOnVersion: store.current.version },
      conditions(),
    );

    return { tier: verified.tier, coverage: acquireResult.plate.coverage };
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

    interaction.hoveredId = interaction.hoveredId; // no-op keep lint happy about ordering
    interaction.update(input.state, cond);
    views.hoveredId = interaction.hoveredId;
    views.selectedId = interaction.selectedId;
    views.grabbedId = interaction.selectedId;

    views.update(store.current);
    views.updatePreview(store.current, previewGroup);
    plates.update(store.current, cond.headPose);
    shell.update(store.current, sceneUnderstanding.latestGlobalMeshes);

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
    grab(objectId: string, hand: 'left' | 'right'): boolean {
      return interaction.grab(objectId, hand);
    },
    release(hand: 'left' | 'right'): void {
      interaction.release(hand, conditions());
    },
    dispose(): void {
      void exitAR();
      disposeRenderer();
      views.dispose();
      plates.dispose();
      shell.dispose();
      input.dispose();
      sceneUnderstanding.dispose();
      inXRHud.dispose();
      domHud.dispose();
    },
  };

  window.__realityEditor = handle;
  void regionMachine;
  void nearestObjects;
  return handle;
};

export default startApp;
