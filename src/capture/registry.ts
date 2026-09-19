/** Map-backed PlateTextureRegistry. */
import type { PlateTextureRegistry } from './contract';

export function createPlateTextureRegistry(): PlateTextureRegistry {
  const store = new Map<string, { width: number; height: number; rgba: Uint8ClampedArray }>();
  return {
    put(ref, frame) {
      store.set(ref, frame);
    },
    get(ref) {
      return store.get(ref);
    },
    delete(ref) {
      store.delete(ref);
    },
  };
}
