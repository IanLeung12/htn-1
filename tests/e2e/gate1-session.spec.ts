/**
 * Gate A (standalone reality): passthrough, hands, tracking, and a reachable
 * safety-tier all work for a sustained run - see reality-editor-research-ledger.md
 * "Go / no-go gates" > Gate A.
 */
import { test, expect } from './fixtures';

test('immersive-ar session starts with alpha-blend passthrough and hand input', async ({ evalApp }) => {
  const features = await evalApp(() => window.__realityEditor!.features);
  expect(features).not.toBeNull();
  expect(features!.supported).toBe(true);
  expect(features!.blendMode).toBe('alpha-blend');

  const inputMode = await evalApp(() => window.__sim!.xrDevice.primaryInputMode);
  expect(inputMode).toBe('hand');
});

test('quality tier is reachable and can be forced (safety fallback path)', async ({ evalApp }) => {
  const initialTier = await evalApp(() => window.__realityEditor!.quality.decision.tier);
  expect([0, 1, 2]).toContain(initialTier);

  const forcedZero = await evalApp(() => window.__realityEditor!.quality.force(0, 'manual').tier);
  expect(forcedZero).toBe(0);

  const restored = await evalApp(() => window.__realityEditor!.quality.force(null).tier);
  expect([0, 1, 2]).toContain(restored);
});

test('renders at least 120 frames with no uncaught exceptions', async ({ evalApp }) => {
  await expect
    .poll(async () => evalApp(() => window.__realityEditor!.perf.stats('frameMs').count), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(120);

  const frameStats = await evalApp(() => window.__sim!.frameStats());
  expect(frameStats.errors).toEqual([]);
});
