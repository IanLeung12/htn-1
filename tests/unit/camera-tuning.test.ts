import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, TUNING_SPEC, TuningStore, loadTuning, saveTuning, type CameraTuning } from '@/camera/tuning';

class FakeStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const KEY = 'test:tuning';

describe('loadTuning / saveTuning', () => {
  it('round-trips a saved tuning', () => {
    const storage = new FakeStorage();
    const custom: CameraTuning = { ...DEFAULT_TUNING, cameraHeightM: 1.5, ransacIterations: 300 };
    saveTuning(custom, storage, KEY);
    const loaded = loadTuning(storage, KEY);
    expect(loaded).toEqual(custom);
  });

  it('returns defaults when nothing persisted', () => {
    const storage = new FakeStorage();
    expect(loadTuning(storage, KEY)).toEqual(DEFAULT_TUNING);
  });

  it('clamps out-of-range persisted values to the spec bounds', () => {
    const storage = new FakeStorage();
    storage.setItem(KEY, JSON.stringify({ cameraHeightM: 999, pitchDeg: -999, ransacIterations: -5 }));
    const loaded = loadTuning(storage, KEY);
    expect(loaded.cameraHeightM).toBe(TUNING_SPEC.cameraHeightM.max);
    expect(loaded.pitchDeg).toBe(TUNING_SPEC.pitchDeg.min);
    expect(loaded.ransacIterations).toBe(TUNING_SPEC.ransacIterations.min);
  });

  it('ignores non-numeric junk and unknown keys', () => {
    const storage = new FakeStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        cameraHeightM: 'tall',
        pitchDeg: null,
        fovYDeg: [1, 2, 3],
        somethingUnknown: 42,
        depthScale: NaN,
      }),
    );
    const loaded = loadTuning(storage, KEY);
    expect(loaded).toEqual(DEFAULT_TUNING);
  });

  it('ignores malformed JSON', () => {
    const storage = new FakeStorage();
    storage.setItem(KEY, '{not json');
    expect(loadTuning(storage, KEY)).toEqual(DEFAULT_TUNING);
  });

  it('never throws when storage is null', () => {
    expect(loadTuning(null, KEY)).toEqual(DEFAULT_TUNING);
    expect(() => saveTuning(DEFAULT_TUNING as CameraTuning, null, KEY)).not.toThrow();
  });
});

describe('TuningStore', () => {
  it('applies initial overrides on top of persisted values', () => {
    const storage = new FakeStorage();
    saveTuning({ ...DEFAULT_TUNING, cameraHeightM: 1.5 }, storage, KEY);
    const store = new TuningStore({ storage, key: KEY, initial: { fovYDeg: 70 } });
    expect(store.value.cameraHeightM).toBe(1.5);
    expect(store.value.fovYDeg).toBe(70);
  });

  it('clamps initial overrides', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY, initial: { pitchDeg: 999 } });
    expect(store.value.pitchDeg).toBe(TUNING_SPEC.pitchDeg.max);
  });

  it('set() clamps, persists, and notifies with the changed key', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    const events: Array<{ value: CameraTuning; changedKey: keyof CameraTuning | null }> = [];
    store.subscribe((value, changedKey) => events.push({ value, changedKey }));

    store.set('cameraHeightM', 2.4);
    expect(store.value.cameraHeightM).toBe(2.4);
    expect(events).toHaveLength(1);
    expect(events[0]?.changedKey).toBe('cameraHeightM');
    expect(events[0]?.value.cameraHeightM).toBe(2.4);

    const persisted = loadTuning(storage, KEY);
    expect(persisted.cameraHeightM).toBe(2.4);

    store.set('cameraHeightM', 999);
    expect(store.value.cameraHeightM).toBe(TUNING_SPEC.cameraHeightM.max);
    expect(events).toHaveLength(2);
  });

  it('set() with an unchanged (post-clamp) value does not notify', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.set('cameraHeightM', DEFAULT_TUNING.cameraHeightM);
    expect(calls).toBe(0);
  });

  it('reset() restores defaults, persists, and notifies', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    store.set('cameraHeightM', 2.9);
    let lastChangedKey: keyof CameraTuning | null | undefined;
    store.subscribe((_v, changedKey) => (lastChangedKey = changedKey));

    store.reset();
    expect(store.value).toEqual(DEFAULT_TUNING);
    expect(lastChangedKey).toBeNull();
    expect(loadTuning(storage, KEY)).toEqual(DEFAULT_TUNING);
  });

  it('patch() applies multiple fields and persists', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    store.patch({ cameraHeightM: 1.8, pitchDeg: -10 });
    expect(store.value.cameraHeightM).toBe(1.8);
    expect(store.value.pitchDeg).toBe(-10);
    expect(loadTuning(storage, KEY).cameraHeightM).toBe(1.8);
  });

  it('subscribe returns a working unsubscribe', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    let calls = 0;
    const unsubscribe = store.subscribe(() => (calls += 1));
    store.set('cameraHeightM', 1.7);
    expect(calls).toBe(1);
    unsubscribe();
    store.set('cameraHeightM', 1.9);
    expect(calls).toBe(1);
  });
});
