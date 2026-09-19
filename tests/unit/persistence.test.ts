import { describe, expect, it, vi } from 'vitest';
import { autoPersist, createLocalStorageAdapter, createMemoryStorage, restore } from '@/core/persistence';
import { createSceneStore } from '@/core/store';
import { makeConditions, makeObject } from '@/core/fixtures';

describe('createMemoryStorage', () => {
  it('get/set/remove round trip', async () => {
    const storage = createMemoryStorage();
    expect(await storage.get('k')).toBeNull();
    await storage.set('k', 'v');
    expect(await storage.get('k')).toBe('v');
    await storage.remove('k');
    expect(await storage.get('k')).toBeNull();
  });
});

describe('createLocalStorageAdapter', () => {
  it('is a safe no-op when localStorage is unavailable', async () => {
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    // @ts-expect-error - simulate an environment without localStorage
    delete globalThis.localStorage;
    try {
      const adapter = createLocalStorageAdapter('re:');
      await expect(adapter.set('k', 'v')).resolves.toBeUndefined();
      await expect(adapter.get('k')).resolves.toBeNull();
      await expect(adapter.remove('k')).resolves.toBeUndefined();
    } finally {
      if (original !== undefined) (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });

  it('prefixes keys and round trips through a fake localStorage', async () => {
    const backing = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => backing.set(k, v),
      removeItem: (k: string) => backing.delete(k),
    };
    const adapter = createLocalStorageAdapter('re:');
    await adapter.set('scene', 'blob');
    expect(backing.get('re:scene')).toBe('blob');
    expect(await adapter.get('scene')).toBe('blob');
    await adapter.remove('scene');
    expect(backing.has('re:scene')).toBe(false);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});

describe('autoPersist / restore', () => {
  it('debounces writes and coalesces rapid commits into one persisted blob', async () => {
    vi.useFakeTimers();
    try {
      const object = makeObject({ id: 'o1' });
      const store = createSceneStore({ version: 1, objects: { o1: object } });
      const storage = createMemoryStorage();
      const unsubscribe = autoPersist(store, storage, 'scene', 100);

      store.dispatch(
        { intent: { kind: 'rotate', objectId: 'o1', rotation: { x: 0, y: 0, z: 0, w: 1 } }, source: 'test', issuedAt: 0, basedOnVersion: 1 },
        makeConditions(),
      );
      await vi.advanceTimersByTimeAsync(50);
      store.dispatch(
        { intent: { kind: 'delete', objectId: 'o1' }, source: 'test', issuedAt: 0, basedOnVersion: store.current.version },
        makeConditions(),
      );

      expect(await storage.get('scene')).toBeNull(); // still debounced

      await vi.advanceTimersByTimeAsync(150);
      const blob = await storage.get('scene');
      expect(blob).not.toBeNull();
      expect(JSON.parse(blob as string).snapshot.objects.o1.visible).toBe(false);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restore hydrates a store from a previously persisted blob', async () => {
    const object = makeObject({ id: 'o1' });
    const sourceStore = createSceneStore({ version: 1, objects: { o1: object } });
    sourceStore.dispatch(
      { intent: { kind: 'delete', objectId: 'o1' }, source: 'test', issuedAt: 0, basedOnVersion: 1 },
      makeConditions(),
    );
    const storage = createMemoryStorage();
    await storage.set('scene', sourceStore.serialize());

    const freshStore = createSceneStore();
    const ok = await restore(freshStore, storage, 'scene');
    expect(ok).toBe(true);
    expect(freshStore.current.objects.o1?.visible).toBe(false);
  });

  it('restore returns false when nothing was persisted', async () => {
    const storage = createMemoryStorage();
    const store = createSceneStore();
    expect(await restore(store, storage, 'missing')).toBe(false);
  });

  it('autoPersist transform converts poses before writing, restore transform converts them back', async () => {
    vi.useFakeTimers();
    try {
      const object = makeObject({ id: 'o1', currentPose: { position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
      const store = createSceneStore({ version: 1, objects: { o1: object } });
      const storage = createMemoryStorage();

      // Anchor-relative persistence stand-in: shift x by -5 going to storage, +5 coming back.
      const toStorage = (snapshot: import('@/core/types').SceneSnapshot) => ({
        ...snapshot,
        objects: Object.fromEntries(
          Object.entries(snapshot.objects).map(([id, o]) => [
            id,
            { ...o, currentPose: { ...o.currentPose, position: { ...o.currentPose.position, x: o.currentPose.position.x - 5 } } },
          ]),
        ),
      });
      const fromStorage = (snapshot: import('@/core/types').SceneSnapshot) => ({
        ...snapshot,
        objects: Object.fromEntries(
          Object.entries(snapshot.objects).map(([id, o]) => [
            id,
            { ...o, currentPose: { ...o.currentPose, position: { ...o.currentPose.position, x: o.currentPose.position.x + 5 } } },
          ]),
        ),
      });

      const unsubscribe = autoPersist(store, storage, 'scene', 10, 20, { transform: toStorage });
      store.dispatch(
        { intent: { kind: 'rotate', objectId: 'o1', rotation: { x: 0, y: 0, z: 0, w: 1 } }, source: 'test', issuedAt: 0, basedOnVersion: 1 },
        makeConditions(),
      );
      await vi.advanceTimersByTimeAsync(30);
      unsubscribe();

      const stored = JSON.parse((await storage.get('scene')) as string);
      expect(stored.snapshot.objects.o1.currentPose.position.x).toBe(0); // 5 - 5, anchor-relative

      const freshStore = createSceneStore();
      const ok = await restore(freshStore, storage, 'scene', fromStorage);
      expect(ok).toBe(true);
      expect(freshStore.current.objects.o1?.currentPose.position.x).toBe(5); // 0 + 5, back to world
    } finally {
      vi.useRealTimers();
    }
  });
});
