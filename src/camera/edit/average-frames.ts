/**
 * Averages several `CameraFrame`s taken from (approximately) the same
 * viewpoint into one - used by `Capture plate` on a static camera (see
 * docs/general-camera/architecture.md and `src/camera/app.ts`'s
 * `captureCleanPlate`): a static camera cannot get parallax from multiple
 * angles, so instead of one noisy shot we take several over ~1 s and reduce
 * per-pixel noise by averaging colour (mean) and depth (median, robust to
 * the odd depth-estimator outlier frame).
 */
import type { CameraFrame } from '@/capture/contract';

/**
 * Averages `frames` (must be non-empty, same width/height) into a single
 * `CameraFrame`: RGB is the mean, depth is the per-pixel median (frames
 * without depth are ignored for that pixel), and the last frame's
 * pose/fovY/aspect/depthSource/depthToleranceM are kept (a static camera
 * means these should already agree across frames). `depthConfidence` is the
 * mean of the frames that reported one.
 */
export function averageFrames(frames: readonly CameraFrame[]): CameraFrame {
  const first = frames[0];
  if (!first) throw new Error('averageFrames requires at least one frame');
  if (frames.length === 1) return first;

  const { width, height } = first;
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n * 4; i += 4) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (const f of frames) {
      if (f.width !== width || f.height !== height) continue;
      r += f.rgba[i] ?? 0;
      g += f.rgba[i + 1] ?? 0;
      b += f.rgba[i + 2] ?? 0;
      count += 1;
    }
    rgba[i] = count > 0 ? Math.round(r / count) : 0;
    rgba[i + 1] = count > 0 ? Math.round(g / count) : 0;
    rgba[i + 2] = count > 0 ? Math.round(b / count) : 0;
    rgba[i + 3] = 255;
  }

  const hasDepth = frames.some((f) => f.depth && f.depth.length === n);
  let depth: Float32Array | undefined;
  if (hasDepth) {
    depth = new Float32Array(n);
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      samples.length = 0;
      for (const f of frames) {
        const d = f.depth?.[i];
        if (d !== undefined && d > 0) samples.push(d);
      }
      if (samples.length === 0) {
        depth[i] = 0;
        continue;
      }
      samples.sort((a, b) => a - b);
      const mid = Math.floor(samples.length / 2);
      depth[i] = samples.length % 2 === 0 ? ((samples[mid - 1] as number) + (samples[mid] as number)) / 2 : (samples[mid] as number);
    }
  }

  const confidences = frames.map((f) => f.depthConfidence).filter((c): c is number => c !== undefined);
  const depthConfidence = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : first.depthConfidence;

  const last = frames[frames.length - 1] as CameraFrame;
  return {
    width,
    height,
    rgba,
    depth,
    pose: last.pose,
    fovY: last.fovY,
    aspect: last.aspect,
    timestamp: last.timestamp,
    depthSource: last.depthSource,
    depthConfidence,
    poseConfidence: last.poseConfidence,
    depthToleranceM: last.depthToleranceM,
  };
}
