/**
 * Wire format of tools/zed-bridge/server.py (pure TS, no DOM, unit-tested):
 *
 *   u32 headerLength | header JSON | u32 jpegLength | JPEG | u32 depthLength | zlib(uint16 mm)
 *   | u32 confLength | zlib(uint8 confidence, 255 best)
 *
 * All integers little-endian. The pose is a column-major 4x4 camera-to-world
 * matrix in the SDK's RIGHT_HANDED_Y_UP / METER frame, which is the app's
 * world frame (x right, y up, camera looks along -z), so it needs no axis
 * swap - only the floor offset (see pose.ts).
 */
import type { Pose, Quat } from '@/core/types';

export interface BridgeHeader {
  v: number;
  frame: number;
  /** Camera clock, ms. */
  timestamp: number;
  /** Bridge wall clock (Date.now() compatible), ms; same machine as the browser, so receive latency = Date.now() - sentAt. */
  sentAt: number;
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  depthWidth: number;
  depthHeight: number;
  /** 16 numbers, column-major camera-to-world. */
  pose: number[];
  trackingState: string;
  depthMin: number;
  depthMax: number;
  /** World y of the floor (0 when the tracking origin sits on the floor), null when unknown. */
  floorY: number | null;
}

export interface BridgeMessage {
  header: BridgeHeader;
  jpeg: Uint8Array;
  depthZlib: Uint8Array;
  confZlib: Uint8Array;
}

export function parseBridgeMessage(buffer: ArrayBuffer): BridgeMessage {
  const view = new DataView(buffer);
  let offset = 0;
  const readChunk = (): Uint8Array => {
    if (offset + 4 > buffer.byteLength) throw new Error('zed-bridge: truncated message');
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > buffer.byteLength) throw new Error('zed-bridge: chunk exceeds message');
    const chunk = new Uint8Array(buffer, offset, len);
    offset += len;
    return chunk;
  };
  const headerBytes = readChunk();
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as BridgeHeader;
  if (!Array.isArray(header.pose) || header.pose.length !== 16) throw new Error('zed-bridge: header.pose must have 16 entries');
  const jpeg = readChunk();
  const depthZlib = readChunk();
  const confZlib = readChunk();
  return { header, jpeg, depthZlib, confZlib };
}

/** Quaternion from the rotation part of a column-major 4x4 matrix (m[col*4 + row]). */
export function quatFromColumnMajor(m: readonly number[]): Quat {
  const r00 = m[0] as number;
  const r10 = m[1] as number;
  const r20 = m[2] as number;
  const r01 = m[4] as number;
  const r11 = m[5] as number;
  const r21 = m[6] as number;
  const r02 = m[8] as number;
  const r12 = m[9] as number;
  const r22 = m[10] as number;
  const trace = r00 + r11 + r22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (r21 - r12) / s;
    y = (r02 - r20) / s;
    z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s;
    x = 0.25 * s;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = 0.25 * s;
    z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

/** Pose (position + quaternion) from a column-major camera-to-world matrix. */
export function poseFromColumnMajor(m: readonly number[]): Pose {
  return { position: { x: m[12] as number, y: m[13] as number, z: m[14] as number }, rotation: quatFromColumnMajor(m) };
}

/** Vertical field of view (rad) of a pinhole with focal length `fy` px over `height` px. */
export function fovYFromIntrinsics(fy: number, height: number): number {
  return 2 * Math.atan(height / (2 * fy));
}

/**
 * uint16 millimetres -> metres (Float32, 0 for holes), masking pixels whose
 * confidence is under `minConfidence` (0..255). Returns the fraction of valid pixels.
 */
export function depthMillimetresToMetres(mm: Uint16Array, conf: Uint8Array | null, out: Float32Array, minConfidence: number): number {
  let valid = 0;
  for (let i = 0; i < mm.length; i++) {
    const v = mm[i] as number;
    const c = conf ? (conf[i] as number) : 255;
    if (v > 0 && c >= minConfidence) {
      out[i] = v / 1000;
      valid += 1;
    } else {
      out[i] = 0;
    }
  }
  return mm.length > 0 ? valid / mm.length : 0;
}
