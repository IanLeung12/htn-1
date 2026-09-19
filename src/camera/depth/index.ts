/**
 * Depth estimator selection for the camera backend.
 *
 *  - 'none'  -> NoDepthEstimator (frames carry no depth; plates cannot verify).
 *  - 'prior' -> PlanePriorDepthEstimator (analytic floor depth, tier cap C).
 *  - 'model' / 'auto' -> the monocular model (Depth Anything V2 small in a
 *    Web Worker, src/camera/depth/model.ts) when it loads, with the plane
 *    prior as the fallback while loading / when unavailable ('auto') or
 *    unavailable outright ('model').
 */
import type { CameraAppConfig, DepthEstimator } from '../contract';
import { NoDepthEstimator, PlanePriorDepthEstimator } from './prior';
import { ModelDepthEstimator } from './model';
import { InjectableDepthEstimator } from './injected';

export { NoDepthEstimator, PlanePriorDepthEstimator, fillFloorDepth, toleranceForEstimatedDepth, PLANE_PRIOR_CONFIDENCE } from './prior';
export { ModelDepthEstimator } from './model';
export { InjectableDepthEstimator } from './injected';

export function createDepthEstimator(config: Pick<CameraAppConfig, 'depth'>, _cameraHeight: () => number): DepthEstimator {
  switch (config.depth) {
    case 'none':
      return new NoDepthEstimator();
    case 'prior':
      return new PlanePriorDepthEstimator();
    case 'injected':
      return new InjectableDepthEstimator();
    case 'model':
      return new ModelDepthEstimator({ fallback: null });
    case 'auto':
    default:
      return new ModelDepthEstimator({ fallback: new PlanePriorDepthEstimator() });
  }
}
