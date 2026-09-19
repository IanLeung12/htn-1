import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TUNING,
  TUNING_PRESETS,
  TUNING_SPEC,
  TuningStore,
  loadTuning,
  type CameraTuning,
  type TuningPresetId,
} from '@/camera/tuning';

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

const KEY = 'test:tuning-presets';
const PRESET_IDS: readonly TuningPresetId[] = ['laptop-desk', 'phone-handheld', 'tripod-room'];

describe('TUNING_PRESETS', () => {
  it('stays within TUNING_SPEC bounds for every listed value (clamp is a no-op)', () => {
    for (const id of PRESET_IDS) {
      const preset = TUNING_PRESETS[id];
      for (const key of Object.keys(preset.values) as (keyof CameraTuning)[]) {
        const value = preset.values[key] as number;
        const spec = TUNING_SPEC[key];
        expect(value).toBeGreaterThanOrEqual(spec.min);
        expect(value).toBeLessThanOrEqual(spec.max);
      }
    }
  });

  it('has a label and description for every preset', () => {
    for (const id of PRESET_IDS) {
      const preset = TUNING_PRESETS[id];
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });
});

describe('TuningStore.applyPreset', () => {
  it('patches only the keys listed by the preset, leaving the rest untouched', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    store.set('depthScale', 2);

    store.applyPreset('laptop-desk');

    const preset = TUNING_PRESETS['laptop-desk'];
    for (const key of Object.keys(preset.values) as (keyof CameraTuning)[]) {
      expect(store.value[key]).toBe(preset.values[key]);
    }
    // Untouched key from before the preset was applied.
    expect(store.value.depthScale).toBe(2);
  });

  it('persists the applied preset', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    store.applyPreset('phone-handheld');
    const persisted = loadTuning(storage, KEY);
    const preset = TUNING_PRESETS['phone-handheld'];
    for (const key of Object.keys(preset.values) as (keyof CameraTuning)[]) {
      expect(persisted[key]).toBe(preset.values[key]);
    }
  });

  it('notifies subscribers when a preset is applied', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.applyPreset('tripod-room');
    expect(calls).toBe(1);
  });
});

describe('TuningStore.resetKey', () => {
  it('restores a single key to its default value', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    store.set('cameraHeightM', 2.2);
    store.set('pitchDeg', -50);

    store.resetKey('cameraHeightM');

    expect(store.value.cameraHeightM).toBe(DEFAULT_TUNING.cameraHeightM);
    // Other keys untouched.
    expect(store.value.pitchDeg).toBe(-50);
  });

  it('persists the reset value', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    store.set('fovYDeg', 90);
    store.resetKey('fovYDeg');
    expect(loadTuning(storage, KEY).fovYDeg).toBe(DEFAULT_TUNING.fovYDeg);
  });

  it('does not notify when the value is already at its default', () => {
    const storage = new FakeStorage();
    const store = new TuningStore({ storage, key: KEY });
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.resetKey('cameraHeightM');
    expect(calls).toBe(0);
  });
});
