/**
 * On-device diagnostics: a small DOM panel that is useful before entering AR
 * (navigator.xr / isSessionSupported checks) and while a session is active
 * (feature report, reference space, frame rate, hand/plane/mesh counts, depth
 * age, quality tier, perf percentiles, recent quality history). `getLines()`
 * exposes the same text so the in-XR HUD (render/hud.ts) can mirror it without
 * this module depending on three.js or the HUD.
 *
 * `update()` is called every rendered frame by the app; DOM writes (and the
 * line rebuild itself, since it does string formatting) are throttled to 4 Hz
 * - diagnostics are, by definition, not on the display-critical path (see
 * reality-editor-runtime-budget.md's budget hierarchy), and rebuilding a dozen
 * template-literal strings at up to ~90 Hz would be pure per-frame allocation
 * for a panel a person reads a few times a second at most.
 */
import type { DegradeReason, Millis, QualityTier } from '@/core/types';
import type { XRFeatureReport } from '@/app/contract';

export interface QualityHistoryEntry {
  at: Millis;
  from: QualityTier;
  to: QualityTier;
  reasons: DegradeReason[];
}

export type TargetFrameRateRequest = 'not-attempted' | 'ok' | 'unsupported';

export interface DiagnosticsState {
  /** `navigator.xr` present in this browser. */
  xrPresent: boolean;
  /** Result of `navigator.xr.isSessionSupported('immersive-ar')`; null while unchecked. */
  arSupported: boolean | null;
  /** True while an XR session is currently active. */
  inSession: boolean;
  /** Feature report from the last session request; null before the first attempt. */
  featureReport: XRFeatureReport | null;
  /** Reference space type actually bound (e.g. 'local-floor'), or null outside a session. */
  referenceSpaceType: string | null;
  /** `session.frameRate`, if the runtime reports one. */
  frameRate: number | null;
  /** `session.supportedFrameRates`, if the runtime reports them. */
  supportedFrameRates: readonly number[] | null;
  /** Outcome of a guarded `session.updateTargetFrameRate(90)` attempt. */
  targetFrameRateRequest: TargetFrameRateRequest;
  /** True if either hand currently has joint data. */
  handTrackingAvailable: boolean;
  planeCount: number;
  meshCount: number;
  /** Milliseconds since the last valid depth-sensing sample (Infinity if never). */
  depthAgeMs: number;
  qualityTier: QualityTier;
  perfP50: number;
  perfP95: number;
  perfP99: number;
  /** Newest-last; only the last 5 are shown. */
  qualityHistory: readonly QualityHistoryEntry[];
}

export interface Diagnostics {
  /** Mount the DOM panel into `container`. Safe to call before entering AR. */
  attach(container: HTMLElement): void;
  /** Call once per rendered frame; DOM writes are internally throttled to 4 Hz. */
  update(state: DiagnosticsState): void;
  /** The most recently rendered lines, for mirroring into the in-XR HUD. */
  getLines(): readonly string[];
  dispose(): void;
}

const UPDATE_INTERVAL_MS = 250; // 4 Hz

