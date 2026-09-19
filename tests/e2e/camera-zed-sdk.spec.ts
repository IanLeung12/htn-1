/**
 * ZED SDK bridge end to end against `tools/zed-bridge/server.py --fake`
 * (synthetic room, no camera / SDK): the page opened with
 * `?source=zed-sdk&bridge=ws://localhost:<port>` shows the bridge's frames,
 * publishes its depth as 'zed-sdk' (tier A allowed) and follows its 6DoF pose
 * with the floor at y = 0. Skipped when no Python with websockets/numpy/opencv
 * is available.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './camera-fixtures';

const BRIDGE_PORT = 8766;
const SERVER = path.resolve('tools', 'zed-bridge', 'server.py');

function findPython(): string | null {
  const venv = path.resolve('tools', 'zed-bridge', '.venv', 'Scripts', 'python.exe');
  const candidates = [venv, 'python', 'python3', 'py'];
  for (const cmd of candidates) {
    if (cmd === venv && !fs.existsSync(venv)) continue;
    const probe = spawnSync(cmd, ['-c', 'import websockets, numpy, cv2'], { encoding: 'utf-8', timeout: 20_000, windowsHide: true });
    if (probe.status === 0) return cmd;
  }
  return null;
}

const python = findPython();
let bridge: ChildProcess | null = null;

test.describe('zed-sdk bridge (fake)', () => {
  test.skip(python === null, 'python with websockets/numpy/opencv-python not found');
  test.use({ cameraParams: { source: 'zed-sdk', bridge: `ws://localhost:${BRIDGE_PORT}`, depth: 'auto', pose: 'auto' } });

  test.beforeAll(async () => {
    bridge = spawn(python as string, [SERVER, '--fake', '--port', String(BRIDGE_PORT)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('zed-bridge --fake did not start')), 20_000);
      bridge?.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready on ws://')) {
          clearTimeout(timer);
          resolve();
        }
      });
      bridge?.stderr?.on('data', (chunk: Buffer) => console.error('[zed-bridge]', chunk.toString().trim()));
      bridge?.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`zed-bridge exited with ${code}`));
      });
    });
  });

  test.afterAll(() => {
    bridge?.kill();
    bridge = null;
  });

  test('frames, measured depth and tracked pose arrive from the bridge', async ({ camPage, evalCam }) => {
    await expect.poll(async () => evalCam(() => window.__realityEditor!.inSession && window.__camera!.frameSource.ready), { timeout: 20_000 }).toBe(true);
    expect(await evalCam(() => window.__camera!.frameSource.kind)).toBe('zed-sdk');
    expect(await evalCam(() => window.__camera!.config.source)).toBe('zed-sdk');

    // Passthrough: the bridge's 640x360 left image, fps from the decoded frames.
    await expect.poll(async () => evalCam(() => window.__zedBridge!.frameSource.fps), { timeout: 10_000 }).toBeGreaterThan(10);
    const intr = await evalCam(() => window.__camera!.frameSource.intrinsics);
    expect(intr.width).toBe(640);
    expect(intr.height).toBe(360);
    // fovY from the fake bridge's fy = 350 px at 360 px high.
    expect(intr.fovY).toBeCloseTo(2 * Math.atan(180 / 350), 3);

    // Depth: published as 'zed-sdk', confidence 0.95, centre of the synthetic room ~3.2 m (back wall).
    await expect.poll(async () => evalCam(() => window.__camera!.depthEstimator.latest?.source ?? null), { timeout: 10_000 }).toBe('zed-sdk');
    const depth = await evalCam(() => {
      const m = window.__camera!.depthEstimator.latest!;
      const centre = m.metric[(m.height >> 1) * m.width + (m.width >> 1)]!;
      return { w: m.width, h: m.height, centre, confidence: m.confidence, hasConfMap: m.confidenceMap instanceof Uint8Array, state: window.__camera!.depthEstimator.status.state, backend: window.__camera!.depthEstimator.status.backend };
    });
    expect(depth.w).toBe(320);
    expect(depth.h).toBe(180);
    expect(depth.centre).toBeGreaterThan(2.5);
    expect(depth.centre).toBeLessThan(4);
    expect(depth.confidence).toBeCloseTo(0.95, 5);
    expect(depth.hasConfMap).toBe(true);
    expect(depth.state).toBe('ready');
    expect(depth.backend).toBe('bridge');
    await expect.poll(async () => evalCam(() => window.__camera!.diagnostics.tierCap), { timeout: 5_000 }).toBe('A');

    // Pose: tracked, OK, camera 1.1 m above the floor (floor at y = 0 from the bridge's floorY), looking down.
    await expect.poll(async () => evalCam(() => window.__camera!.poseSource.quality.trackingOk), { timeout: 5_000 }).toBe(true);
    const pose = await evalCam(() => ({ mode: window.__camera!.poseSource.quality.mode, pose: window.__camera!.poseSource.pose, floorMode: window.__zedBridge!.poseSource.floorMode }));
    expect(pose.mode).toBe('tracked');
    expect(pose.floorMode).toBe('sdk');
    expect(pose.pose.position.y).toBeCloseTo(1.1, 2);
    // The fake camera is pitched 20 degrees down: the forward vector has a negative y.
    const q = pose.pose.rotation;
    const fwdY = 2 * (q.w * q.x - q.y * q.z); // y of R * (0,0,-1)
    expect(fwdY).toBeCloseTo(-Math.sin((20 * Math.PI) / 180), 2);

    // Pointer ray: with the pointer at the screen centre, the hand ray must follow the LIVE tracked
    // pose (direction = camera forward, origin on the line through the pose position), never a
    // static camera at the tuning height.
    const box = await camPage.locator('canvas').last().boundingBox();
    expect(box).not.toBeNull();
    await camPage.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await camPage.waitForTimeout(150);
    const ray = await evalCam(() => {
      const cam = window.__camera!;
      const p = cam.poseSource.pose;
      const q = p.rotation;
      const fwd = { x: -2 * (q.x * q.z + q.w * q.y), y: 2 * (q.w * q.x - q.y * q.z), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) };
      const r = cam.pointer.state.right.ray;
      return { active: cam.pointer.state.right.active, fwd, dir: { x: r.direction.x, y: r.direction.y, z: r.direction.z }, origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z }, pos: p.position };
    });
    expect(ray.active).toBe(true);
    const dot = ray.fwd.x * ray.dir.x + ray.fwd.y * ray.dir.y + ray.fwd.z * ray.dir.z;
    expect((Math.acos(Math.min(1, dot)) * 180) / Math.PI).toBeLessThan(1);
    // origin = pose position + k * direction (the adapter pulls the origin toward the hit point).
    const d = { x: ray.origin.x - ray.pos.x, y: ray.origin.y - ray.pos.y, z: ray.origin.z - ray.pos.z };
    const k = d.x * ray.dir.x + d.y * ray.dir.y + d.z * ray.dir.z;
    expect(Math.hypot(d.x - k * ray.dir.x, d.y - k * ray.dir.y, d.z - k * ray.dir.z)).toBeLessThan(0.01);

    // A capture through the pipeline carries the measured depth.
    const frame = await evalCam(async () => {
      const cam = window.__camera!;
      const grabbed = cam.frameSource.grab(320)!;
      const sample = cam.depthEstimator.sample(grabbed.width, grabbed.height, cam.poseSource.pose, cam.frameSource.intrinsics.fovY, grabbed.width / grabbed.height)!;
      return { w: grabbed.width, h: grabbed.height, source: sample.source, tol: sample.toleranceM, nonZero: Array.from(sample.metric).filter((d) => d > 0).length / sample.metric.length };
    });
    expect(frame.w).toBe(320);
    expect(frame.source).toBe('zed-sdk');
    expect(frame.tol).toBeLessThan(0.1);
    expect(frame.nonZero).toBeGreaterThan(0.9);

    // Stopping the bridge drops tracking (stale frames) instead of freezing on the last pose.
    bridge?.kill();
    await expect.poll(async () => evalCam(() => window.__camera!.poseSource.quality.trackingOk), { timeout: 5_000 }).toBe(false);
  });
});
