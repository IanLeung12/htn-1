/**
 * IWER + SEM + devui bootstrap for the Reality Editor simulator.
 *
 * `installSimulator` must run BEFORE any app code touches `navigator.xr` - it creates the
 * XRDevice, installs the emulated WebXR runtime, loads a synthetic room (SEM), optionally
 * installs the manual devui controls, and exposes a programmatic `window.__sim` API that
 * both a human (via the browser console) and Playwright tests can drive.
 *
 * Key IWER facts discovered while building this (see also docs/testing.md):
 *  - `xrDevice.position` / `xrDevice.quaternion` are mutable Vector3/Quaternion wrappers
 *    (gl-matrix backed) returned by getters; you set them in place with `.set(...)`, there
 *    is no setter on XRDevice itself. This works whether or not a session is active.
 *  - `xrDevice.hands.left` / `.right` and `xrDevice.controllers.left` / `.right` always
 *    exist (both are constructed up front); `primaryInputMode` only controls which one is
 *    exposed via `inputSources`/`activeInputs` to the WebXR app.
 *  - `xrDevice.remote` (RemoteControlInterface) is a frame-synchronized command queue
 *    intended for out-of-process control; most of its methods (`animate_to`, `set_transform`,
 *    `select`, ...) are in `SESSION_REQUIRED_METHODS` and throw if no XR session is active
 *    yet. Since we're in-process, we drive `xrDevice`/hands/controllers directly instead
 *    (plain property mutation + our own rAF tweens) so the simulator API works both before
 *    and during a session.
 *  - `xrDevice.grantOfferedSession()` only matters if the app uses `navigator.xr.offerSession`
 *    (a native-browser "prompt to enter AR" pattern). IWER's `XRSystem.requestSession`
 *    resolves immediately with no gesture/permission check, so a normal
 *    `navigator.xr.requestSession('immersive-ar', ...)` call from `AppHandle.enterAR()`
 *    just works under emulation without needing grantOfferedSession at all.
 *  - SEM (`xrDevice.sem`) renders the loaded capture from the device pose into its own
 *    canvas (`sem.environmentCanvas`) automatically every XR frame once a session is
 *    active (iwer's XRSession device-frame loop calls `sem.render(now)`); see
 *    `src/sim/camera-source.ts` for how the CameraFrameSource re-renders on demand too.
 *  - SEM keeps entities in a private `objectMap: Map<uuid, SpatialEntity>` (SpatialEntity
 *    extends THREE.Mesh). There's no public API to hide/show one entity, so
 *    `hideVolume`/`showVolume` reach in via `(sem as any).objectMap` and toggle
 *    `Object3D.visible` - this affects both `sem.render()` (environmentCanvas) and
 *    `sem.computeDepthBuffer()` (which force the *group* visible but still respect each
 *    entity's own `.visible`), which is exactly what's needed to emulate "the user lifted
 *    the object away" for clean-plate capture.
 */
import { DevUI } from '@iwer/devui';
import { SyntheticEnvironmentModule } from '@iwer/sem';
import { XRDevice, eulerToQuat, lookRotation, metaQuest3 } from 'iwer';
import { SimCameraFrameSource } from './camera-source';
import { LiftController } from './lift';
import type {
  ControllerAPI,
  HandAPI,
  Orientation,
  SimFrameStats,
  SimHandle,
  SimOptions,
  SimVolume,
} from './types';
import type { Quat, Vec3 } from '@/core/types';

type Sem = NonNullable<XRDevice['sem']>;
// SpatialEntity is Object3D-like; SEM keeps them in a private objectMap we reach into for
// hideVolume/showVolume and listVolumes (see file header).
interface SpatialEntityLike {
  visible: boolean;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  geometry: {
    computeBoundingBox(): void;
    boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  };
  entityType?: 'plane' | 'box' | 'mesh';
  nativeEntity?: { semanticLabel?: string };
}

