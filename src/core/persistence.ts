/**
 * Storage adapters for the scene store plus a small auto-persist helper.
 * Pure TS: the localStorage adapter degrades to a no-op when localStorage
 * is unavailable (SSR, some test environments).
 */
import type { StorageAdapter } from './api';
import type { SceneStore } from './api';

export function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async set(key: string, value: string): Promise<void> {
      map.set(key, value);
    },
    async remove(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

function getLocalStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

export function createLocalStorageAdapter(prefix = 'reality-editor:'): StorageAdapter {
  return {
    async get(key: string): Promise<string | null> {
      const ls = getLocalStorage();
      if (!ls) return null;
      return ls.getItem(prefix + key);
    },
    async set(key: string, value: string): Promise<void> {
      const ls = getLocalStorage();
      if (!ls) return;
      ls.setItem(prefix + key, value);
    },
    async remove(key: string): Promise<void> {
      const ls = getLocalStorage();
      if (!ls) return;
      ls.removeItem(prefix + key);
    },
  };
}

/**
 * Subscribes to the store and writes a debounced serialized snapshot to the
 * adapter after each commit. Returns an unsubscribe function that also
 * cancels any pending debounced write.
 */
export function autoPersist(
  store: SceneStore,
  adapter: StorageAdapter,
  key: string,
  debounceMs = 250,
  maxWaitMs = 1000,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt: number | undefined;

  const flush = (): void => {
    timer = undefined;
    firstPendingAt = undefined;
    void adapter.set(key, store.serialize());
  };

  // Debounce, but never wait longer than maxWaitMs: the store can commit every
  // frame (previews, surface updates) and a pure debounce would never settle.
  const unsubscribe = store.subscribe(() => {
    const now = Date.now();
    if (firstPendingAt === undefined) firstPendingAt = now;
    if (timer !== undefined) clearTimeout(timer);
    const remainingMax = Math.max(0, firstPendingAt + maxWaitMs - now);
    timer = setTimeout(flush, Math.min(debounceMs, remainingMax));
  });

  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    unsubscribe();
  };
}

/** Loads a previously persisted blob into the store. Returns false if none existed or it was rejected. */
export async function restore(store: SceneStore, adapter: StorageAdapter, key: string): Promise<boolean> {
  const blob = await adapter.get(key);
  if (blob === null) return false;
  return store.hydrate(blob);
}
