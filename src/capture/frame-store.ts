/**
 * Keeps the raw CameraFrames captured during clean-plate acquisition (and,
 * for captured-shell mode, the room-orbit capture) around after the fact so
 * the renderer can build a projective-texture "background hull" or textured
 * shell from them - the clean-plate pipeline itself only needs the baked
 * plate texture (see capture/plates.ts), but the renderer needs the original
 * frames + poses to reproject from an arbitrary head position.
 */
import type { CameraFrame } from './contract';

export interface FrameStore {
  put(objectId: string, frames: CameraFrame[]): void;
  get(objectId: string): CameraFrame[] | undefined;
  delete(objectId: string): void;
}

export function createFrameStore(): FrameStore {
  const store = new Map<string, CameraFrame[]>();
  return {
    put(objectId, frames) {
      store.set(objectId, frames);
    },
    get(objectId) {
      return store.get(objectId);
    },
    delete(objectId) {
      store.delete(objectId);
    },
  };
}

/** Id the room-shell orbit capture is stored under (see src/app/main.ts's captureRoomShell). */
export const ROOM_SHELL_FRAME_ID = 'room-shell';

/**
 * FrameStore key an object's "appearance pass" is stored under: frames taken
 * from the same planned viewpoints as the clean-plate capture but WITH the
 * physical object still present (see src/app/main.ts's
 * `captureObjectAppearance`), so a moved copy of the object can be rendered
 * from its own real depth/texture instead of a primitive box (see
 * src/render/objects.ts). Namespaced separately from `objectId` itself
 * (which frame-store keys already use for the object's clean-plate/background
 * frames, see src/render/background-hull.ts) so the two capture passes never
 * collide in the same FrameStore.
 */
export function appearanceFrameKey(objectId: string): string {
  return `obj-appearance:${objectId}`;
}
