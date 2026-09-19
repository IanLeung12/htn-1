import { describe, expect, it } from 'vitest';
import {
  aabbContains,
  aabbExpand,
  aabbFromCenterHalfExtents,
  aabbIntersects,
  add,
  distance,
  fromAnchorSpace,
  length,
  normalize,
  pointInEnvelope,
  poseCompose,
  poseInverse,
  quatFromAxisAngle,
  quatMultiply,
  quatRotateVec3,
  quatSlerp,
  scale,
  sub,
  toAnchorSpace,
} from '@/core/math';
import type { Pose } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';

describe('vec3', () => {
  it('add/sub/scale', () => {
    expect(add({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })).toEqual({ x: 5, y: 7, z: 9 });
    expect(sub({ x: 4, y: 5, z: 6 }, { x: 1, y: 2, z: 3 })).toEqual({ x: 3, y: 3, z: 3 });
    expect(scale({ x: 1, y: 2, z: 3 }, 2)).toEqual({ x: 2, y: 4, z: 6 });
  });

  it('length/distance', () => {
    expect(length({ x: 3, y: 4, z: 0 })).toBeCloseTo(5);
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBeCloseTo(5);
  });

  it('normalize', () => {
    const n = normalize({ x: 3, y: 4, z: 0 });
    expect(length(n)).toBeCloseTo(1);
    expect(normalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('quat', () => {
  it('multiply with identity is a no-op', () => {
    const q = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const r = quatMultiply(q, IDENTITY_QUAT);
    expect(r.x).toBeCloseTo(q.x);
    expect(r.y).toBeCloseTo(q.y);
    expect(r.z).toBeCloseTo(q.z);
    expect(r.w).toBeCloseTo(q.w);
  });

  it('rotates a vector 90deg around Y: +Z -> +X', () => {
    const q = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const v = quatRotateVec3(q, { x: 0, y: 0, z: 1 });
    expect(v.x).toBeCloseTo(1, 5);
    expect(v.y).toBeCloseTo(0, 5);
    expect(v.z).toBeCloseTo(0, 5);
  });

  it('slerp at t=0 and t=1 returns endpoints, t=0.5 is halfway', () => {
    const a = IDENTITY_QUAT;
    const b = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const at0 = quatSlerp(a, b, 0);
    const at1 = quatSlerp(a, b, 1);
    expect(at0.w).toBeCloseTo(a.w);
    expect(at1.w).toBeCloseTo(b.w, 5);

    const half = quatSlerp(a, b, 0.5);
    const expectedHalf = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4);
    expect(half.w).toBeCloseTo(expectedHalf.w, 5);
    expect(half.y).toBeCloseTo(expectedHalf.y, 5);
  });
});

describe('pose', () => {
  it('compose then inverse returns identity-ish pose', () => {
    const a = { position: { x: 1, y: 2, z: 3 }, rotation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.7) };
    const b = { position: { x: -1, y: 0.5, z: 2 }, rotation: quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 0.3) };
    const composed = poseCompose(a, b);
    const back = poseCompose(composed, poseInverse(b));
    expect(back.position.x).toBeCloseTo(a.position.x, 5);
    expect(back.position.y).toBeCloseTo(a.position.y, 5);
    expect(back.position.z).toBeCloseTo(a.position.z, 5);
    expect(back.rotation.w).toBeCloseTo(a.rotation.w, 5);
  });
});

describe('aabb', () => {
  const box = aabbFromCenterHalfExtents({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });

  it('fromCenterHalfExtents', () => {
    expect(box).toEqual({ min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } });
  });

  it('contains', () => {
    expect(aabbContains(box, { x: 0, y: 0, z: 0 })).toBe(true);
    expect(aabbContains(box, { x: 1, y: 1, z: 1 })).toBe(true);
    expect(aabbContains(box, { x: 1.1, y: 0, z: 0 })).toBe(false);
  });

  it('intersects', () => {
    const other = aabbFromCenterHalfExtents({ x: 1.5, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(aabbIntersects(box, other)).toBe(true);
    const far = aabbFromCenterHalfExtents({ x: 10, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(aabbIntersects(box, far)).toBe(false);
  });

  it('expand', () => {
    const grown = aabbExpand(box, 0.5);
    expect(grown).toEqual({ min: { x: -1.5, y: -1.5, z: -1.5 }, max: { x: 1.5, y: 1.5, z: 1.5 } });
  });
});

describe('pointInEnvelope', () => {
  const envelope = { center: { x: 0, y: 0, z: 0 }, radius: 2, maxAngle: Math.PI / 4 };

  it('true when inside radius and facing the center', () => {
    // Forward is local -Z; standing at +Z facing identity already looks toward the origin.
    const headPose = { position: { x: 0, y: 0, z: 1 }, rotation: IDENTITY_QUAT };
    expect(pointInEnvelope(headPose, envelope)).toBe(true);
  });

  it('false when outside the radius', () => {
    const headPose = { position: { x: 0, y: 0, z: 10 }, rotation: IDENTITY_QUAT };
    expect(pointInEnvelope(headPose, envelope)).toBe(false);
  });

  it('false when facing away beyond maxAngle', () => {
    // 180deg turn around Y flips forward to +Z, away from the origin.
    const headPose = { position: { x: 0, y: 0, z: 1 }, rotation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI) };
    expect(pointInEnvelope(headPose, envelope)).toBe(false);
  });
});

describe('toAnchorSpace / fromAnchorSpace', () => {
  const anchorPose: Pose = {
    position: { x: 1, y: 0, z: 2 },
    rotation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2),
  };

  it('round trips an arbitrary pose through anchor space and back', () => {
    const worldPose: Pose = {
      position: { x: 3, y: 1.5, z: -1 },
      rotation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.4),
    };
    const relative = toAnchorSpace(worldPose, anchorPose);
    const roundTripped = fromAnchorSpace(relative, anchorPose);
    expect(roundTripped.position.x).toBeCloseTo(worldPose.position.x, 6);
    expect(roundTripped.position.y).toBeCloseTo(worldPose.position.y, 6);
    expect(roundTripped.position.z).toBeCloseTo(worldPose.position.z, 6);
    expect(roundTripped.rotation.x).toBeCloseTo(worldPose.rotation.x, 6);
    expect(roundTripped.rotation.y).toBeCloseTo(worldPose.rotation.y, 6);
    expect(roundTripped.rotation.z).toBeCloseTo(worldPose.rotation.z, 6);
    expect(roundTripped.rotation.w).toBeCloseTo(worldPose.rotation.w, 6);
  });

  it('a pose expressed in world space at the anchor itself is identity in anchor space', () => {
    const relative = toAnchorSpace(anchorPose, anchorPose);
    expect(relative.position.x).toBeCloseTo(0, 6);
    expect(relative.position.y).toBeCloseTo(0, 6);
    expect(relative.position.z).toBeCloseTo(0, 6);
    expect(relative.rotation.w).toBeCloseTo(1, 6);
  });

  it('a 90 degree yawed anchor rotates a point 1m in front of it to the side in world space', () => {
    // Anchor sits at (1,0,2) yawed 90 degrees about Y. A point 1m along the
    // anchor's local -Z (straight "ahead" of the anchor) should land 1m along
    // world -X once expressed in world space, not 1m along world -Z.
    const relativePose: Pose = { position: { x: 0, y: 0, z: -1 }, rotation: IDENTITY_QUAT };
    const worldPose = fromAnchorSpace(relativePose, anchorPose);
    expect(worldPose.position.x).toBeCloseTo(0, 6); // 1 - 1
    expect(worldPose.position.y).toBeCloseTo(0, 6);
    expect(worldPose.position.z).toBeCloseTo(2, 6);
  });
});
