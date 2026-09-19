/** Wires discovery + clean-plate acquisition + verification into a CapturePipeline. */
import type { CapturePipeline, CleanPlateRequest, CleanPlateResult, CameraFrameSource, PlateTextureRegistry } from './contract';
import type { EditableObject, Pose } from '@/core/types';
import { discover } from './discovery';
import { acquireCleanPlate } from './plates';
import { verify as verifyImpl } from './verify';
import { createPlateTextureRegistry } from './registry';

export * from './contract';
export { discover } from './discovery';
export { acquireCleanPlate, footprintFromProxy, computeObservation } from './plates';
export { verify } from './verify';
export { createPlateTextureRegistry } from './registry';
export * from './geom';

export interface CreateCapturePipelineOptions {
  now?: () => number;
  textureSize?: number;
  registry?: PlateTextureRegistry;
}

export function createCapturePipeline(opts: CreateCapturePipelineOptions = {}): CapturePipeline {
  const registry = opts.registry ?? createPlateTextureRegistry();
  const now = opts.now ?? (() => Date.now());
  const textureSize = opts.textureSize ?? 128;

  return {
    discover(volumes, snapshot) {
      return discover(volumes, snapshot);
    },
    acquireCleanPlate(req: CleanPlateRequest, source: CameraFrameSource): Promise<CleanPlateResult> {
      return acquireCleanPlate(req, source, { now, textureSize, registry });
    },
    verify(result: CleanPlateResult, offPathViewpoints: Pose[], source: CameraFrameSource): Promise<EditableObject> {
      return verifyImpl(result, offPathViewpoints, source, { registry });
    },
  };
}
