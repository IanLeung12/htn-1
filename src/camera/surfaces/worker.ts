/**
 * Surface-estimation Web Worker: runs DepthSurfaceEstimator (RANSAC planes,
 * clustering) off the main thread so a ~200 ms run never stalls the frame
 * loop. State (tracked ids, previous surfaces) lives here across updates.
 *
 * In:  { type: 'update', map: SerializedDepthMap, tuning: SurfaceTuning, now, cameraHeightM }
 * Out: { type: 'result', surfaces, volumes, correction, cameraHeightM, lastStats, lastRunAt }
 */
import type { DepthMap } from '../contract';
import { DepthSurfaceEstimator, type SurfaceTuning } from './depth-surfaces';

export interface SerializedDepthMap extends Omit<DepthMap, 'metric'> {
  metric: ArrayBuffer;
}

interface UpdateMessage {
  type: 'update';
  map: SerializedDepthMap;
  tuning: SurfaceTuning;
  now: number;
  cameraHeightM: number;
  trustPose?: boolean;
}

let tuning: SurfaceTuning | null = null;
let estimator: DepthSurfaceEstimator | null = null;

self.onmessage = (event: MessageEvent<UpdateMessage>) => {
  const msg = event.data;
  if (msg.type !== 'update') return;
  tuning = msg.tuning;
  if (!estimator) estimator = new DepthSurfaceEstimator({ cameraHeightM: msg.cameraHeightM, getTuning: () => tuning as SurfaceTuning, trustPose: msg.trustPose ?? false });
  const map: DepthMap = { ...msg.map, metric: new Float32Array(msg.map.metric) };
  // The worker has its own clock; force the run by using the map's timestamp ordering only.
  estimator.update(map, map.pose, msg.now);
  postMessage({
    type: 'result',
    surfaces: estimator.surfaces,
    volumes: estimator.volumes,
    correction: estimator.correction,
    cameraHeightM: estimator.cameraHeightM,
    lastStats: estimator.lastStats,
    lastRunAt: estimator.lastRunAt,
    lastFrame: estimator.lastFrame,
    groundExtent: estimator.groundExtent,
  });
};
