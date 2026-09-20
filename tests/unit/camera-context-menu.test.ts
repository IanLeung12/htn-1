import { describe, expect, it } from 'vitest';
import { makeObject } from '@/core/fixtures';
import { menuItemsFor, type ContextMenuActions } from '@/camera/context-menu';

function actions(log: string[]): ContextMenuActions {
  return {
    move: (id) => log.push(`move:${id}`),
    delete: (id) => log.push(`delete:${id}`),
    restore: (id) => log.push(`restore:${id}`),
    capturePlate: (id) => log.push(`plate:${id}`),
    undo: () => log.push('undo'),
  };
}

describe('context menu items', () => {
  it('a tier-B real object gets Move, Delete, Capture plate, Undo', () => {
    const log: string[] = [];
    const obj = makeObject({ id: 'can', origin: 'physical', tier: 'B', visible: true });
    const items = menuItemsFor(obj, actions(log));
    expect(items.map((i) => i.label)).toEqual(['Move', 'Delete', 'Capture plate', 'Undo']);
    expect(items.every((i) => !i.disabledReason)).toBe(true);
    items[1]!.action();
    expect(log).toEqual(['delete:can']);
  });

  it('a tier-D real object has Delete greyed out with the plate explanation', () => {
    const obj = makeObject({ id: 'can', origin: 'physical', tier: 'D', visible: true });
    const items = menuItemsFor(obj, actions([]));
    expect(items.find((i) => i.label === 'Delete')?.disabledReason).toMatch(/Capture plate/);
    expect(items.find((i) => i.label === 'Move')?.disabledReason).toBeUndefined();
  });

  it('a deleted object offers Restore and Undo only', () => {
    const obj = makeObject({ id: 'can', origin: 'physical', tier: 'B', visible: false });
    expect(menuItemsFor(obj, actions([])).map((i) => i.label)).toEqual(['Restore', 'Undo']);
  });

  it('a spawned object can always move and delete', () => {
    const obj = makeObject({ id: 'cube', origin: 'spawned', tier: 'A', visible: true });
    expect(menuItemsFor(obj, actions([])).map((i) => i.label)).toEqual(['Move', 'Delete', 'Undo']);
  });
});
