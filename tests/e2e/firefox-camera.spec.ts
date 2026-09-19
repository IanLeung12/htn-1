/**
 * Diagnostic spec for the Firefox "black screen after Start camera" bug on
 * camera.html (general-camera backend). Run explicitly against Firefox:
 *
 *   npx playwright test tests/e2e/firefox-camera.spec.ts --browser=firefox --reporter=line
 *
 * This spec intentionally does NOT use tests/e2e/camera-fixtures.ts, because
 * that fixture bakes in Chromium-only fake-media flags
 * (--use-fake-device-for-media-stream etc). Firefox needs fake media turned
 * on via `firefoxUserPrefs` instead:
 *   media.navigator.streams.fake        -> synthetic test-pattern camera
 *   media.navigator.permission.disabled -> skip the permission prompt
 *
 * Firefox's fake camera renders a moving test pattern (colour bars / a
 * bouncing box), NOT our synthetic Y4M room (tests/e2e/y4m.ts is a Chromium
 * fake-video-capture file and has no Firefox equivalent). That's fine here:
 * we only care whether video pixels reach the screen at all, not their
 * content.
 *
 * The spec is written to be lenient so it can be re-run, unmodified, once
 * the underlying bug is fixed: it asserts "not a black screen" and "no page
 * errors", not the exact diagnosis text below.
 */
import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

test.skip(({ browserName }) => browserName !== 'firefox', 'This spec only makes sense under --browser=firefox');

// playwright.config.ts sets `use.launchOptions.args` to Chromium-only flags
// (--use-gl=angle etc). Those are meaningless (and can be rejected) by
// Firefox, so this file replaces `launchOptions` wholesale with Firefox fake
// media prefs instead of trying to merge into the Chromium args.
test.use({
  launchOptions: {
    firefoxUserPrefs: {
      'media.navigator.streams.fake': true,
      'media.navigator.permission.disabled': true,
    },
  },
});

interface PageDiag {
  inSession: boolean;
  frameSourceReady: boolean;
  videoWidth: number;
  videoHeight: number;
  videoPaused: boolean;
  videoReadyState: number;
  videoCurrentTime: number;
  videoStyle: { display: string; visibility: string; zIndex: string; position: string; width: number; height: number; top: number; left: number };
  canvasStyle: { display: string; visibility: string; zIndex: string; position: string; width: number; height: number; top: number; left: number } | null;
  webgl2: boolean;
  webgl1: boolean;
  containerPosition: string;
  cameraDiagnostics: unknown;
  playRejection: string | null;
}

async function collectDiag(page: Page): Promise<PageDiag> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#app video');
    const canvas = document.querySelector<HTMLCanvasElement>('#app canvas');
    const app = document.getElementById('app');
    const styleOf = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { display: cs.display, visibility: cs.visibility, zIndex: cs.zIndex, position: cs.position, width: rect.width, height: rect.height, top: rect.top, left: rect.left };
    };
    const cam = window.__camera;
    return {
      inSession: Boolean((window as unknown as { __realityEditor?: { inSession?: boolean } }).__realityEditor),
      frameSourceReady: cam ? cam.frameSource.ready : false,
      videoWidth: video?.videoWidth ?? -1,
      videoHeight: video?.videoHeight ?? -1,
      videoPaused: video?.paused ?? true,
      videoReadyState: video?.readyState ?? -1,
      videoCurrentTime: video?.currentTime ?? -1,
      videoStyle: video ? styleOf(video) : { display: '', visibility: '', zIndex: '', position: '', width: 0, height: 0, top: 0, left: 0 },
      canvasStyle: canvas ? styleOf(canvas) : null,
      webgl2: Boolean(canvas?.getContext('webgl2')),
      webgl1: Boolean(canvas?.getContext('webgl')),
      containerPosition: app ? getComputedStyle(app).position : '',
      cameraDiagnostics: cam ? cam.diagnostics : null,
      playRejection: (window as unknown as { __playRejection?: string }).__playRejection ?? null,
    };
  });
}

function meanBrightness(pngPath: string): number {
  const buf = fs.readFileSync(pngPath);
  const png = PNG.sync.read(buf);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    sum += (png.data[i] as number) + (png.data[i + 1] as number) + (png.data[i + 2] as number);
    n += 3;
  }
  return sum / n;
}

