/**
 * Performance trace: 600 frames with 8 spawned objects, p50/p95/p99 recorded to
 * test-results/perf.json - see reality-editor-research-ledger.md "Measurement
 * protocol" > Performance. Emulated numbers (software GL, shared CI/dev-machine CPU)
 * are indicative only; this does not assert a tight frame-time budget, only that the
 * stack survives the run without a severe hitch.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures';

const OBJECT_COUNT = 8;
const TARGET_FRAMES = 600;
const HITCH_LIMIT_MS = 250;

test('600-frame trace with 8 objects has no severe hitch, and perf stats are recorded', async ({ evalApp }) => {
  for (let i = 0; i < OBJECT_COUNT; i++) {
    const angle = (i / OBJECT_COUNT) * Math.PI * 2;
    const pose = {
      position: { x: Math.cos(angle) * 0.6, y: 1.2, z: -1.5 + Math.sin(angle) * 0.6 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    await evalApp((p) => window.__testHelpers!.spawnTestObject(p, { userName: `Perf Cube ${p.position.x.toFixed(2)}` }), pose);
  }

  const startCount = await evalApp(() => window.__realityEditor!.perf.stats('frameMs').count);
  await expect
    .poll(async () => evalApp(() => window.__realityEditor!.perf.stats('frameMs').count), { timeout: 60_000, intervals: [250] })
    .toBeGreaterThanOrEqual(startCount + TARGET_FRAMES);

  const samples = await evalApp(() => window.__realityEditor!.perf.samples().map((s) => s.frameMs));
  const maxFrameMs = Math.max(...samples.slice(-TARGET_FRAMES));
  const stats = await evalApp(() => window.__realityEditor!.perf.stats('frameMs'));

  const outPath = path.join(process.cwd(), 'test-results', 'perf.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        objectCount: OBJECT_COUNT,
        targetFrames: TARGET_FRAMES,
        stats,
        maxFrameMsInWindow: maxFrameMs,
        note: 'Emulated (software GL) frame timings; indicative only, not representative of on-device Quest 3 performance.',
      },
      null,
      2,
    ),
  );

  console.log(`[perf] p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms max=${stats.max.toFixed(2)}ms count=${stats.count}`);

  expect(maxFrameMs, `a frame in the perf window took ${maxFrameMs.toFixed(1)}ms (> ${HITCH_LIMIT_MS}ms hitch limit)`).toBeLessThan(
    HITCH_LIMIT_MS,
  );
});
