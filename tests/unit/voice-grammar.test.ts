import { describe, expect, it } from 'vitest';
import { parseCommand } from '@/app/voice-grammar';
import { makeObject, makeSnapshot, makeSurface } from '@/core/fixtures';
import { IDENTITY_QUAT, type Pose } from '@/core/types';

const HEAD: Pose = { position: { x: 0, y: 1.5, z: 1 }, rotation: { ...IDENTITY_QUAT } };

function ctx(overrides: Partial<{ selectedId: string }> = {}) {
  return { headPose: HEAD, ...overrides };
}

describe('parseCommand - simple intents', () => {
  it('parses undo/redo', () => {
    expect(parseCommand('undo', makeSnapshot(), ctx())).toEqual({ kind: 'undo' });
    expect(parseCommand('redo', makeSnapshot(), ctx())).toEqual({ kind: 'redo' });
  });

  it('parses spawn commands for cube and sphere with any trigger verb', () => {
    const snapshot = makeSnapshot();
    expect(parseCommand('spawn a cube', snapshot, ctx())).toEqual({ kind: 'spawn', shape: 'cube' });
    expect(parseCommand('add a sphere', snapshot, ctx())).toEqual({ kind: 'spawn', shape: 'sphere' });
    expect(parseCommand('create a cube', snapshot, ctx())).toEqual({ kind: 'spawn', shape: 'cube' });
  });

  it('parses show/hide the room into setMode', () => {
    const snapshot = makeSnapshot();
    expect(parseCommand('show the room', snapshot, ctx())).toEqual({ kind: 'setMode', mode: 'captured-shell' });
    expect(parseCommand('hide the room', snapshot, ctx())).toEqual({ kind: 'setMode', mode: 'live-overlay' });
  });

  it('parses "what can I edit" and "why"', () => {
    const snapshot = makeSnapshot();
    expect(parseCommand('what can I edit', snapshot, ctx())).toEqual({ kind: 'listEditable' });
    expect(parseCommand('why', snapshot, ctx())).toEqual({ kind: 'explainLast' });
  });

  it('is case-insensitive and tolerates punctuation', () => {
    expect(parseCommand('UNDO.', makeSnapshot(), ctx())).toEqual({ kind: 'undo' });
    expect(parseCommand('  Redo  ', makeSnapshot(), ctx())).toEqual({ kind: 'redo' });
  });

  it('returns null for unrecognized text', () => {
    expect(parseCommand('do a backflip', makeSnapshot(), ctx())).toBeNull();
    expect(parseCommand('', makeSnapshot(), ctx())).toBeNull();
  });
});

describe('parseCommand - catalog asset spawning', () => {
  it('resolves "spawn/add/create/put a <catalog name>" to spawnAsset, by name or alias', () => {
    const snapshot = makeSnapshot();
    expect(parseCommand('spawn a chair', snapshot, ctx())).toEqual({ kind: 'spawnAsset', entryId: 'chair', label: 'Chair' });
    expect(parseCommand('add a vase', snapshot, ctx())).toEqual({ kind: 'spawnAsset', entryId: 'vase', label: 'Vase' });
    expect(parseCommand('create a lamp', snapshot, ctx())).toEqual({ kind: 'spawnAsset', entryId: 'lamp', label: 'Lamp' });
    expect(parseCommand('put a wicker basket', snapshot, ctx())).toEqual({ kind: 'spawnAsset', entryId: 'basket', label: 'Basket' });
    // alias, not the canonical name
    expect(parseCommand('spawn a candle holder', snapshot, ctx())).toEqual({ kind: 'spawnAsset', entryId: 'lamp', label: 'Lamp' });
  });

  it('keeps spawning primitives (cube/sphere) working alongside catalog assets', () => {
    const snapshot = makeSnapshot();
    expect(parseCommand('spawn a cube', snapshot, ctx())).toEqual({ kind: 'spawn', shape: 'cube' });
    expect(parseCommand('spawn a sphere', snapshot, ctx())).toEqual({ kind: 'spawn', shape: 'sphere' });
  });

  it('does not hijack "put <existing object> on <surface>" even when the object name matches a catalog entry', () => {
    const table = makeSurface({
      id: 'surface-table',
      label: 'table',
      aabb: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 0.5, z: 1 } },
    });
    const chair = makeObject({ id: 'chair-1', userName: 'Chair' });
    const snapshot = makeSnapshot({ objects: { [chair.id]: chair }, surfaces: { [table.id]: table } });
    const cmd = parseCommand('put the chair on the table', snapshot, ctx());
    expect(cmd?.kind).toBe('placeOn');
  });

  it('returns null for an unrecognized catalog name', () => {
    expect(parseCommand('spawn a spaceship', makeSnapshot(), ctx())).toBeNull();
  });
});

