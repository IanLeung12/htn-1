import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { depthMillimetresToMetres, fovYFromIntrinsics, parseBridgeMessage, poseFromColumnMajor, quatFromColumnMajor } from '@/camera/zedsdk/protocol';
import { quatRotateVec3 } from '@/core/math';

function chunk(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function concat(parts: Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
}

/** Column-major 4x4 from a rotation about y by `yaw` and a translation. */
function matrixYaw(yaw: number, t: [number, number, number]): number[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // rows: [c 0 s tx; 0 1 0 ty; -s 0 c tz; 0 0 0 1] -> column-major
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, t[0], t[1], t[2], 1];
}

describe('zed-sdk bridge protocol', () => {
  it('parses header / jpeg / depth / confidence chunks', () => {
    const header = { v: 1, frame: 3, timestamp: 1, sentAt: 2, width: 4, height: 2, fx: 3, fy: 3, cx: 2, cy: 1, depthWidth: 2, depthHeight: 1, pose: matrixYaw(0, [0, 1, 0]), trackingState: 'OK', depthMin: 1, depthMax: 2, floorY: 0 };
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const depth = deflateSync(Buffer.from(new Uint16Array([1500, 0]).buffer));
    const conf = deflateSync(Buffer.from(new Uint8Array([255, 0])));
    const msg = parseBridgeMessage(concat([chunk(new TextEncoder().encode(JSON.stringify(header))), chunk(jpeg), chunk(new Uint8Array(depth)), chunk(new Uint8Array(conf))]));
    expect(msg.header.frame).toBe(3);
    expect(msg.header.trackingState).toBe('OK');
    expect(Array.from(msg.jpeg)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(msg.depthZlib.length).toBe(depth.length);
    expect(msg.confZlib.length).toBe(conf.length);
  });

  it('rejects truncated messages', () => {
    expect(() => parseBridgeMessage(new Uint8Array([9, 0, 0, 0, 1]).buffer)).toThrow(/chunk exceeds/);
  });

  it('converts a column-major camera-to-world matrix into the app pose', () => {
    const yaw = 0.7;
    const pose = poseFromColumnMajor(matrixYaw(yaw, [0.5, 1.2, -0.3]));
    expect(pose.position).toEqual({ x: 0.5, y: 1.2, z: -0.3 });
    // The camera looks along -z; yawing by +0.7 about +y turns that toward -x.
    const fwd = quatRotateVec3(pose.rotation, { x: 0, y: 0, z: -1 });
    expect(fwd.x).toBeCloseTo(-Math.sin(yaw), 6);
    expect(fwd.z).toBeCloseTo(-Math.cos(yaw), 6);
    expect(fwd.y).toBeCloseTo(0, 6);
  });

  it('quaternion covers all branches of the matrix-to-quaternion conversion', () => {
    const rotX180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    const q = quatFromColumnMajor(rotX180);
    expect(Math.abs(q.x)).toBeCloseTo(1, 6);
    const rotY180 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    expect(Math.abs(quatFromColumnMajor(rotY180).y)).toBeCloseTo(1, 6);
    const rotZ180 = [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(Math.abs(quatFromColumnMajor(rotZ180).z)).toBeCloseTo(1, 6);
  });

  it('derives fovY from fy and masks depth by confidence', () => {
    expect(fovYFromIntrinsics(700, 720)).toBeCloseTo(2 * Math.atan(360 / 700), 9);
    const out = new Float32Array(4);
    const valid = depthMillimetresToMetres(new Uint16Array([1000, 2500, 0, 4000]), new Uint8Array([255, 100, 255, 200]), out, 128);
    expect(Array.from(out)).toEqual([1, 0, 0, 4]);
    expect(valid).toBe(0.5);
  });
});
