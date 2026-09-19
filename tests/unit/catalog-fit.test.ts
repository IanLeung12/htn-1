import { describe, expect, it } from 'vitest';
import { fitProxiesToBounds } from '@/app/catalog-fit';
import { makeObject } from '@/core/fixtures';

describe('fitProxiesToBounds', () => {
  it('recomputes all three proxies as boxes sized from the bounds half-extents', () => {
    const obj = makeObject({
      interactionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
      collisionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
      occlusionProxy: { kind: 'box', halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    });
    const bounds = { min: { x: -0.3, y: 0, z: -0.2 }, max: { x: 0.3, y: 0.8, z: 0.2 } };

    const fitted = fitProxiesToBounds(obj, bounds);

    expect(fitted.interactionProxy).toEqual({ kind: 'box', halfExtents: { x: 0.3, y: 0.4, z: 0.2 } });
    expect(fitted.collisionProxy).toEqual(fitted.interactionProxy);
    expect(fitted.occlusionProxy).toEqual(fitted.interactionProxy);
  });

  it('does not mutate the input object', () => {
    const obj = makeObject();
    const original = JSON.parse(JSON.stringify(obj.interactionProxy));
    fitProxiesToBounds(obj, { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } });
    expect(obj.interactionProxy).toEqual(original);
  });

  it('clamps degenerate (zero-thickness) bounds to a minimum half-extent', () => {
    const obj = makeObject();
    const fitted = fitProxiesToBounds(obj, { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 1, z: 0 } });
    const box = fitted.interactionProxy as { kind: 'box'; halfExtents: { x: number; y: number; z: number } };
    expect(box.halfExtents.x).toBeGreaterThan(0);
    expect(box.halfExtents.z).toBeGreaterThan(0);
    expect(box.halfExtents.y).toBeCloseTo(0.5, 6);
  });

  it('produces independent proxy objects (mutating one does not affect the others)', () => {
    const obj = makeObject();
    const fitted = fitProxiesToBounds(obj, { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } });
    (fitted.interactionProxy as { halfExtents: { x: number } }).halfExtents.x = 42;
    expect((fitted.collisionProxy as { halfExtents: { x: number } }).halfExtents.x).not.toBe(42);
  });
});
