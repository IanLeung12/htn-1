/**
 * Pose source factory: picks the implementation named by
 * `CameraAppConfig.pose` (see src/camera/contract.ts and
 * docs/general-camera/architecture.md, "Abstractions").
 */
import type { CameraAppConfig, PoseSource } from '@/camera/contract';
import { StaticPoseSource } from './static';
import { OrientationPoseSource } from './orientation';
import { VisualPoseSource } from './visual';

export { StaticPoseSource } from './static';
export type { StaticPoseSourceOptions } from './static';
export { OrientationPoseSource } from './orientation';
export type { OrientationPoseSourceOptions } from './orientation';
export { quatFromDeviceOrientation, yawOf, removeYaw } from './orientation-math';
export { FlowTracker, toGray, downsample2, detectCorners, trackLK, summarizeFlow, rotationFromFlow } from './flow';
export type { FlowSummary, FlowTrackerOptions, DetectCornersOptions, TrackLkOptions } from './flow';
export { VisualPoseSource } from './visual';
export type { VisualPoseSourceOptions } from './visual';

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
 * Build the pose source named by `config.pose`. 'auto' and 'visual' pick
 * `OrientationPoseSource` on touch-first devices that report
 * `DeviceOrientationEvent`, else `StaticPoseSource`; 'visual' additionally
 * turns on optical-flow rotation integration on top of that base.
 *
 * The result is *always* a `VisualPoseSource`, even for 'static' and
 * 'orientation': with `integrateRotation: false` it does no rotation
 * integration (the pose is exactly the base pose) but still runs the flow
 * tracker to detect motion the base source didn't report, so `trackingOk`
 * drops when a supposedly-static camera gets bumped (truthfulness contract
 * item 4 in docs/general-camera/architecture.md).
 */
export function createPoseSource(
  config: Pick<CameraAppConfig, 'pose' | 'cameraHeightM' | 'pitchRad'>,
): VisualPoseSource {
  let mode: 'static' | 'orientation' | 'auto' | 'visual' = config.pose;
  const integrateRotation = mode === 'visual';
  if (mode === 'auto' || mode === 'visual') {
    const hasDeviceOrientation = typeof DeviceOrientationEvent !== 'undefined';
    mode = hasDeviceOrientation && isTouchFirstDevice() ? 'orientation' : 'static';
  }

  const base: PoseSource & { setHeight(h: number): void } =
    mode === 'orientation'
      ? new OrientationPoseSource({ cameraHeightM: config.cameraHeightM })
      : new StaticPoseSource({ cameraHeightM: config.cameraHeightM, pitchRad: config.pitchRad });

  return new VisualPoseSource(base, { integrateRotation });
}
