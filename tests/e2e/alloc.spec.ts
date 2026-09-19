/**
 * Frame-loop allocation regression guard (see docs/perf-audit.md): samples
 * `performance.memory.usedJSHeapSize` over 300 frames with 8 spawned objects -
 * roughly the "5-10 edited objects" scenario in
 * reality-editor-runtime-budget.md's measurement matrix - after a warm-up, and
 * asserts the heap does not show a runaway per-frame-allocation slope.
 *
 * `performance.memory` is a non-standard Chromium extension, so this spec is
 * Chromium-only and skips itself (rather than failing) when the API is
 * missing. The bound is intentionally generous: it is meant to catch a real
 * per-frame leak (a fresh object/array/closure retained every tick), not to
 * assert a tight memory budget under software-GL/CI noise.
 */
import { test, expect } from './fixtures';

const OBJECT_COUNT = 8;
const WARMUP_FRAMES = 60;
const SAMPLE_FRAMES = 300;
const MAX_GROWTH_MB = 2;

type MemoryPerformance = Performance & { memory?: { usedJSHeapSize: number } };

test('heap growth over 300 frames with 8 objects stays within a generous bound', async ({ evalApp, browserName }) => {
  test.skip(browserName !== 'chromium', 'performance.memory is a Chromium-only extension');

  const hasMemoryApi = await evalApp(() => typeof (performance as MemoryPerformance).memory !== 'undefined');
  test.skip(!hasMemoryApi, 'performance.memory unavailable in this Chromium build');

  for (let i = 0; i < OBJECT_COUNT; i++) {
    const angle = (i / OBJECT_COUNT) * Math.PI * 2;
    const pose = {
      position: { x: Math.cos(angle) * 0.6, y: 1.2, z: -1.5 + Math.sin(angle) * 0.6 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    await evalApp(
      (p) => window.__testHelpers!.spawnTestObject(p, { userName: `Alloc Cube ${p.position.x.toFixed(2)}` }),
      pose,
    );
  }

  const frameCount = (): number => window.__realityEditor!.perf.stats('frameMs').count;
  const readHeap = (): number => (performance as MemoryPerformance).memory!.usedJSHeapSize;

  const startCount = await evalApp(frameCount);

  // Warm-up: let allocation patterns (gltf caches, first-touch object pools, JIT)
  // settle, and let an initial GC pass happen, before the measurement window starts.
  await expect
    .poll(async () => evalApp(frameCount), { timeout: 60_000, intervals: [250] })
    .toBeGreaterThanOrEqual(startCount + WARMUP_FRAMES);

  const countAtWarmup = await evalApp(frameCount);
  const heapAtWarmup = await evalApp(readHeap);

  await expect
    .poll(async () => evalApp(frameCount), { timeout: 120_000, intervals: [250] })
    .toBeGreaterThanOrEqual(countAtWarmup + SAMPLE_FRAMES);

  const heapAfter = await evalApp(readHeap);
  const growthMb = (heapAfter - heapAtWarmup) / (1024 * 1024);

  console.log(
    `[alloc] heap growth over ${SAMPLE_FRAMES} frames with ${OBJECT_COUNT} objects: ${growthMb.toFixed(2)}MB`,
  );

  expect(
    growthMb,
    `heap grew ${growthMb.toFixed(2)}MB over ${SAMPLE_FRAMES} frames (bound ${MAX_GROWTH_MB}MB) - looks like a per-frame allocation is being retained`,
  ).toBeLessThan(MAX_GROWTH_MB);
});