function fmtMs(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function buildLines(state: DiagnosticsState): string[] {
  const lines: string[] = [];
  lines.push(`navigator.xr: ${state.xrPresent ? 'present' : 'MISSING'}`);
  lines.push(
    `immersive-ar supported: ${state.arSupported === null ? 'unknown' : state.arSupported ? 'yes' : 'no'}`,
  );

  if (state.featureReport) {
    lines.push(`session: ${state.inSession ? 'active' : 'ended'}  blend=${state.featureReport.blendMode}`);
    lines.push(`enabled: ${state.featureReport.enabled.join(', ') || '(none)'}`);
    lines.push(`missing: ${state.featureReport.missing.join(', ') || '(none)'}`);
    lines.push(
      `depth usage/format: ${state.featureReport.depthUsage ?? '—'} / ${state.featureReport.depthFormat ?? '—'}`,
    );
  } else {
    lines.push('session: not started');
  }

  lines.push(`reference space: ${state.referenceSpaceType ?? '—'}`);
  lines.push(
    `frame rate: ${state.frameRate ?? '—'}Hz  supported: ${
      state.supportedFrameRates && state.supportedFrameRates.length > 0 ? state.supportedFrameRates.join('/') : '—'
    }  target90: ${state.targetFrameRateRequest}`,
  );
  lines.push(`hand tracking: ${state.handTrackingAvailable ? 'available' : 'no'}`);
  lines.push(`planes: ${state.planeCount}  meshes: ${state.meshCount}`);
  lines.push(`depth age: ${Number.isFinite(state.depthAgeMs) ? `${fmtMs(state.depthAgeMs, 0)}ms` : '—'}`);
  lines.push(`quality tier: ${state.qualityTier}`);
  lines.push(
    `frame p50/p95/p99: ${fmtMs(state.perfP50)}/${fmtMs(state.perfP95)}/${fmtMs(state.perfP99)}ms`,
  );

  const recent = state.qualityHistory.slice(-5);
  if (recent.length === 0) {
    lines.push('quality history: (none)');
  } else {
    lines.push('quality history:');
    for (const entry of recent) {
      lines.push(`  ${entry.from}→${entry.to} @ ${fmtMs(entry.at, 0)}ms (${entry.reasons.join(',') || 'ok'})`);
    }
  }

  return lines;
}

/**
 * Best-effort, guarded frame-rate probe. Never throws: `updateTargetFrameRate`
 * is optional-chained and callers pass the outcome back through
 * `DiagnosticsState.targetFrameRateRequest` rather than this module reaching
 * into the session itself, so it stays framework/XR-API agnostic.
 */
export async function tryUpdateTargetFrameRate(
  session: { updateTargetFrameRate?: (rate: number) => Promise<void> } | null | undefined,
  rate = 90,
): Promise<TargetFrameRateRequest> {
  if (!session || typeof session.updateTargetFrameRate !== 'function') return 'not-attempted';
  try {
    await session.updateTargetFrameRate(rate);
    return 'ok';
  } catch {
    return 'unsupported';
  }
}

/**
 * Landing-page mirror of `buildLines()`: a lightweight, dependency-free
 * capability summary for a "what works on your device" list shown before
 * `startApp()`/`AppHandle` exist (see index.html and src/sim/entry.ts's
 * landing card). Reuses the exact same line-formatting as the full
 * diagnostics panel so the two never drift apart, but only fills in the
 * fields answerable synchronously/from `navigator.xr` alone - everything
 * that depends on an active session renders as "not started"/"—", matching
 * `buildLines()`'s own behaviour before a session exists.
 */
export async function getLandingDiagnosticLines(maxLines = 6): Promise<string[]> {
  const xrPresent = typeof navigator !== 'undefined' && 'xr' in navigator;
  let arSupported: boolean | null = null;
  if (xrPresent) {
    try {
      arSupported = await (navigator as unknown as { xr: XRSystem }).xr.isSessionSupported('immersive-ar');
    } catch {
      arSupported = false;
    }
  }
  const state: DiagnosticsState = {
    xrPresent,
    arSupported,
    inSession: false,
    featureReport: null,
    referenceSpaceType: null,
    frameRate: null,
    supportedFrameRates: null,
    targetFrameRateRequest: 'not-attempted',
    handTrackingAvailable: false,
    planeCount: 0,
    meshCount: 0,
    depthAgeMs: Infinity,
    qualityTier: 0 as QualityTier,
    perfP50: 0,
    perfP95: 0,
    perfP99: 0,
    qualityHistory: [],
  };
  return buildLines(state).slice(0, maxLines);
}

export function createDiagnostics(): Diagnostics {
  let root: HTMLDivElement | null = null;
  let pre: HTMLPreElement | null = null;
  let lastLines: readonly string[] = [];
  let lastWriteAt = -Infinity;

  return {
    attach(container: HTMLElement): void {
      root = document.createElement('div');
      root.id = 're-diagnostics';
      root.style.cssText = [
        'position:fixed',
        'right:8px',
        'top:8px',
        'z-index:10',
        'font-family:monospace',
        'font-size:11px',
        'line-height:1.4',
        'color:#9f9',
        'background:rgba(0,0,0,0.65)',
        'padding:8px',
        'border-radius:6px',
        'max-width:340px',
        'white-space:pre-wrap',
        'pointer-events:none',
      ].join(';');
      pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;';
      root.appendChild(pre);
      container.appendChild(root);
    },

    update(state: DiagnosticsState): void {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - lastWriteAt < UPDATE_INTERVAL_MS) return;
      lastWriteAt = now;
      lastLines = buildLines(state);
      if (pre) pre.textContent = lastLines.join('\n');
    },

    getLines(): readonly string[] {
      return lastLines;
    },

    dispose(): void {
      root?.remove();
      root = null;
      pre = null;
    },
  };
}

export default createDiagnostics;
