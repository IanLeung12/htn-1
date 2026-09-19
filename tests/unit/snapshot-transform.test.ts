import { describe, expect, it } from 'vitest';
import { fromAnchorSpace, quatFromAxisAngle, toAnchorSpace } from '@/core/math';
import { transformSnapshotPoses } from '@/core/snapshot-transform';
import { makeObject, makePlate, makeSnapshot, makeSurface } from '@/core/fixtures';
import type { Pose } from '@/core/types';
import { IDENTITY_QUAT } from '@/core/types';

describe('transformSnapshotPoses', () => {
  const anchorPose: Pose = {
    position: { x: 2, y: 0, z: -1 },
    rotation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2),
  };

  it('round trips every pose/point in a snapshot through anchor space and back', () => {
    const object = makeObject({
      id: 'o1',
      originalPose: { position: { x: 1, y: 0.5, z: 3 }, rotation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.2) },
      currentPose: { position: { x: 1.5, y: 0.5, z: 3.2 }, rotation: { ...IDENTITY_QUAT } },
      background: [makePlate({ region: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0.1, z: 1 } } })],
    });
    const surface = makeSurface({ id: 's1' });
    const snapshot = makeSnapshot({ objects: { o1: object }, surfaces: { s1: surface } });

    const toAnchor = transformSnapshotPoses(snapshot, (p) => toAnchorSpace(p, anchorPose));
    const backToWorld = transformSnapshotPoses(toAnchor, (p) => fromAnchorSpace(p, anchorPose));

    const orig = snapshot.objects.o1!;
    const restored = backToWorld.objects.o1!;
    expect(restored.originalPose.position.x).toBeCloseTo(orig.originalPose.position.x, 5);
    expect(restored.originalPose.position.z).toBeCloseTo(orig.originalPose.position.z, 5);
    expect(restored.currentPose.position.x).toBeCloseTo(orig.currentPose.position.x, 5);
    expect(restored.currentPose.rotation.w).toBeCloseTo(orig.currentPose.rotation.w, 5);
    expect(restored.background[0]!.region.min.x).toBeCloseTo(orig.background[0]!.region.min.x, 5);
    expect(restored.background[0]!.region.max.z).toBeCloseTo(orig.background[0]!.region.max.z, 5);
    expect(restored.envelope.center.x).toBeCloseTo(orig.envelope.center.x, 5);

    const restoredSurface = backToWorld.surfaces.s1!;
    expect(restoredSurface.pose.position.x).toBeCloseTo(surface.pose.position.x, 5);
    expect(restoredSurface.aabb.min.x).toBeCloseTo(surface.aabb.min.x, 5);
    expect(restoredSurface.aabb.max.z).toBeCloseTo(surface.aabb.max.z, 5);
  });

  it('a 90 degree yawed anchor moves an object pose to the corresponding world position', () => {
    const object = makeObject({
      id: 'o1',
      originalPose: { position: { x: 0, y: 0, z: -1 }, rotation: { ...IDENTITY_QUAT } },
      currentPose: { position: { x: 0, y: 0, z: -1 }, rotation: { ...IDENTITY_QUAT } },
    });
    const snapshot = makeSnapshot({ objects: { o1: object } });

    // Object pose (0,0,-1) is expressed relative to the anchor ("1m ahead of the
    // anchor"); converting to world space with a 90deg-yawed anchor at (2,0,-1)
    // should land it 1m to the anchor's local -X in world space: (1,0,-1).
    const world = transformSnapshotPoses(snapshot, (p) => fromAnchorSpace(p, anchorPose));
    expect(world.objects.o1!.currentPose.position.x).toBeCloseTo(1, 5);
    expect(world.objects.o1!.currentPose.position.y).toBeCloseTo(0, 5);
    expect(world.objects.o1!.currentPose.position.z).toBeCloseTo(-1, 5);
  });

  it('does not mutate the input snapshot', () => {
    const object = makeObject({ id: 'o1' });
    const snapshot = makeSnapshot({ objects: { o1: object } });
    const before = JSON.stringify(snapshot);
    transformSnapshotPoses(snapshot, (p) => toAnchorSpace(p, anchorPose));
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});
