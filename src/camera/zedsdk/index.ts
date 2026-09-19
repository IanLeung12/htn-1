/**
 * ZED SDK bridge backend (docs/general-camera/zed-sdk.md): one WebSocket to
 * tools/zed-bridge/server.py feeds a FrameSource (left image), a
 * DepthEstimator (SDK depth + confidence) and a PoseSource (SDK positional
 * tracking). `src/camera/app.ts` selects it for `config.source === 'zed-sdk'`.
 */
import type { CameraAppConfig } from '../contract';
import type { FrameCorrection } from '../surfaces/depth-surfaces';
import { ZedBridgeClient } from './bridge-client';
import { ZedSdkFrameSource } from './frame-source';
import { ZedSdkDepthEstimator } from './depth';
import { ZedSdkPoseSource } from './pose';

export { ZedBridgeClient } from './bridge-client';
export type { BridgeStats, DecodedBridgeFrame } from './bridge-client';
export { ZedSdkFrameSource } from './frame-source';
export { ZedSdkDepthEstimator, ZED_SDK_DEPTH_CONFIDENCE } from './depth';
export { ZedSdkPoseSource } from './pose';
export { parseBridgeMessage, poseFromColumnMajor, quatFromColumnMajor, fovYFromIntrinsics, depthMillimetresToMetres } from './protocol';
export type { BridgeHeader, BridgeMessage } from './protocol';

export const DEFAULT_BRIDGE_URL = 'ws://localhost:8765';

export interface ZedSdkBackend {
  client: ZedBridgeClient;
  frameSource: ZedSdkFrameSource;
  depthEstimator: ZedSdkDepthEstimator;
  poseSource: ZedSdkPoseSource;
  /** One diagnostics line: bridge fps / latency / tracking / floor mode. */
  statusLine(): string;
  /** Call after `surfaceEstimator.update`: feeds the fitted ground plane to the pose source's floor policy. */
  onSurfaces(estimator: { correction: FrameCorrection | null }): void;
}

declare global {
  interface Window {
    /** Bridge stats for tests/diagnostics (`?source=zed-sdk`). */
    __zedBridge?: ZedSdkBackend;
  }
}

export function createZedSdkBackend(config: Pick<CameraAppConfig, 'bridgeUrl' | 'fovY' | 'cameraHeightM' | 'zedMinConfidence'>): ZedSdkBackend {
  const client = new ZedBridgeClient({ url: config.bridgeUrl ?? DEFAULT_BRIDGE_URL });
  const frameSource = new ZedSdkFrameSource(client, { fovY: config.fovY });
  const poseSource = new ZedSdkPoseSource(client, { cameraHeightM: config.cameraHeightM });
  const depthEstimator = new ZedSdkDepthEstimator(client, { getPose: () => poseSource.pose, minConfidence: config.zedMinConfidence });
  let lastCorrectionAt = -Infinity;
  const backend: ZedSdkBackend = {
    client,
    frameSource,
    depthEstimator,
    poseSource,
    onSurfaces(estimator) {
      const c = estimator.correction;
      if (!c || c.at === lastCorrectionAt) return;
      lastCorrectionAt = c.at;
      poseSource.applyGroundPlane(c.groundY, c.confidence, c.inliers, c.extentM);
      if (c.normalWorld) poseSource.applyTilt(c.normalWorld, c.confidence, c.tiltInliers ?? c.inliers, c.tiltExtentM ?? c.extentM);
    },
    statusLine() {
      const s = client.stats;
      if (!s.connected) return `zed-sdk bridge ${client.url}: ${s.error ?? 'connecting'}`;
      return `zed-sdk ${s.source} ${s.fps.toFixed(0)} fps, ${(s.bytesPerSecond / 1e6).toFixed(1)} MB/s, transport ${s.transportMs.toFixed(0)} ms, decode ${s.decodeMs.toFixed(0)} ms, tracking ${poseSource.trackingState}, floor ${poseSource.floorMode}, tilt ${((poseSource.tiltRad * 180) / Math.PI).toFixed(1)} deg, valid ${(depthEstimator.validFraction * 100).toFixed(0)}%`;
    },
  };
  if (typeof window !== 'undefined') window.__zedBridge = backend;
  return backend;
}
