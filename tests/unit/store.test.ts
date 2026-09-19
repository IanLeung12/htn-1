import { describe, expect, it } from 'vitest';
import { createSceneStore } from '@/core/store';
import { makeConditions, makeObject } from '@/core/fixtures';
import type { IntentEnvelope } from '@/core/types';

function env(intent: IntentEnvelope['intent'], basedOnVersion = 0): IntentEnvelope {
  return { intent, source: 'test', issuedAt: 0, basedOnVersion };
}

describe('createSceneStore', () => {
  it('dispatch commits, bumps version, and notifies subscribers', () => {
    const object = makeObject({ id: 'o1' });
    const store = createSceneStore({ version: 1, objects: { o1: object } });
    const seen: number[] = [];
    store.subscribe((snapshot) => seen.push(snapshot.version));

    const result = store.dispatch(env({ kind: 'delete', objectId: 'o1' }, 1), makeConditions());
    expect(result.ok).toBe(true);
    expect(store.current.version).toBe(2);
    expect(store.current.objects.o1?.visible).toBe(false);
    expect(seen).toEqual([2]);
  });

  it('does not notify or change state on a rejected dispatch', () => {
    const store = createSceneStore();
    let notified = false;
    store.subscribe(() => (notified = true));
    const result = store.dispatch(env({ kind: 'move', objectId: 'ghost', pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } }), makeConditions());
    expect(result.ok).toBe(false);
    expect(notified).toBe(false);
    expect(store.current.version).toBe(0);
  });

  it('undo/redo semantics: undo restores prior state, redo re-applies it, both bump version', () => {
    const object = makeObject({ id: 'o1' });
    const store = createSceneStore({ version: 1, objects: { o1: object } });

    store.dispatch(env({ kind: 'delete', objectId: 'o1' }, 1), makeConditions());
    expect(store.current.objects.o1?.visible).toBe(false);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);

    const versionAfterDelete = store.current.version;
    const undoResult = store.dispatch({ intent: { kind: 'undo' }, source: 'test', issuedAt: 0, basedOnVersion: versionAfterDelete }, makeConditions());
    expect(undoResult.ok).toBe(true);
    expect(store.current.objects.o1?.visible).toBe(true);
    expect(store.current.version).toBe(versionAfterDelete + 1); // versions always increase
    expect(store.canRedo()).toBe(true);

    const redoResult = store.dispatch({ intent: { kind: 'redo' }, source: 'test', issuedAt: 0, basedOnVersion: store.current.version }, makeConditions());
    expect(redoResult.ok).toBe(true);
    expect(store.current.objects.o1?.visible).toBe(false);
  });

  it('undo with an empty stack returns nothing_to_undo and redo returns nothing_to_redo', () => {
    const store = createSceneStore();
    const undo = store.dispatch({ intent: { kind: 'undo' }, source: 'test', issuedAt: 0, basedOnVersion: 0 }, makeConditions());
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.reason).toBe('nothing_to_undo');

    const redo = store.dispatch({ intent: { kind: 'redo' }, source: 'test', issuedAt: 0, basedOnVersion: 0 }, makeConditions());
    expect(redo.ok).toBe(false);
    if (!redo.ok) expect(redo.reason).toBe('nothing_to_redo');
  });

  it('a new undoable action clears the redo stack', () => {
    const objectA = makeObject({ id: 'a' });
    const objectB = makeObject({ id: 'b' });
    const store = createSceneStore({ version: 1, objects: { a: objectA, b: objectB } });

    store.dispatch(env({ kind: 'delete', objectId: 'a' }, 1), makeConditions());
    store.dispatch({ intent: { kind: 'undo' }, source: 'test', issuedAt: 0, basedOnVersion: store.current.version }, makeConditions());
    expect(store.canRedo()).toBe(true);

    store.dispatch(env({ kind: 'delete', objectId: 'b' }, store.current.version), makeConditions());
    expect(store.canRedo()).toBe(false);
  });

  it('non-undoable intents (e.g. approve, setMode) are not pushed onto the undo stack', () => {
    const object = makeObject({ id: 'o1', approved: false });
    const store = createSceneStore({ version: 1, objects: { o1: object } });
    store.dispatch(env({ kind: 'approve', objectId: 'o1', approved: true }, 1), makeConditions());
    expect(store.canUndo()).toBe(false);
  });

  it('caps undo history at maxHistory', () => {
    const object = makeObject({ id: 'o1' });
    const store = createSceneStore({ version: 1, objects: { o1: object } }, { maxHistory: 2 });
    // Alternate move commits to keep pushing undoable history.
    for (let i = 0; i < 5; i++) {
      store.dispatch(env({ kind: 'rotate', objectId: 'o1', rotation: { x: 0, y: 0, z: 0, w: 1 } }, store.current.version), makeConditions());
    }
    let undoCount = 0;
    while (store.canUndo()) {
      store.dispatch({ intent: { kind: 'undo' }, source: 'test', issuedAt: 0, basedOnVersion: store.current.version }, makeConditions());
      undoCount++;
      if (undoCount > 10) break; // safety net against infinite loop on a bug
    }
    expect(undoCount).toBe(2);
  });

  it('serialize/hydrate round trip preserves snapshot and history', () => {
    const object = makeObject({ id: 'o1' });
    const store = createSceneStore({ version: 1, objects: { o1: object } });
    store.dispatch(env({ kind: 'delete', objectId: 'o1' }, 1), makeConditions());

    const blob = store.serialize();

    const store2 = createSceneStore();
    const ok = store2.hydrate(blob);
    expect(ok).toBe(true);
    expect(store2.current.version).toBe(store.current.version);
    expect(store2.current.objects.o1?.visible).toBe(false);
    expect(store2.canUndo()).toBe(true);
  });

  it('hydrate rejects garbage and leaves the store unchanged', () => {
    const store = createSceneStore({ version: 1 });
    expect(store.hydrate('not json')).toBe(false);
    expect(store.hydrate('{}')).toBe(false);
    expect(store.hydrate(JSON.stringify({ snapshot: { version: 'nope', objects: {} } }))).toBe(false);
    expect(store.current.version).toBe(1);
  });
});