describe('parseCommand - object targeting', () => {
  it('resolves delete/remove/hide by userName, case-insensitively', () => {
    const cube = makeObject({ id: 'cube-1', userName: 'Cube' });
    const snapshot = makeSnapshot({ objects: { [cube.id]: cube } });

    expect(parseCommand('delete the cube', snapshot, ctx())).toEqual({ kind: 'delete', objectId: 'cube-1', label: 'Cube' });
    expect(parseCommand('remove the CUBE', snapshot, ctx())).toEqual({ kind: 'delete', objectId: 'cube-1', label: 'Cube' });
    expect(parseCommand('hide the cube', snapshot, ctx())).toEqual({ kind: 'delete', objectId: 'cube-1', label: 'Cube' });
  });

  it('resolves restore/bring back including hidden objects', () => {
    const lamp = makeObject({ id: 'lamp-1', userName: 'Lamp', visible: false });
    const snapshot = makeSnapshot({ objects: { [lamp.id]: lamp } });

    expect(parseCommand('restore the lamp', snapshot, ctx())).toEqual({ kind: 'restore', objectId: 'lamp-1', label: 'Lamp' });
    expect(parseCommand('bring back the lamp', snapshot, ctx())).toEqual({ kind: 'restore', objectId: 'lamp-1', label: 'Lamp' });
  });

  it('matches by prefix and ignores articles', () => {
    const table = makeObject({ id: 'table-1', userName: 'Coffee Table' });
    const snapshot = makeSnapshot({ objects: { [table.id]: table } });
    expect(parseCommand('delete the coffee', snapshot, ctx())).toEqual({ kind: 'delete', objectId: 'table-1', label: 'Coffee Table' });
  });

  it('matches by semantic label when the name does not match', () => {
    const lamp = makeObject({ id: 'lamp-1', userName: 'Reading Light', label: 'lamp' });
    const snapshot = makeSnapshot({ objects: { [lamp.id]: lamp } });
    expect(parseCommand('delete the lamp', snapshot, ctx())).toEqual({ kind: 'delete', objectId: 'lamp-1', label: 'Reading Light' });
  });

  it('prefers the nearest object to the head when ambiguous', () => {
    const near = makeObject({
      id: 'table-near',
      userName: 'Table',
      currentPose: { position: { x: 0, y: 1.5, z: 1.5 }, rotation: { ...IDENTITY_QUAT } },
    });
    const far = makeObject({
      id: 'table-far',
      userName: 'Table',
      currentPose: { position: { x: 0, y: 1.5, z: 10 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { [near.id]: near, [far.id]: far } });
    expect(parseCommand('delete the table', snapshot, ctx())).toEqual({ kind: 'delete', objectId: 'table-near', label: 'Table' });
  });

  it('supports ordinals to disambiguate ("second table")', () => {
    const near = makeObject({
      id: 'table-near',
      userName: 'Table',
      currentPose: { position: { x: 0, y: 1.5, z: 1.5 }, rotation: { ...IDENTITY_QUAT } },
    });
    const far = makeObject({
      id: 'table-far',
      userName: 'Table',
      currentPose: { position: { x: 0, y: 1.5, z: 10 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { [near.id]: near, [far.id]: far } });
    expect(parseCommand('delete the second table', snapshot, ctx())).toEqual({
      kind: 'delete',
      objectId: 'table-far',
      label: 'Table',
    });
  });

  it('prefers the selected object over the nearest one when both match', () => {
    const near = makeObject({
      id: 'table-near',
      userName: 'Table',
      currentPose: { position: { x: 0, y: 1.5, z: 1.5 }, rotation: { ...IDENTITY_QUAT } },
    });
    const far = makeObject({
      id: 'table-far',
      userName: 'Table',
      currentPose: { position: { x: 0, y: 1.5, z: 10 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { [near.id]: near, [far.id]: far } });
    expect(parseCommand('delete the table', snapshot, ctx({ selectedId: 'table-far' }))).toEqual({
      kind: 'delete',
      objectId: 'table-far',
      label: 'Table',
    });
  });

  it('returns null when the named object cannot be resolved', () => {
    const snapshot = makeSnapshot({ objects: {} });
    expect(parseCommand('delete the cabinet', snapshot, ctx())).toBeNull();
  });

  it('parses select and capture commands', () => {
    const mug = makeObject({ id: 'mug-1', userName: 'Mug' });
    const snapshot = makeSnapshot({ objects: { [mug.id]: mug } });
    expect(parseCommand('select the mug', snapshot, ctx())).toEqual({ kind: 'select', objectId: 'mug-1', label: 'Mug' });
    expect(parseCommand('capture the mug', snapshot, ctx())).toEqual({
      kind: 'captureCleanPlate',
      objectId: 'mug-1',
      label: 'Mug',
    });
  });
});

describe('parseCommand - move', () => {
  it('moves up by an explicit distance in centimeters', () => {
    const cube = makeObject({
      id: 'cube-1',
      userName: 'Cube',
      currentPose: { position: { x: 0, y: 1, z: 0 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { [cube.id]: cube } });
    const cmd = parseCommand('move the cube up 20 cm', snapshot, ctx());
    expect(cmd?.kind).toBe('move');
    if (cmd?.kind !== 'move') throw new Error('expected move command');
    expect(cmd.distanceM).toBeCloseTo(0.2, 6);
    expect(cmd.pose.position).toEqual({ x: 0, y: 1.2, z: 0 });
  });

  it('supports meters and inches', () => {
    const cube = makeObject({
      id: 'cube-1',
      userName: 'Cube',
      currentPose: { position: { x: 0, y: 1, z: 0 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { [cube.id]: cube } });

    const meters = parseCommand('move the cube up 1 meters', snapshot, ctx());
    if (meters?.kind !== 'move') throw new Error('expected move command');
    expect(meters.pose.position.y).toBeCloseTo(2, 6);

    const inches = parseCommand('move the cube up 1 inches', snapshot, ctx());
    if (inches?.kind !== 'move') throw new Error('expected move command');
    expect(inches.pose.position.y).toBeCloseTo(1.0254, 6);
  });

  it('applies a default distance when none is given', () => {
    const cube = makeObject({
      id: 'cube-1',
      userName: 'Cube',
      currentPose: { position: { x: 0, y: 1, z: 0 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { [cube.id]: cube } });
    const cmd = parseCommand('move the cube down', snapshot, ctx());
    if (cmd?.kind !== 'move') throw new Error('expected move command');
    expect(cmd.pose.position.y).toBeCloseTo(0.8, 6);
  });

  it('moves forward/back/left/right relative to the head heading', () => {
    // Head faces -Z (identity rotation forward); "forward" should decrease z.
    const cube = makeObject({
      id: 'cube-1',
      userName: 'Cube',
      currentPose: { position: { x: 0, y: 1, z: 0 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { [cube.id]: cube } });
    const forward = parseCommand('move the cube forward 10 cm', snapshot, ctx());
    if (forward?.kind !== 'move') throw new Error('expected move command');
    expect(forward.pose.position.z).toBeCloseTo(-0.1, 6);

    const right = parseCommand('move the cube right 10 cm', snapshot, ctx());
    if (right?.kind !== 'move') throw new Error('expected move command');
    expect(right.pose.position.x).toBeCloseTo(0.1, 6);
  });
});

describe('parseCommand - placeOn', () => {
  it('places an object on a matching surface, at surface-top height', () => {
    const table = makeSurface({
      id: 'surface-table',
      label: 'table',
      aabb: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 0.5, z: 1 } },
    });
    const mug = makeObject({
      id: 'mug-1',
      userName: 'Mug',
      currentPose: { position: { x: 3, y: 1, z: 3 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { [mug.id]: mug }, surfaces: { [table.id]: table } });

    const cmd = parseCommand('put the mug on the table', snapshot, ctx());
    expect(cmd?.kind).toBe('placeOn');
    if (cmd?.kind !== 'placeOn') throw new Error('expected placeOn command');
    expect(cmd.objectId).toBe('mug-1');
    expect(cmd.surfaceId).toBe('surface-table');
    expect(cmd.pose.position).toEqual({ x: 0, y: 0.5, z: 0 });
  });

  it('returns null when the surface cannot be resolved', () => {
    const mug = makeObject({ id: 'mug-1', userName: 'Mug' });
    const snapshot = makeSnapshot({ objects: { [mug.id]: mug }, surfaces: {} });
    expect(parseCommand('place the mug on the shelf', snapshot, ctx())).toBeNull();
  });
});
