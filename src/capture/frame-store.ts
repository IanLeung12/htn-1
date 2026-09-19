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
