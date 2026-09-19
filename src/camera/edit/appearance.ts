/**
 * Multi-frame appearance for discovered real objects (general-camera
 * backend, docs/general-camera/STATE.md "Multi-frame appearance" next
 * step): instead of a single live RGB-D frame, keep the last `N` frames
 * (RGB + depth + pose) taken while the object was present, under the
 * existing `appearanceFrameKey(id)` FrameStore slot. With a static camera
 * the impostor (`../impostor.ts`) is the primary render path (its cutout
 * only needs one representative frame, see `cutoutFromMask`); the
 * depth-mesh appearance path (`src/render/objects.ts`) takes over once the
 * camera has moved more than `CAMERA_MOVED_THRESHOLD_M` from where the
 * frames were captured, because a single-viewpoint impostor billboard reads
 * as a flat photo from any other angle.
 */
import type { Pose } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import { distance } from '@/core/math';

/** How many live frames to retain per discovered object. */
export const APPEARANCE_FRAME_COUNT = 8;

/** Camera motion (m) from the appearance capture viewpoint beyond which the impostor is no longer trustworthy. */
export const CAMERA_MOVED_THRESHOLD_M = 0.1;

/** Appends `frame` to `frames`, keeping at most `max` (oldest dropped first). */
export function pushAppearanceFrame(frames: readonly CameraFrame[] | undefined, frame: CameraFrame, max = APPEARANCE_FRAME_COUNT): CameraFrame[] {
  const next = frames ? [...frames, frame] : [frame];
  while (next.length > max) next.shift();
  return next;
}

/**
 * True when `currentPose` has moved more than `CAMERA_MOVED_THRESHOLD_M`
 * from every one of `frames`' capture poses - i.e. none of the retained
 * appearance frames were taken anywhere near here, so the flat impostor
 * billboard would look wrong and the depth-mesh appearance path should be
 * used instead. With a static camera (frames always at the same pose) this
 * is always false, matching "with a static camera the impostor is the
 * primary" path.
 */
export function cameraMovedFromAppearance(frames: readonly Pick<CameraFrame, 'pose'>[], currentPose: Pose, thresholdM = CAMERA_MOVED_THRESHOLD_M): boolean {
  if (frames.length === 0) return false;
  return frames.every((f) => distance(f.pose.position, currentPose.position) > thresholdM);
}
