/**
 * Simulator contract. Pure types shared by `src/sim/bootstrap.ts`, `src/sim/entry.ts`,
 * and `tests/e2e/*`. `window.__sim` is the single entry point tests drive.
 */
import type { XRDevice } from 'iwer';
import type { CameraFrameSource } from '@/capture/contract';
import type { PerfTracker } from '@/core/api';
import type { Pose, Quat, SemanticLabel, Vec3 } from '@/core/types';

/** Human-friendly orientation; yaw/pitch/roll in degrees, YXZ order (matches iwer's eulerToQuat). */
export interface EulerAnglesDeg {
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
}

export type Orientation = EulerAnglesDeg | Quat;

export interface HandAPI {
  /** Animate the hand to a world-space position over `seconds` (default 0 = instant). */
  moveTo(position: Vec3, seconds?: number): Promise<void>;
  /** Set the hand's orientation immediately. */
  setPose(rotation: Quat): void;
  /** true => pinch pose + pinch value 1; false => default pose + pinch value 0. */
  pinch(active: boolean): void;
  readonly pose: Pose;
}

export interface ControllerAPI {
  /** true => trigger fully pressed (fires the 'select' event trigger); false => released. */
  select(down: boolean): void;
  readonly pose: Pose;
}

export type SimVolumeKind = 'plane' | 'mesh';

/** Plain-data view of a SEM tracked entity, for tests to find "the table" etc. */
export interface SimVolume {
  id: string;
  label: SemanticLabel | string;
  kind: SimVolumeKind;
  pose: Pose;
  halfExtents: Vec3;
  visible: boolean;
}

export interface SimFrameStats {
  /** rAF ticks observed by the simulator since install (not gated on an XR session). */
  frames: number;
  /** Uncaught errors and unhandled promise rejections seen since install. */
  errors: string[];
}

export interface SimOptions {
  /** SEM capture id: living_room (default), meeting_room, music_room, office_large, office_small. */
  environment?: string;
  /** Install @iwer/devui manual controls. Default: on, unless `?headless=1` is in the URL. */
  devui?: boolean;
  stereo?: boolean;
}

export interface SimHandle {
  readonly xrDevice: XRDevice;
  readonly cameraFrameSource: CameraFrameSource;
  setHead(position: Vec3, rotation?: Orientation): void;
  walkTo(position: Vec3, seconds?: number): Promise<void>;
  lookAt(point: Vec3): void;
  setInputMode(mode: 'hand' | 'controller'): void;
  hand(side: 'left' | 'right'): HandAPI;
  controller(side: 'left' | 'right'): ControllerAPI;
  loadEnvironment(id: string): Promise<void>;
  /** Tracked planes/meshes from SEM as plain data. */
  listVolumes(): SimVolume[];
  /** Toggle visibility of a SEM entity, emulating "the user lifted the object away". */
  hideVolume(id: string): void;
  showVolume(id: string): void;
  /** Proxy to `window.__realityEditor.perf`, once the app has started. */
  perf(): PerfTracker | undefined;
  frameStats(): SimFrameStats;
}

declare global {
  interface Window {
    __sim?: SimHandle;
    __cameraFrameSource?: CameraFrameSource;
  }
}
