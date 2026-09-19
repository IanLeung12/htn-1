/**
 * Shared Playwright fixture for Reality Editor e2e specs.
 *
 * Every spec starts from `/sim.html?headless=1&autoenter=1&env=...`, which:
 *  1. installs the IWER runtime + SEM + the Reality Editor app (src/sim/entry.ts),
 *  2. calls `AppHandle.enterAR()` automatically (no user gesture needed under emulation -
 *     see src/sim/bootstrap.ts header comment on `XRSystem.requestSession`),
 *  3. exposes `window.__realityEditor` (the app) and `window.__sim` (the simulator).
 *
 * `test-helpers` (installed into the page after both are ready) gives specs a way to
 * dispatch intents and spawn test objects without reimplementing `RuntimeConditions`
 * construction in every spec.
 */
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AppHandle } from '@/app/contract';
import type { SimHandle } from '@/sim/types';
import type { EditableObject, Intent, IntentSource, Pose, ResolveResult, RuntimeConditions } from '@/core/types';

declare global {
  interface Window {
    __realityEditor?: AppHandle;
    __sim?: SimHandle;
    __testHelpers?: TestHelpers;
  }
}

export interface TestHelpers {
  conditions(overrides?: Partial<RuntimeConditions>): RuntimeConditions;
  dispatchIntent(intent: Intent, source?: IntentSource): ResolveResult;
  spawnTestObject(pose: Pose, overrides?: Partial<EditableObject>): string;
}

/** Installed into the page (as a function body, not a closure) once __sim/__realityEditor exist. */
function installTestHelpers(): void {
  function conditions(overrides?: Partial<RuntimeConditions>): RuntimeConditions {
    const dev = window.__sim!.xrDevice;
    const base: RuntimeConditions = {
      now: performance.now(),
      headPose: {
        position: { x: dev.position.x, y: dev.position.y, z: dev.position.z },
        rotation: { x: dev.quaternion.x, y: dev.quaternion.y, z: dev.quaternion.z, w: dev.quaternion.w },
      },
      trackingOk: true,
      localizedAnchors: new Set(),
      depthAgeMs: 0,
      tier: window.__realityEditor!.quality.decision.tier,
    };
    return { ...base, ...overrides };
  }

  function dispatchIntent(intent: Intent, source: IntentSource = 'test'): ResolveResult {
    const store = window.__realityEditor!.store;
    return store.dispatch({ intent, source, issuedAt: performance.now(), basedOnVersion: store.current.version }, conditions());
  }

  function spawnTestObject(pose: Pose, overrides: Partial<EditableObject> = {}): string {
    const id = (overrides.id as string | undefined) ?? `test-spawn-${Math.random().toString(36).slice(2)}`;
    const object: EditableObject = {
      id,
      label: 'other',
      userName: 'Test Cube',
      origin: 'spawned',
      originalPose: pose,
      currentPose: pose,
      visual: { kind: 'primitive', color: 0x66aaff },
      interactionProxy: { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
      collisionProxy: { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
      occlusionProxy: { kind: 'box', halfExtents: { x: 0.08, y: 0.08, z: 0.08 } },
      supportSurfaces: [],
      background: [],
      provenance: { method: 'spawned', capturedAt: Date.now(), capturePath: [pose] },
      tier: 'A',
      tierConfidence: 1,
      envelope: { center: pose.position, radius: 3, maxAngle: Math.PI },
      physical: { massKg: 0.3, friction: 0.5, restitution: 0.2, kinematic: false },
      approved: true,
      visible: true,
      ...overrides,
    };
    object.id = id;
    dispatchIntent({ kind: 'spawn', object });
    return id;
  }

  window.__testHelpers = { conditions, dispatchIntent, spawnTestObject };
}

export interface RealityEditorFixtures {
  simPage: Page;
  /** `page.evaluate` bound to `simPage` - supports the zero-arg and single-arg overloads. */
  evalApp: Page['evaluate'];
}

/** Query string for the simulator page; override per-spec via `simUrl`. */
export function simUrl(params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ headless: '1', autoenter: '1', env: 'living_room', ...params });
  return `/sim.html?${search.toString()}`;
}

export const test = base.extend<RealityEditorFixtures>({
  simPage: async ({ page }, use, testInfo) => {
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(`pageerror: ${err.message}\n${err.stack ?? ''}`);
    });

    await page.goto(simUrl());
    await page.waitForFunction(() => Boolean(window.__realityEditor && window.__sim), { timeout: 30_000 });
    await page.evaluate(installTestHelpers);

    await use(page);

    if (testInfo.status !== 'passed') {
      await page
        .screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true })
        .catch(() => {
          /* best-effort only */
        });
    }
    if (pageErrors.length > 0) {
      await testInfo.attach('page-errors', { body: pageErrors.join('\n---\n'), contentType: 'text/plain' });
      if (testInfo.status === 'passed') {
        throw new Error(`Uncaught console/page errors during test:\n${pageErrors.join('\n')}`);
      }
    }
  },

  evalApp: async ({ simPage }, use) => {
    await use(simPage.evaluate.bind(simPage));
  },
});

export { expect };