async function runCase(page: Page, depth: string, testInfo: { outputPath: (n: string) => string }, waitMs = 4000) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(`${err.message}\n${err.stack ?? ''}`);
  });
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText}`);
  });

  // Instrument video.play() rejections before app code runs, in case
  // autoplay is refused without a user gesture.
  await page.addInitScript(() => {
    const proto = HTMLMediaElement.prototype;
    const origPlay = proto.play;
    proto.play = function patchedPlay(this: HTMLMediaElement, ...args: unknown[]) {
      const result = origPlay.apply(this, args as []);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          (window as unknown as { __playRejection?: string }).__playRejection = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        });
      }
      return result;
    };
  });

  const url = `/camera.html?headless=1&autostart=1&source=camera&pose=static&depth=${depth}`;
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__realityEditor && window.__camera), { timeout: 30_000 });
  const readyMs = Date.now() - t0;

  // Give the video + (possibly WASM) depth pipeline a few seconds to settle.
  await page.waitForTimeout(waitMs);

  const diag = await collectDiag(page);

  const screenshotPath = testInfo.outputPath(`firefox-camera-depth-${depth}.png`);
  await page.screenshot({ path: screenshotPath });
  const brightness = meanBrightness(screenshotPath);

  console.log(`\n===== depth=${depth} (readyMs=${readyMs}) =====`);
  console.log('inSession/frameSource.ready:', diag.inSession, diag.frameSourceReady);
  console.log('video wxh:', diag.videoWidth, 'x', diag.videoHeight, 'paused:', diag.videoPaused, 'readyState:', diag.videoReadyState, 'currentTime:', diag.videoCurrentTime);
  console.log('video style:', JSON.stringify(diag.videoStyle));
  console.log('canvas style:', JSON.stringify(diag.canvasStyle));
  console.log('webgl2:', diag.webgl2, 'webgl1:', diag.webgl1);
  console.log('container position:', diag.containerPosition);
  console.log('play() rejection:', diag.playRejection);
  console.log('camera.diagnostics:', JSON.stringify(diag.cameraDiagnostics));
  console.log('mean screenshot brightness (0-255):', brightness.toFixed(2));
  console.log('console errors:', consoleErrors.length ? '\n  ' + consoleErrors.join('\n  ') : '(none)');
  console.log('page errors:', pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : '(none)');
  console.log('failed requests:', failedRequests.length ? '\n  ' + failedRequests.join('\n  ') : '(none)');

  return { diag, brightness, consoleErrors, pageErrors, failedRequests, screenshotPath };
}

test('probe: Firefox platform capabilities relevant to the black-screen candidates', async ({ page }) => {
  await page.goto('about:blank');
  const result = await page.evaluate(() => {
    const v = document.createElement('video');
    const c = document.createElement('div');
    c.style.inset = '0';
    return {
      rvfc: typeof (v as unknown as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback,
      gpuInNavigator: 'gpu' in navigator,
      insetShorthandApplied: c.style.top === '0px' && c.style.left === '0px' && c.style.right === '0px' && c.style.bottom === '0px',
      ua: navigator.userAgent,
    };
  });
  console.log('\n===== platform capability probe =====');
  console.log(JSON.stringify(result, null, 2));
});

test('camera.html on Firefox: depth=prior (analytic floor, no model/worker)', async ({ page }, testInfo) => {
  const { diag, brightness, pageErrors } = await runCase(page, 'prior', testInfo);
  console.log('--- diagnosis assertions (depth=prior) ---');
  expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
  expect(diag.videoWidth, 'video should have real dimensions').toBeGreaterThan(0);
  expect(brightness, 'screenshot should not be a black screen').toBeGreaterThanOrEqual(5);
});

test('camera.html on Firefox: depth=auto (model path, WASM fallback expected)', async ({ page }, testInfo) => {
  const { diag, brightness, pageErrors } = await runCase(page, 'auto', testInfo, 25000);
  console.log('--- diagnosis assertions (depth=auto) ---');
  expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
  expect(diag.videoWidth, 'video should have real dimensions').toBeGreaterThan(0);
  expect(brightness, 'screenshot should not be a black screen (depth model failure must not black out the page)').toBeGreaterThanOrEqual(5);
});

test('camera.html on Firefox: real landing-card button flow (no autostart/headless), default query params', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(`${err.message}\n${err.stack ?? ''}`));
  await page.addInitScript(() => {
    const proto = HTMLMediaElement.prototype;
    const origPlay = proto.play;
    proto.play = function patchedPlay(this: HTMLMediaElement, ...args: unknown[]) {
      const result = origPlay.apply(this, args as []);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          (window as unknown as { __playRejection?: string }).__playRejection = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        });
      }
      return result;
    };
  });

  await page.goto('/camera.html');
  const startButton = page.locator('#start-camera');
  await expect(startButton).toBeEnabled({ timeout: 15_000 });
  await startButton.click(); // real user gesture, via Playwright's trusted click
  await page.waitForFunction(() => Boolean(window.__realityEditor && window.__camera), { timeout: 30_000 });

  // Wait for either the landing card to hide (enterAR resolved) or the status
  // line to report an error (enterAR rejected).
  await page.waitForFunction(
    () => document.getElementById('landing')?.classList.contains('hidden') || (document.getElementById('landing-status')?.textContent ?? '').length > 0,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(3000);

  const landingHidden = await page.evaluate(() => document.getElementById('landing')?.classList.contains('hidden') ?? false);
  const landingStatus = await page.evaluate(() => document.getElementById('landing-status')?.textContent ?? '');
  const diag = await collectDiag(page);
  const screenshotPath = testInfo.outputPath('firefox-camera-button-flow.png');
  await page.screenshot({ path: screenshotPath });
  const brightness = meanBrightness(screenshotPath);

  console.log('\n===== button-flow (no autostart/headless) =====');
  console.log('landingHidden:', landingHidden, 'landingStatus:', JSON.stringify(landingStatus));
  console.log('inSession/frameSource.ready:', diag.inSession, diag.frameSourceReady);
  console.log('video wxh:', diag.videoWidth, 'x', diag.videoHeight, 'paused:', diag.videoPaused);
  console.log('play() rejection:', diag.playRejection);
  console.log('camera.diagnostics:', JSON.stringify(diag.cameraDiagnostics));
  console.log('mean screenshot brightness:', brightness.toFixed(2));
  console.log('console errors:', consoleErrors.length ? '\n  ' + consoleErrors.join('\n  ') : '(none)');
  console.log('page errors:', pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : '(none)');
});
