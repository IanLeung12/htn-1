/**
 * Versioned scene store. Snapshots are immutable; every commit (including
 * undo/redo) produces a new snapshot with version+1 so renderers never mix
 * objects from two versions.
 */
import type { EditAction, IntentEnvelope, ResolveResult, SceneSnapshot } from './types';
import type { SceneStore, TransactionResolver, Unsubscribe } from './api';
import { createResolver } from './resolver';

export interface SceneStoreOptions {
  resolver?: TransactionResolver;
  maxHistory?: number;
}

const UNDOABLE_ACTIONS = new Set<EditAction>(['move', 'rotate', 'scale', 'delete', 'restore', 'replace', 'spawn']);

function isUndoableIntent(kind: string): boolean {
  return UNDOABLE_ACTIONS.has(kind as EditAction);
}

function emptySnapshot(): SceneSnapshot {
  return {
    version: 0,
    committedAt: 0,
    mode: 'live-overlay',
    objects: {},
    surfaces: {},
    regions: {},
  };
}

function isValidSnapshotShape(value: unknown): value is SceneSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'number') return false;
  if (typeof v.objects !== 'object' || v.objects === null || Array.isArray(v.objects)) return false;
  if (typeof v.surfaces !== 'object' || v.surfaces === null || Array.isArray(v.surfaces)) return false;
  if (typeof v.regions !== 'object' || v.regions === null || Array.isArray(v.regions)) return false;
  return true;
}

export function createSceneStore(initial?: Partial<SceneSnapshot>, opts?: SceneStoreOptions): SceneStore {
  const resolver = opts?.resolver ?? createResolver();
  const maxHistory = opts?.maxHistory ?? 100;

  let current: SceneSnapshot = { ...emptySnapshot(), ...initial };
  let undoStack: SceneSnapshot[] = [];
  let redoStack: SceneSnapshot[] = [];

  const listeners = new Set<(snapshot: SceneSnapshot, applied: IntentEnvelope | null) => void>();

  function notify(applied: IntentEnvelope | null): void {
    for (const listener of listeners) listener(current, applied);
  }

  function pushUndo(snapshot: SceneSnapshot): void {
    undoStack.push(snapshot);
    if (undoStack.length > maxHistory) undoStack.shift();
  }

  function pushRedo(snapshot: SceneSnapshot): void {
    redoStack.push(snapshot);
    if (redoStack.length > maxHistory) redoStack.shift();
  }

  return {
    get current(): SceneSnapshot {
      return current;
    },

    dispatch(envelope: IntentEnvelope, conditions): ResolveResult {
      const { intent } = envelope;

      if (intent.kind === 'undo') {
        if (undoStack.length === 0) {
          return { ok: false, reason: 'nothing_to_undo', explanation: 'There is nothing to undo.', intent };
        }
        const previous = undoStack.pop() as SceneSnapshot;
        pushRedo(current);
        current = { ...previous, version: current.version + 1, committedAt: conditions.now };
        notify(envelope);
        return { ok: true, snapshot: current, applied: intent };
      }

      if (intent.kind === 'redo') {
        if (redoStack.length === 0) {
          return { ok: false, reason: 'nothing_to_redo', explanation: 'There is nothing to redo.', intent };
        }
        const next = redoStack.pop() as SceneSnapshot;
        pushUndo(current);
        current = { ...next, version: current.version + 1, committedAt: conditions.now };
        notify(envelope);
        return { ok: true, snapshot: current, applied: intent };
      }

      const result = resolver.resolve(current, envelope, conditions);
      if (result.ok) {
        if (isUndoableIntent(intent.kind)) {
          pushUndo(current);
          redoStack = [];
        }
        current = result.snapshot;
        notify(envelope);
      }
      return result;
    },

    subscribe(listener): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    canUndo(): boolean {
      return undoStack.length > 0;
    },

    canRedo(): boolean {
      return redoStack.length > 0;
    },

    serialize(): string {
      return JSON.stringify({ snapshot: current, undo: undoStack, redo: redoStack });
    },

    hydrate(blob: string): boolean {
      let parsed: unknown;
      try {
        parsed = JSON.parse(blob);
      } catch {
        return false;
      }
      if (typeof parsed !== 'object' || parsed === null) return false;
      const p = parsed as Record<string, unknown>;
      if (!isValidSnapshotShape(p.snapshot)) return false;
      const undo = Array.isArray(p.undo) ? p.undo.filter(isValidSnapshotShape) : [];
      const redo = Array.isArray(p.redo) ? p.redo.filter(isValidSnapshotShape) : [];
      if (Array.isArray(p.undo) && undo.length !== p.undo.length) return false;
      if (Array.isArray(p.redo) && redo.length !== p.redo.length) return false;

      current = p.snapshot;
      undoStack = undo;
      redoStack = redo;
      notify(null);
      return true;
    },
  };
}

export default createSceneStore;
