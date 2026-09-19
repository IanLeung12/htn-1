/** Wires discovery + clean-plate acquisition + verification into a CapturePipeline. */
import type { CapturePipeline, CleanPlateRequest, CleanPlateResult, CameraFrameSource, PlateTextureRegistry } from './contract';
import type { EditableObject, Pose } from '@/core/types';
import { discover } from './discovery';
import { acquireCleanPlate } from './plates';
import { verify as verifyImpl } from './verify';
import { createPlateTextureRegistry } from './registry';
import type { FrameStore } from './frame-store';

export * from './contract';
export { discover } from './discovery';
export { acquireCleanPlate, footprintFromProxy, computeObservation } from './plates';
export { verify } from './verify';
export { createPlateTextureRegistry } from './registry';
export { createFrameStore, ROOM_SHELL_FRAME_ID } from './frame-store';
export type { FrameStore } from './frame-store';
export * from './geom';

export interface CreateCapturePipelineOptions {
  now?: () => number;
  textureSize?: number;
  registry?: PlateTextureRegistry;
  /** When provided, `acquireCleanPlate` stashes the frames it used under the
   * request's object id, so the renderer can later reproject the real
   * background from them (see FrameStore / BackgroundHull). */
  frameStore?: FrameStore;
}

export function createCapturePipeline(opts: CreateCapturePipelineOptions = {}): CapturePipeline {
  const registry = opts.registry ?? createPlateTextureRegistry();
  const now = opts.now ?? (() => Date.now());
  const textureSize = opts.textureSize ?? 128;
  const frameStore = opts.frameStore;

  return {
    discover(volumes, snapshot) {
      return discover(volumes, snapshot);
    },
    async acquireCleanPlate(req: CleanPlateRequest, source: CameraFrameSource): Promise<CleanPlateResult> {
      const result = await acquireCleanPlate(req, source, { now, textureSize, registry });
      if (frameStore && result.frames.length > 0) {
        frameStore.put(req.object.id, result.frames);
      }
      return result;
    },
    verify(result: CleanPlateResult, offPathViewpoints: Pose[], source: CameraFrameSource): Promise<EditableObject> {
      return verifyImpl(result, offPathViewpoints, source, { registry });
    },
  };
}
