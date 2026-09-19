/**
 * XR session bootstrap: feature negotiation for immersive-ar.
 *
 * Required features are hard requirements (session creation fails without
 * them). Optional features are requested but their absence must not throw -
 * every subsystem downstream (hands, planes, depth, anchors) feature-detects
 * independently and degrades gracefully.
 */
import type * as THREE from 'three';
import type { XRFeatureReport } from '@/app/contract';

export const REQUIRED_FEATURES = ['local-floor'] as const;

export const OPTIONAL_FEATURES = [
  'hand-tracking',
  'plane-detection',
  'mesh-detection',
  'anchors',
  'hit-test',
  'depth-sensing',
  'dom-overlay',
  'bounded-floor',
] as const;

export interface RequestARSessionOptions {
  /** Element used for dom-overlay root, when supported. */
  domOverlayRoot?: HTMLElement;
  /** Called when the session ends (user exit, device error, etc). */
  onEnd?: () => void;
}

export interface ARSessionResult {
  session: XRSession;
  featureReport: XRFeatureReport;
}

function buildDepthSensingInit(): XRDepthStateInit {
  return {
    usagePreference: ['gpu-optimized', 'cpu-optimized'],
    dataFormatPreference: ['luminance-alpha', 'float32'],
  };
}

/**
 * Requests an immersive-ar XRSession with feature negotiation, wires it into
 * the three.js renderer, and reports which optional features actually made
 * it through. Never throws for missing optional features; only throws if
 * immersive-ar itself is unsupported or the browser rejects the required set.
 */
export async function requestARSession(
  renderer: THREE.WebGLRenderer,
  opts: RequestARSessionOptions = {},
): Promise<ARSessionResult> {
  const xr = navigator.xr;
  if (!xr) {
    return {
      session: null as unknown as XRSession,
      featureReport: {
        supported: false,
        enabled: [],
        missing: [...REQUIRED_FEATURES, ...OPTIONAL_FEATURES],
        blendMode: 'unknown',
      },
    };
  }

  const supported = await xr.isSessionSupported('immersive-ar').catch(() => false);
  if (!supported) {
    return {
      session: null as unknown as XRSession,
      featureReport: {
        supported: false,
        enabled: [],
        missing: [...REQUIRED_FEATURES, ...OPTIONAL_FEATURES],
        blendMode: 'unknown',
      },
    };
  }

  const sessionInit: XRSessionInit = {
    requiredFeatures: [...REQUIRED_FEATURES],
    optionalFeatures: [...OPTIONAL_FEATURES],
    depthSensing: buildDepthSensingInit(),
  } as XRSessionInit;

  if (opts.domOverlayRoot) {
    (sessionInit as { domOverlay?: { root: HTMLElement } }).domOverlay = { root: opts.domOverlayRoot };
  }

  const session = await xr.requestSession('immersive-ar', sessionInit);

  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);

  const enabled = Array.from(session.enabledFeatures ?? []);
  const requestedAll = [...REQUIRED_FEATURES, ...OPTIONAL_FEATURES];
  const missing = requestedAll.filter((f) => !enabled.includes(f));

  const depthSession = session as XRSession & { depthUsage?: string; depthDataFormat?: string };

  const featureReport: XRFeatureReport = {
    supported: true,
    enabled,
    missing,
    blendMode: session.environmentBlendMode ?? 'unknown',
    depthUsage: depthSession.depthUsage as XRFeatureReport['depthUsage'],
    depthFormat: depthSession.depthDataFormat,
  };

  session.addEventListener('end', () => {
    opts.onEnd?.();
  });

  return { session, featureReport };
}

export function endARSession(session: XRSession | null | undefined): void {
  if (!session) return;
  try {
    void session.end();
  } catch {
    // Session may already be ending/ended; nothing to do.
  }
}
