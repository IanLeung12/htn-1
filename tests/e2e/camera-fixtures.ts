/**
 * Playwright fixture for the general-camera backend (camera.html).
 *
 * Chromium is launched with a fake media device fed from a synthetic Y4M
 * (tests/e2e/y4m.ts) so the real getUserMedia code path runs headlessly:
 *   --use-fake-ui-for-media-stream      no permission prompt
 *   --use-fake-device-for-media-stream  fake camera instead of hardware
 *   --use-file-for-fake-video-capture   the Y4M to play as that camera
 */
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import type { AppHandle } from '@/app/contract';
import type { CameraHandle } from '@/camera/app';
import type { EditableObject, Intent, IntentSource, Pose, ResolveResult, RuntimeConditions } from '@/core/types';
import { ensureSyntheticY4m } from './y4m';

declare global {
  interface Window {
    __realityEditor?: AppHandle;
    __camera?: CameraHandle;
    __cameraTestHelpers?: CameraTestHelpers;
  }
}

export interface CameraTestHelpers {
  conditions(overrides?: Partial<RuntimeConditions>): RuntimeConditions;
  dispatchIntent(intent: Intent, source?: IntentSource): ResolveResult;
  spawnTestObject(pose: Pose, overrides?: Partial<EditableObject>): string;
}

function installHelpers(): void {
  function conditions(overrides?: Partial<RuntimeConditions>): RuntimeConditions {
    const app = window.__realityEditor!;
    const cam = window.__camera!;
    const base: RuntimeConditions = {
      now: performance.now(),
      headPose: cam.poseSource.pose,
      trackingOk: cam.poseSource.quality.trackingOk,
      localizedAnchors: app.anchorStatus?.localized ? new Set(['room-anchor']) : new Set(),
      depthAgeMs: 0,
      tier: app.quality.decision.tier,
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
      anchorId: 'room-anchor',
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
      physical: { massKg: 0.3, friction: 0.5, restitution: 0.2, kinematic: true },
      approved: true,
      visible: true,
      ...overrides,
    };
    object.id = id;
    dispatchIntent({ kind: 'spawn', object });
    return id;
  }
  window.__cameraTestHelpers = { conditions, dispatchIntent, spawnTestObject };
}

export function cameraUrl(params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ headless: '1', autostart: '1', source: 'camera', pose: 'static', depth: 'prior', ...params });
  return `/camera.html?${search.toString()}`;
}

const Y4M_PATH = ensureSyntheticY4m(path.resolve('test-results', 'fake-camera'));

export interface CameraFixtures {
  camPage: Page;
  evalCam: Page['evaluate'];
  /** Extra query params for camera.html (per spec via `test.use({ cameraParams: {...} })`). */
  cameraParams: Record<string, string>;
}

export const test = base.extend<CameraFixtures>({
  cameraParams: [{}, { option: true }],
  launchOptions: async ({ launchOptions }, use) => {
    await use({
      ...launchOptions,
      args: [
        ...(launchOptions.args ?? []),
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${Y4M_PATH}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  },
  camPage: async ({ page, cameraParams }, use, testInfo) => {
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(`pageerror: ${err.message}\n${err.stack ?? ''}`);
    });

    await page.goto(cameraUrl(cameraParams));
    await page.waitForFunction(() => Boolean(window.__realityEditor && window.__camera), { timeout: 30_000 });
    await page.evaluate(installHelpers);
    await use(page);

    if (testInfo.status !== 'passed') {
      await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true }).catch(() => undefined);
    }
    if (pageErrors.length > 0) {
      await testInfo.attach('page-errors', { body: pageErrors.join('\n---\n'), contentType: 'text/plain' });
      if (testInfo.status === 'passed') throw new Error(`Uncaught console/page errors during test:\n${pageErrors.join('\n')}`);
    }
  },
  evalCam: async ({ camPage }, use) => {
    await use(camPage.evaluate.bind(camPage));
  },
});

export { expect };
