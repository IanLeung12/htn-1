/**
 * Camera-backend diagnostics panel: shows the ESTIMATES (pose mode and
 * confidence, depth backend/latency/age/confidence, floor confidence, tier
 * cap) rather than pretending they are measurements. DOM writes are
 * throttled by the caller (every 250 ms). Toggle with the `d` key.
 */
import type { DepthBackend, DepthStatus, FrameSourceKind, PoseMode } from './contract';
import type { QualityTier, Vec3 } from '@/core/types';

export interface CameraDiagnosticsState {
  source: FrameSourceKind;
  videoReady: boolean;
  videoSize: string;
  videoFps: number;
  poseMode: PoseMode;
  poseConfidence: number;
  trackingOk: boolean;
  poseSampleAgeMs: number;
  cameraHeightM: number;
  fovYDeg: number;
  depthState: DepthStatus['state'];
  depthBackend: DepthBackend;
  depthModel: string | null;
  depthInferenceMs: number;
  depthAgeMs: number;
  depthConfidence: number;
  floorConfidence: number;
  surfaceCount: number;
  volumeCount: number;
  tierCap: 'B' | 'C';
  qualityTier: QualityTier;
  frameP95: number;
  appMs: number;
  objectCount: number;
  hoverId: string | null;
  pointerWorld: Vec3 | null;
  error: string | null;
  /** Camera attitude estimated from the dominant depth plane (deg), null until found. */
  estPitchDeg: number | null;
  estRollDeg: number | null;
  /** Surface estimator run stats. */
  tables: number;
  walls: number;
  surfaceRunMs: number;
  /** Median optical-flow magnitude between grabbed frames (px). */
  motionPx: number;
  depthFrames: number;
  depthPublishedAgoMs: number;
  depthFitMode: string;
}

function fmtMs(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(0)} ms` : 'n/a';
}

export class CameraDiagnostics {
  readonly root: HTMLDivElement;
  private readonly pre: HTMLPreElement;
  private visible: boolean;

  constructor(container: HTMLElement, visible: boolean) {
    this.visible = visible;
    this.root = document.createElement('div');
    this.root.id = 'camera-diagnostics';
    this.root.style.cssText = [
      'position:absolute',
      'right:8px',
      'top:8px',
      'z-index:10',
      'font:11px ui-monospace,Menlo,monospace',
      'color:#e8e8ee',
      'background:rgba(0,0,0,0.62)',
      'padding:8px 10px',
      'border-radius:6px',
      'max-width:300px',
      'pointer-events:none',
      'white-space:pre',
      `display:${visible ? 'block' : 'none'}`,
    ].join(';');
    this.pre = document.createElement('pre');
    this.pre.style.cssText = 'margin:0;white-space:pre-wrap;';
    this.root.appendChild(this.pre);
    container.appendChild(this.root);
    window.addEventListener('keydown', this.onKey);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      this.visible = !this.visible;
      this.root.style.display = this.visible ? 'block' : 'none';
    }
  };

  update(s: CameraDiagnosticsState): void {
    if (!this.visible) return;
    const lines = [
      `camera   ${s.source} ${s.videoReady ? s.videoSize : 'starting'} ${s.videoReady ? `${s.videoFps.toFixed(0)} fps` : ''}`,
      `pose     ${s.poseMode} conf ${s.poseConfidence.toFixed(2)} ${s.trackingOk ? 'tracking' : 'LOST'} age ${fmtMs(s.poseSampleAgeMs)}`,
      `frame    h ${s.cameraHeightM.toFixed(2)} m  fovY ${s.fovYDeg.toFixed(0)} deg`,
      `depth    ${s.depthState} ${s.depthBackend}${s.depthModel ? ` ${s.depthModel.split('/').pop()}` : ''}`,
      `         infer ${fmtMs(s.depthInferenceMs)} age ${fmtMs(s.depthAgeMs)} conf ${s.depthConfidence.toFixed(2)}`,
      `         frames ${s.depthFrames} published ${fmtMs(s.depthPublishedAgoMs)} ago  scale ${s.depthFitMode}`,
      `ground   conf ${s.floorConfidence.toFixed(2)}  est pitch ${s.estPitchDeg === null ? '-' : s.estPitchDeg.toFixed(1)} roll ${s.estRollDeg === null ? '-' : s.estRollDeg.toFixed(1)}`,
      `scene    surfaces ${s.surfaceCount} (tables ${s.tables}, walls ${s.walls})  volumes ${s.volumeCount}  ransac ${s.surfaceRunMs.toFixed(0)} ms  motion ${s.motionPx.toFixed(1)} px`,
      `tier cap ${s.tierCap} (estimated depth)  quality tier ${s.qualityTier}`,
      `loop     p95 ${s.frameP95.toFixed(1)} ms  app ${s.appMs.toFixed(2)} ms  objects ${s.objectCount}`,
      `pointer  ${s.hoverId ?? '-'}${s.pointerWorld ? ` @ ${s.pointerWorld.x.toFixed(2)},${s.pointerWorld.y.toFixed(2)},${s.pointerWorld.z.toFixed(2)}` : ''}`,
    ];
    if (s.error) lines.push(`error    ${s.error}`);
    lines.push('d: hide diagnostics   t: tuning panel');
    this.pre.textContent = lines.join('\n');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