function isQuat(rotation: Orientation): rotation is Quat {
  return typeof (rotation as Quat).w === 'number';
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** rAF-driven linear tween of a position; resolves once the target is reached. */
function tweenPosition(
  read: () => Vec3,
  write: (v: Vec3) => void,
  target: Vec3,
  seconds: number,
): Promise<void> {
  if (!seconds || seconds <= 0) {
    write(target);
    return Promise.resolve();
  }
  const start = read();
  const durationMs = seconds * 1000;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      write({ x: lerp(start.x, target.x, t), y: lerp(start.y, target.y, t), z: lerp(start.z, target.z, t) });
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

function objectMapOf(sem: Sem): Map<string, SpatialEntityLike> {
  return (sem as unknown as { objectMap: Map<string, SpatialEntityLike> }).objectMap;
}

function volumeFromEntity(id: string, entity: SpatialEntityLike): SimVolume {
  entity.geometry.computeBoundingBox();
  const box = entity.geometry.boundingBox;
  // Read min/max directly rather than THREE.Box3.getSize(), which requires a real
  // THREE.Vector3 (it calls target.subVectors(...)) - a plain {x,y,z} target throws.
  const size = box ? { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z } : { x: 0, y: 0, z: 0 };
  return {
    id,
    label: entity.nativeEntity?.semanticLabel ?? 'other',
    kind: entity.entityType === 'plane' ? 'plane' : 'mesh',
    pose: {
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      rotation: { x: entity.quaternion.x, y: entity.quaternion.y, z: entity.quaternion.z, w: entity.quaternion.w },
    },
    halfExtents: { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
    visible: entity.visible,
  };
}

function makeHand(xrDevice: XRDevice, side: 'left' | 'right'): HandAPI {
  const get = () => {
    const h = xrDevice.hands[side];
    if (!h) throw new Error(`sim.hand('${side}'): hand input not present on this device`);
    return h;
  };
  return {
    async moveTo(position, seconds = 0) {
      const hand = get();
      await tweenPosition(
        () => ({ x: hand.position.x, y: hand.position.y, z: hand.position.z }),
        (v) => hand.position.set(v.x, v.y, v.z),
        position,
        seconds,
      );
    },
    setPose(rotation) {
      get().quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    },
    pinch(active) {
      const hand = get();
      hand.poseId = active ? 'pinch' : 'default';
      hand.updatePinchValue(active ? 1 : 0);
    },
    get pose() {
      const hand = get();
      return {
        position: { x: hand.position.x, y: hand.position.y, z: hand.position.z },
        rotation: { x: hand.quaternion.x, y: hand.quaternion.y, z: hand.quaternion.z, w: hand.quaternion.w },
      };
    },
  };
}

function makeController(xrDevice: XRDevice, side: 'left' | 'right'): ControllerAPI {
  const get = () => {
    const c = xrDevice.controllers[side];
    if (!c) throw new Error(`sim.controller('${side}'): controller not present on this device`);
    return c;
  };
  return {
    select(down) {
      // 'trigger' is the button configured with eventTrigger: 'select' on the Meta Touch
      // Plus profile (see node_modules/iwer/lib/device/configs/controller/meta.js).
      get().setButtonValueImmediate('trigger', down ? 1 : 0);
    },
    get pose() {
      const c = get();
      return {
        position: { x: c.position.x, y: c.position.y, z: c.position.z },
        rotation: { x: c.quaternion.x, y: c.quaternion.y, z: c.quaternion.z, w: c.quaternion.w },
      };
    },
  };
}

export async function installSimulator(opts: SimOptions = {}): Promise<SimHandle> {
  const params = new URLSearchParams(location.search);
  const headless = params.get('headless') === '1';
  const envId = opts.environment ?? params.get('env') ?? 'living_room';
  const showDevUI = opts.devui ?? !headless;
  const stereo = opts.stereo ?? true;

  const xrDevice = new XRDevice(metaQuest3, {
    stereoEnabled: stereo,
    ipd: 0.063,
    fovy: (100 * Math.PI) / 180,
  });

  // Standing height, a couple of steps back from room center, facing the room. Individual
  // captures vary, but this keeps the headset inside the room and off the walls for all
  // five bundled environments.
  xrDevice.position.set(0, 1.6, 1.2);

  // Chromium ships a stub `navigator.xr` even on machines with no headset (it just
  // reports every session as unsupported), so `installRuntime()` needs `forceInstall`
  // to override it - otherwise it warns and leaves the stub in place, and every
  // `navigator.xr.requestSession(...)` call downstream keeps failing.
  xrDevice.installRuntime({ forceInstall: true });
  xrDevice.installSEM(SyntheticEnvironmentModule);
  if (showDevUI) {
    xrDevice.installDevUI(DevUI);
  }

  await xrDevice.sem!.loadDefaultEnvironment(envId);

  xrDevice.primaryInputMode = 'hand';
  lookAtImpl(xrDevice, { x: 0, y: 1.2, z: 0 });

  const cameraFrameSource = new SimCameraFrameSource(xrDevice);

  const frameStats: SimFrameStats = { frames: 0, errors: [] };
  window.addEventListener('error', (e) => {
    frameStats.errors.push(e.error instanceof Error ? `${e.error.message}\n${e.error.stack ?? ''}` : e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    frameStats.errors.push(reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason));
  });
  const tick = () => {
    frameStats.frames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  function lookAtImpl(device: XRDevice, point: Vec3): void {
    const p = device.position;
    const direction = { x: point.x - p.x, y: point.y - p.y, z: point.z - p.z };
    const q = lookRotation(direction);
    device.quaternion.set(q.x, q.y, q.z, q.w);
  }

  let lift: LiftController | null = null;
  const handle: SimHandle = {
    xrDevice,
    cameraFrameSource,

    setHead(position, rotation) {
      xrDevice.position.set(position.x, position.y, position.z);
      if (rotation) {
        const q = isQuat(rotation) ? rotation : eulerToQuat({ yaw: rotation.yawDeg ?? 0, pitch: rotation.pitchDeg ?? 0, roll: rotation.rollDeg ?? 0 });
        xrDevice.quaternion.set(q.x, q.y, q.z, q.w);
      }
    },

    async walkTo(position, seconds = 1) {
      await tweenPosition(
        () => ({ x: xrDevice.position.x, y: xrDevice.position.y, z: xrDevice.position.z }),
        (v) => xrDevice.position.set(v.x, v.y, v.z),
        position,
        seconds,
      );
    },

    lookAt(point) {
      lookAtImpl(xrDevice, point);
    },

    setInputMode(mode) {
      xrDevice.primaryInputMode = mode;
    },

    hand(side) {
      return makeHand(xrDevice, side);
    },

    controller(side) {
      return makeController(xrDevice, side);
    },

    async loadEnvironment(id) {
      await xrDevice.sem!.loadDefaultEnvironment(id);
    },

    listVolumes() {
      const sem = xrDevice.sem;
      if (!sem) return [];
      const map = objectMapOf(sem);
      return Array.from(map.entries()).map(([id, entity]) => volumeFromEntity(id, entity));
    },

    hideVolume(id) {
      const sem = xrDevice.sem;
      if (!sem) return;
      if (!lift) lift = new LiftController(sem);
      lift.lift(id);
    },

    showVolume(id) {
      const sem = xrDevice.sem;
      if (!sem) return;
      if (!lift) lift = new LiftController(sem);
      lift.restore(id);
    },

    perf() {
      return window.__realityEditor?.perf;
    },

    frameStats() {
      return { frames: frameStats.frames, errors: [...frameStats.errors] };
    },
  };

  window.__sim = handle;
  window.__cameraFrameSource = cameraFrameSource;
  return handle;
}
