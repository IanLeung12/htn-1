import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle } from '@/core/math';
import type { Vec3 } from '@/core/types';
import { clampTwoHandScale, computeTwoHandDelta, quatAngleDeg, type TwoHandFrame } from '@/app/two-hand';

const Y_AXIS: Vec3 = { x: 0, y: 1, z: 0 };

/** Rotate a vector about world Y by `rad`, matching `quatFromAxisAngle`'s convention. */
function rotateY(v: Vec3, rad: number): Vec3 {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: v.x * cos + v.z * sin, y: v.y, z: -v.x * sin + v.z * cos };
}

describe('computeTwoHandDelta', () => {
  const initial: TwoHandFrame = {
    midpoint: { x: 0, y: 1.2, z: -1 },
    vector: { x: 0.3, y: 0, z: 0 }, // right hand 0.3m to the +x of left hand
  };

  it('pure translation: midpoint moves, hand vector unchanged', () => {
    const current: TwoHandFrame = {
      midpoint: { x: 0.5, y: 1.3, z: -0.8 },
      vector: { x: 0.3, y: 0, z: 0 },
    };
    const delta = computeTwoHandDelta(initial, current);
    expect(delta.position.x).toBeCloseTo(0.5);
    expect(delta.position.y).toBeCloseTo(0.1);
    expect(delta.position.z).toBeCloseTo(0.2);
    expect(delta.yawRad).toBeCloseTo(0);
    expect(delta.scale).toBeCloseTo(1);
  });

  it('pure rotation by 90 degrees: midpoint fixed, hand vector rotated', () => {
    const rotatedVector = rotateY(initial.vector, Math.PI / 2);
    const current: TwoHandFrame = { midpoint: { ...initial.midpoint }, vector: rotatedVector };
    const delta = computeTwoHandDelta(initial, current);
    expect(delta.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(delta.yawRad).toBeCloseTo(Math.PI / 2, 5);
    expect(delta.scale).toBeCloseTo(1);
  });

  it('pure scale x2: hand vector doubled in length, same direction', () => {
    const current: TwoHandFrame = {
      midpoint: { ...initial.midpoint },
      vector: { x: initial.vector.x * 2, y: 0, z: 0 },
    };
    const delta = computeTwoHandDelta(initial, current);
    expect(delta.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(delta.yawRad).toBeCloseTo(0);
    expect(delta.scale).toBeCloseTo(2);
  });

  it('combined translate + rotate + scale', () => {
    const rotated = rotateY(initial.vector, Math.PI / 4);
    const scaledRotated = { x: rotated.x * 1.5, y: rotated.y, z: rotated.z * 1.5 };
    const current: TwoHandFrame = {
      midpoint: { x: initial.midpoint.x + 1, y: initial.midpoint.y - 0.2, z: initial.midpoint.z + 0.4 },
      vector: scaledRotated,
    };
    const delta = computeTwoHandDelta(initial, current);
    expect(delta.position.x).toBeCloseTo(1);
    expect(delta.position.y).toBeCloseTo(-0.2);
    expect(delta.position.z).toBeCloseTo(0.4);
    expect(delta.yawRad).toBeCloseTo(Math.PI / 4, 5);
    expect(delta.scale).toBeCloseTo(1.5, 5);
  });

  it('degenerate: hands coincident (initial vector ~0) returns identity', () => {
    const degenerateInitial: TwoHandFrame = { midpoint: { x: 0, y: 1, z: 0 }, vector: { x: 0, y: 0, z: 0 } };
    const current: TwoHandFrame = { midpoint: { x: 1, y: 1, z: 1 }, vector: { x: 0.5, y: 0, z: 0 } };
    const delta = computeTwoHandDelta(degenerateInitial, current);
    expect(delta).toEqual({ position: { x: 0, y: 0, z: 0 }, yawRad: 0, scale: 1 });
  });

  it('degenerate: hands coincident (current vector ~0) returns identity', () => {
    const current: TwoHandFrame = { midpoint: { x: 1, y: 1, z: 1 }, vector: { x: 0, y: 0, z: 0 } };
    const delta = computeTwoHandDelta(initial, current);
    expect(delta).toEqual({ position: { x: 0, y: 0, z: 0 }, yawRad: 0, scale: 1 });
  });
});

describe('clampTwoHandScale', () => {
  it('clamps to [0.25, 4]', () => {
    expect(clampTwoHandScale(0.1)).toBeCloseTo(0.25);
    expect(clampTwoHandScale(10)).toBeCloseTo(4);
    expect(clampTwoHandScale(2)).toBeCloseTo(2);
  });

  it('falls back to 1 for NaN/non-finite input', () => {
    expect(clampTwoHandScale(NaN)).toBe(1);
    expect(clampTwoHandScale(Infinity)).toBe(1);
  });
});

describe('quatAngleDeg', () => {
  it('is 0 for identical quaternions', () => {
    const q = quatFromAxisAngle(Y_AXIS, Math.PI / 3);
    expect(quatAngleDeg(q, q)).toBeCloseTo(0, 4);
  });

  it('reports the rotation angle between two quaternions about the same axis', () => {
    const a = quatFromAxisAngle(Y_AXIS, 0);
    const b = quatFromAxisAngle(Y_AXIS, Math.PI / 2);
    expect(quatAngleDeg(a, b)).toBeCloseTo(90, 3);
  });
});
