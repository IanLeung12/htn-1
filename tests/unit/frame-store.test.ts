import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT } from '@/core/types';
import type { CameraFrame } from '@/capture/contract';
import { createFrameStore } from '@/capture/frame-store';

function makeFrame(id: number): CameraFrame {
  return {
    width: 2,
    height: 2,
    rgba: new Uint8ClampedArray(16),
    pose: { position: { x: id, y: 0, z: 0 }, rotation: IDENTITY_QUAT },
    fovY: Math.PI / 3,
    aspect: 1,
    timestamp: id,
  };
}

describe('createFrameStore', () => {
  it('returns undefined for an id that was never put', () => {
    const store = createFrameStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('round-trips frames by object id', () => {
    const store = createFrameStore();
    const frames = [makeFrame(1), makeFrame(2)];
    store.put('obj:1', frames);
    expect(store.get('obj:1')).toBe(frames);
    expect(store.get('obj:1')).toHaveLength(2);
  });

  it('keeps separate objects independent', () => {
    const store = createFrameStore();
    store.put('obj:1', [makeFrame(1)]);
    store.put('obj:2', [makeFrame(2), makeFrame(3)]);
    expect(store.get('obj:1')).toHaveLength(1);
    expect(store.get('obj:2')).toHaveLength(2);
  });

  it('overwrites frames for the same id on a second put', () => {
    const store = createFrameStore();
    store.put('obj:1', [makeFrame(1)]);
    store.put('obj:1', [makeFrame(2), makeFrame(3)]);
    expect(store.get('obj:1')).toHaveLength(2);
  });

  it('delete removes stored frames', () => {
    const store = createFrameStore();
    store.put('obj:1', [makeFrame(1)]);
    store.delete('obj:1');
    expect(store.get('obj:1')).toBeUndefined();
  });
});
