/**
 * Storage adapters for the scene store plus a small auto-persist helper.
 * Pure TS: the localStorage adapter degrades to a no-op when localStorage
 * is unavailable (SSR, some test environments).
 */
import type { StorageAdapter } from './api';
import type { SceneStore } from './api';
import type { SceneSnapshot } from './types';

/** Transforms every snapshot embedded in a serialized store blob (current + undo/redo history). */
export type BlobTransform = (snapshot: SceneSnapshot) => SceneSnapshot;

interface PersistedBlob {
  snapshot: SceneSnapshot;
  undo: SceneSnapshot[];
  redo: SceneSnapshot[];
}

/**
 * Applies `transform` to every snapshot in a serialized store blob. Never
 * throws: if the blob isn't the shape `store.serialize()`/`store.hydrate()`
 * expect, the original blob is returned untouched (store.hydrate() has its
 * own validation and will simply reject it, same as today).
 */
function transformBlob(blob: string, transform: BlobTransform): string {
  try {
    const parsed = JSON.parse(blob) as Partial<PersistedBlob>;
    if (!parsed || typeof parsed !== 'object' || !parsed.snapshot) return blob;
    const undo = Array.isArray(parsed.undo) ? parsed.undo.map(transform) : [];
    const redo = Array.isArray(parsed.redo) ? parsed.redo.map(transform) : [];
    return JSON.stringify({ snapshot: transform(parsed.snapshot), undo, redo });
  } catch {
    return blob;
  }
}

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
export interface AutoPersistOptions {
  /**
   * Applied to every snapshot (current + undo/redo history) right before it
   * is written to storage - e.g. world space -> anchor-relative space, so the
   * persisted blob is stable across sessions/relocalizations (see
   * src/xr/anchors.ts). Omit, or have it return its input unchanged, to keep
   * the current identity behaviour.
   */
  transform?: BlobTransform;
}

export function autoPersist(
  store: SceneStore,
  adapter: StorageAdapter,
  key: string,
  debounceMs = 250,
  maxWaitMs = 1000,
  options: AutoPersistOptions = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt: number | undefined;

  const flush = (): void => {
    timer = undefined;
    firstPendingAt = undefined;
    const raw = store.serialize();
    const blob = options.transform ? transformBlob(raw, options.transform) : raw;
    void adapter.set(key, blob);
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

/**
 * Loads a previously persisted blob into the store. Returns false if none
 * existed or it was rejected. `transform`, when given, converts every
 * snapshot in the blob (e.g. anchor-relative space -> current world space)
 * before handing it to `store.hydrate()`.
 */
export async function restore(
  store: SceneStore,
  adapter: StorageAdapter,
  key: string,
  transform?: BlobTransform,
): Promise<boolean> {
  const blob = await adapter.get(key);
  if (blob === null) return false;
  return store.hydrate(transform ? transformBlob(blob, transform) : blob);
}
