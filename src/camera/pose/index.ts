/**
 * Pose source factory: picks the implementation named by
 * `CameraAppConfig.pose` (see src/camera/contract.ts and
 * docs/general-camera/architecture.md, "Abstractions").
 */
import type { CameraAppConfig, PoseSource } from '@/camera/contract';
import { StaticPoseSource } from './static';
import { OrientationPoseSource } from './orientation';

export { StaticPoseSource } from './static';
export type { StaticPoseSourceOptions } from './static';
export { OrientationPoseSource } from './orientation';
export type { OrientationPoseSourceOptions } from './orientation';
export { quatFromDeviceOrientation, yawOf, removeYaw } from './orientation-math';

/** True on a touch-first device: phones/tablets, not a laptop with a touchscreen. */
function isTouchFirstDevice(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (nav && typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 1) return true;
  if (typeof matchMedia === 'function') {
    try {
      return matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Build the pose source named by `config.pose`. 'auto' picks
 * `OrientationPoseSource` on touch-first devices that report
 * `DeviceOrientationEvent`, else `StaticPoseSource`.
 */
export function createPoseSource(
  config: Pick<CameraAppConfig, 'pose' | 'cameraHeightM' | 'pitchRad'>,
): PoseSource & { setHeight(h: number): void } {
  let mode = config.pose;
  if (mode === 'auto') {
    const hasDeviceOrientation = typeof DeviceOrientationEvent !== 'undefined';
    mode = hasDeviceOrientation && isTouchFirstDevice() ? 'orientation' : 'static';
  }

  if (mode === 'orientation') {
    return new OrientationPoseSource({ cameraHeightM: config.cameraHeightM });
  }
  return new StaticPoseSource({ cameraHeightM: config.cameraHeightM, pitchRad: config.pitchRad });
}
