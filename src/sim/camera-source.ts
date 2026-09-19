/**
 * CameraFrameSource backed by IWER's Synthetic Environment Module (SEM).
 *
 * SEM renders the loaded capture (living_room.json etc.) from `xrDevice.position` /
 * `xrDevice.quaternion` into its own offscreen WebGL canvas (`sem.environmentCanvas`)
 * every XR frame (see iwer's XRSession device-frame loop, which calls `sem.render(now)`
 * automatically while a session is active). We additionally call `sem.render()` inside
 * `capture()` so a frame is available even before any session exists (e.g. for tests that
 * grab a frame pre-enterAR).
 *
 * Depth comes from `sem.computeDepthBuffer(viewMatrix, projectionMatrix, w, h, near, far)`,
 * which renders SEM's own scene a second time with a depth material. It expects the
 * *view* matrix (world-to-camera, i.e. `camera.matrixWorldInverse`) and inverts it
 * internally to recover the camera's world transform - so we must not pass the camera's
 * world matrix directly.
 */
import * as THREE from 'three';
import type { XRDevice } from 'iwer';
import type { CameraFrame, CameraFrameSource } from '@/capture/contract';
import type { Pose } from '@/core/types';

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 240;
const DEPTH_NEAR = 0.1;
const DEPTH_FAR = 8;

export class SimCameraFrameSource implements CameraFrameSource {
  private readonly xrDevice: XRDevice;
  private width: number;
  private height: number;
  private readonly offscreen: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly camera: THREE.PerspectiveCamera;

  constructor(xrDevice: XRDevice, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
    this.xrDevice = xrDevice;
    this.width = width;
    this.height = height;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = width;
    this.offscreen.height = height;
    const ctx = this.offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('SimCameraFrameSource: 2D canvas context unavailable');
    this.ctx = ctx;
    this.camera = new THREE.PerspectiveCamera((xrDevice.fovy * 180) / Math.PI, width / height, DEPTH_NEAR, DEPTH_FAR);
  }

  /**
   * SEM renders the passthrough canvas with the device FOV and the app canvas aspect,
   * so the colour frame and our depth frame only line up if we use the same aspect.
   */
  private matchAspect(envCanvas: HTMLCanvasElement): void {
    if (envCanvas.width === 0 || envCanvas.height === 0) return;
    const aspect = envCanvas.width / envCanvas.height;
    const height = Math.max(8, Math.round(this.width / aspect));
    if (height === this.height) return;
    this.height = height;
    this.offscreen.height = height;
  }

  get available(): boolean {
    return !!this.xrDevice.sem;
  }

  async capture(viewpoint?: Pose): Promise<CameraFrame | null> {
    const sem = this.xrDevice.sem;
    if (!sem) return null;

    // Render from the requested pose without disturbing the live head pose.
    const saved = viewpoint
      ? { p: this.xrDevice.position.clone(), q: this.xrDevice.quaternion.clone() }
      : null;
    if (viewpoint) {
      this.xrDevice.position.set(viewpoint.position.x, viewpoint.position.y, viewpoint.position.z);
      this.xrDevice.quaternion.set(viewpoint.rotation.x, viewpoint.rotation.y, viewpoint.rotation.z, viewpoint.rotation.w);
    }
    try {
      return this.captureCurrent(sem);
    } finally {
      if (saved) {
        this.xrDevice.position.copy(saved.p);
        this.xrDevice.quaternion.copy(saved.q);
      }
    }
  }

  private captureCurrent(sem: NonNullable<XRDevice['sem']>): CameraFrame | null {
    sem.render(performance.now());
    this.matchAspect(sem.environmentCanvas);

    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(sem.environmentCanvas, 0, 0, this.width, this.height);
    const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
    const rgba = new Uint8ClampedArray(imageData.data);

    const devicePos = this.xrDevice.position;
    const deviceQuat = this.xrDevice.quaternion;

    this.camera.position.set(devicePos.x, devicePos.y, devicePos.z);
    this.camera.quaternion.set(deviceQuat.x, deviceQuat.y, deviceQuat.z, deviceQuat.w);
    this.camera.fov = (this.xrDevice.fovy * 180) / Math.PI;
    this.camera.aspect = this.width / this.height;
    this.camera.near = DEPTH_NEAR;
    this.camera.far = DEPTH_FAR;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    // gl-matrix's mat4 is a flat 16-number column-major array, same layout as
    // three's Matrix4.elements/toArray(); `sem.computeDepthBuffer` is typed against
    // gl-matrix's mat4 (from @iwer/sem, not re-exported by `iwer`), so we cast here
    // rather than take an undeclared dependency on gl-matrix just for a type.
    const viewMatrix = this.camera.matrixWorldInverse.toArray(new Float32Array(16));
    const projMatrix = this.camera.projectionMatrix.toArray(new Float32Array(16));

    let depth: Float32Array | undefined;
    const depthResult = sem.computeDepthBuffer(
      viewMatrix as unknown as Parameters<typeof sem.computeDepthBuffer>[0],
      projMatrix as unknown as Parameters<typeof sem.computeDepthBuffer>[1],
      this.width,
      this.height,
      DEPTH_NEAR,
      DEPTH_FAR,
    );
    if (depthResult) {
      depth = correctSemDepth(new Float32Array(depthResult.data), DEPTH_NEAR, DEPTH_FAR);
    }

    return {
      width: this.width,
      height: this.height,
      rgba,
      depth,
      pose: {
        position: { x: devicePos.x, y: devicePos.y, z: devicePos.z },
        rotation: { x: deviceQuat.x, y: deviceQuat.y, z: deviceQuat.z, w: deviceQuat.w },
      },
      fovY: this.xrDevice.fovy,
      aspect: this.width / this.height,
      timestamp: performance.now(),
    };
  }
}

/**
 * @iwer/sem decodes its RGBADepthPacking render target as r + g/256 + b/65536 + a/2^24,
 * but three.js packs each channel with a 255/256 unpack downscale, so the decoded
 * normalized depth is inflated by 256/255 and the linearized metres drift 3-8% too far
 * at room scale. Re-pack the metres back to normalized depth, apply the missing
 * downscale, and linearize again. Verified empirically: 1.0/1.5/2.0 m read
 * 1.028/1.58/2.15 before correction.
 */
export function correctSemDepth(depth: Float32Array, near: number, far: number): Float32Array {
  const range = far - near;
  for (let i = 0; i < depth.length; i++) {
    const m = depth[i] as number;
    if (!(m > 0) || m >= far) continue;
    const dInflated = (far - (near * far) / m) / range;
    const d = dInflated * (255 / 256);
    depth[i] = (near * far) / (far - d * range);
  }
  return depth;
}
