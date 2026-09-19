/**
 * Persistence: with a persistKey, the scene store round-trips through
 * localStorage across a full page reload (fresh XRDevice, fresh app instance).
 * See src/core/persistence.ts (`autoPersist` debounces writes by 250ms).
 */
import { test, expect, simUrl } from './fixtures';

const PERSIST_KEY = 'e2e-persistence-test';

test('a spawned object survives a page reload with the same persistKey', async ({ page }) => {
  await page.goto(simUrl({ persist: PERSIST_KEY }));
  await page.waitForFunction(() => Boolean(window.__realityEditor && window.__sim), { timeout: 30_000 });
  await page.evaluate(() => {
    // Clear out any stale state from a previous failed run using this key.
    localStorage.removeItem(`reality-editor:${'e2e-persistence-test'}`);
  });

  const pose = { position: { x: 0.2, y: 1.3, z: -1.1 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
  const objectId = 'persistence-test-cube';
  await page.evaluate(
    ([p, id]) => {
      const object = {
        id,
        label: 'other' as const,
        userName: 'Persisted Cube',
        origin: 'spawned' as const,
        originalPose: p,
        currentPose: p,
        visual: { kind: 'primitive' as const, color: 0x66aaff },
        interactionProxy: { kind: 'box' as const, halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
        collisionProxy: { kind: 'box' as const, halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
        occlusionProxy: { kind: 'box' as const, halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
        supportSurfaces: [],
        background: [],
        provenance: { method: 'spawned' as const, capturedAt: Date.now(), capturePath: [p] },
        tier: 'A' as const,
        tierConfidence: 1,
        envelope: { center: p.position, radius: 3, maxAngle: Math.PI },
        physical: { massKg: 0.3, friction: 0.5, restitution: 0.2, kinematic: false },
        approved: true,
        visible: true,
      };
      const store = window.__realityEditor!.store;
      return store.dispatch(
        { intent: { kind: 'spawn', object }, source: 'test', issuedAt: performance.now(), basedOnVersion: store.current.version },
        {
          now: performance.now(),
          headPose: p,
          trackingOk: true,
          localizedAnchors: new Set(),
          depthAgeMs: 0,
          tier: window.__realityEditor!.quality.decision.tier,
        },
      );
    },
    [pose, objectId] as const,
  );

  // autoPersist debounces writes by 250ms (src/core/persistence.ts).
  await page.waitForTimeout(600);

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__realityEditor && window.__sim), { timeout: 30_000 });

  const restored = await page.evaluate((id) => window.__realityEditor!.store.current.objects[id], objectId);
  expect(restored, 'object should have been restored from persisted storage after reload').toBeDefined();
  expect(restored!.userName).toBe('Persisted Cube');
  expect(restored!.currentPose.position.x).toBeCloseTo(pose.position.x, 5);

  // Clean up so re-runs of this spec start fresh.
  await page.evaluate(() => localStorage.removeItem(`reality-editor:${'e2e-persistence-test'}`));
});
