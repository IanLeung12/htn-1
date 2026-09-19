import { describe, expect, it } from 'vitest';
import { ZedSdkPoseSource } from '@/camera/zedsdk/pose';
import type { ZedBridgeClient, DecodedBridgeFrame } from '@/camera/zedsdk/bridge-client';
import type { BridgeHeader } from '@/camera/zedsdk/protocol';

/** A stub client: `onFrame` hands back the listener so the test can push frames. */
function stubClient(): { client: ZedBridgeClient; push: (h: Partial<BridgeHeader>, at: number) => void; resets: number } {
  let listener: ((f: DecodedBridgeFrame) => void) | null = null;
  const state = { resets: 0 };
  const client = {
    stats: { connected: true, fps: 0, dropped: 0, frames: 0, transportMs: 0, decodeMs: 0, bytesPerSecond: 0, source: 'stub', error: null },
    onFrame(l: (f: DecodedBridgeFrame) => void) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    resetTracking() {
      state.resets += 1;
    },
  } as unknown as ZedBridgeClient;
  const push = (h: Partial<BridgeHeader>, at: number): void => {
    const header: BridgeHeader = { v: 1, frame: 0, timestamp: at, sentAt: at, width: 640, height: 360, fx: 350, fy: 350, cx: 320, cy: 180, depthWidth: 2, depthHeight: 1, pose: identityAt(0, 0, 0), trackingState: 'OK', depthMin: 0, depthMax: 0, floorY: 0, ...h };
    listener?.({ header, image: {} as ImageBitmap, depthMm: new Uint16Array(2), confidence: new Uint8Array(2), receivedAt: at, transportMs: 0, decodeMs: 0 });
  };
  return { client, push, get resets() { return state.resets; } };
}

function identityAt(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

describe('ZedSdkPoseSource floor policy', () => {
  it('trusts the SDK floor when the implied camera height matches the tuning height', async () => {
    const { client, push } = stubClient();
    const src = new ZedSdkPoseSource(client, { cameraHeightM: 0.75 });
    await src.start();
    push({ pose: identityAt(0, 0.8, 0), floorY: 0 }, 100);
    src.update(100);
    expect(src.floorMode).toBe('sdk');
    expect(src.pose.position.y).toBeCloseTo(0.8, 9);
    expect(src.quality.trackingOk).toBe(true);
    expect(src.quality.mode).toBe('tracked');
    // A later depth plane does not move a trusted SDK floor.
    src.applyGroundPlane(-0.5, 1, 5000, 3);
    expect(src.pose.position.y).toBeCloseTo(0.8, 9);
  });

  it('falls back to the tuning height when the SDK floor is implausible, then to the depth ground plane', async () => {
    const { client, push } = stubClient();
    const src = new ZedSdkPoseSource(client, { cameraHeightM: 0.75 });
    await src.start();
    // SDK put its "floor" on the desk 0.11 m under the camera: implausible for a 0.75 m camera.
    push({ pose: identityAt(0, 0.11, 0), floorY: 0 }, 100);
    expect(src.floorMode).toBe('tuning');
    expect(src.pose.position.y).toBeCloseTo(0.75, 9);
    // Small / weak planes are ignored.
    src.applyGroundPlane(0.1, 0.2, 100, 0.2);
    expect(src.floorMode).toBe('tuning');
    // The dominant plane seen in depth sits 0.64 m under the published camera (y = 0.75 - 0.64 = 0.11): it becomes y = 0.
    src.applyGroundPlane(0.11, 0.9, 3000, 2);
    expect(src.floorMode).toBe('plane');
    expect(src.pose.position.y).toBeCloseTo(0.64, 6);
    // Subsequent tracked frames keep the same offset.
    push({ pose: identityAt(0.2, 0.31, -0.5), floorY: 0 }, 200);
    expect(src.pose.position.y).toBeCloseTo(0.84, 6);
    expect(src.pose.position.x).toBeCloseTo(0.2, 9);
    // Jitter under 3 cm does not move the world.
    src.applyGroundPlane(0.02, 0.9, 3000, 2);
    expect(src.pose.position.y).toBeCloseTo(0.84, 6);
  });

  it('leaves a desk right under the camera to the estimator (not adopted as the floor)', async () => {
    const { client, push } = stubClient();
    const src = new ZedSdkPoseSource(client, { cameraHeightM: 0.75 });
    await src.start();
    push({ pose: identityAt(0, 0.05, 0), floorY: 0 }, 100);
    expect(src.floorMode).toBe('tuning');
    expect(src.pose.position.y).toBeCloseTo(0.75, 9);
    // Dominant plane 0.05 m under the published camera (y = 0.70): a 0.05 m camera height is not plausible.
    src.applyGroundPlane(0.7, 0.95, 900, 1.4);
    expect(src.floorMode).toBe('tuning');
    expect(src.pose.position.y).toBeCloseTo(0.75, 9);
  });

  it('drops trackingOk when frames stop or the SDK is searching', async () => {
    const { client, push } = stubClient();
    const src = new ZedSdkPoseSource(client, { cameraHeightM: 1 });
    await src.start();
    push({ pose: identityAt(0, 1, 0) }, 0);
    src.update(100);
    expect(src.quality.trackingOk).toBe(true);
    src.update(900);
    expect(src.quality.trackingOk).toBe(false);
    push({ pose: identityAt(0, 1, 0), trackingState: 'SEARCHING' }, 1000);
    src.update(1000);
    expect(src.quality.trackingOk).toBe(false);
    expect(src.quality.confidence).toBeCloseTo(0.3, 9);
  });
});
