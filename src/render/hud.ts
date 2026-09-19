/**
 * Minimal HUD: an in-XR canvas-texture panel attached to the camera, plus a
 * DOM panel for desktop/simulator use (hidden when headless). Both show the
 * same status snapshot; the DOM panel additionally hosts the required
 * action buttons.
 */
import * as THREE from 'three';
import type { QualityDecision, QualityTier, VisualMode } from '@/core/types';

export interface HudStatus {
  tier: QualityTier;
  frameP95: number;
  depthAgeMs: number;
  mode: VisualMode;
  selectedObjectId: string | null;
  lastRejection: { reason: string; explanation: string; at: number } | null;
}

export interface HudButtons {
  onEnterAR(): void;
  onDiscover(): void;
  onCapturePlate(): void;
  onDelete(): void;
  onRestore(): void;
  onUndo(): void;
  onRedo(): void;
  onModeToggle(): void;
  onSpawnCube(): void;
  onSpawnSphere(): void;
}

const REJECTION_DISPLAY_MS = 3000;
/** HUD text is diagnostic, not a display-critical surface (see runtime-budget
 * budget hierarchy) - redraw the canvas/DOM text at most 4 Hz instead of every
 * rendered frame (up to ~90 Hz in XR), which was rebuilding strings/arrays and
 * (for the in-XR canvas) repainting + re-uploading a texture every frame. */
const HUD_UPDATE_INTERVAL_MS = 250;

function hudChanged(a: HudStatus, b: HudStatus, showRejection: boolean, prevShowRejection: boolean): boolean {
  return (
    a.tier !== b.tier ||
    a.mode !== b.mode ||
    a.selectedObjectId !== b.selectedObjectId ||
    a.lastRejection !== b.lastRejection ||
    showRejection !== prevShowRejection ||
    // Frame timing/depth age change continuously; round so they don't force a
    // redraw every call while still reflecting real movement once per tick.
    Math.round(a.frameP95) !== Math.round(b.frameP95) ||
    Math.round(a.depthAgeMs) !== Math.round(b.depthAgeMs)
  );
}

export class InXRHud {
  readonly panel: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private lastDrawAt = -Infinity;
  private lastStatus: HudStatus | null = null;
  private lastShowRejection = false;

  constructor() {
    this.canvas.width = 512;
    this.canvas.height = 256;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    const material = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false });
    this.panel = new THREE.Sprite(material);
    this.panel.scale.set(0.3, 0.15, 1);
    this.panel.renderOrder = 1000;
  }

  /** Position bottom-left of the given camera, ~0.3 m away. */
  attachTo(camera: THREE.Camera): void {
    const offset = new THREE.Vector3(-0.14, -0.09, -0.3);
    offset.applyQuaternion(camera.quaternion);
    this.panel.position.copy(camera.position).add(offset);
    this.panel.quaternion.copy(camera.quaternion);
  }

  update(status: HudStatus, now: number): void {
    const showRejection = Boolean(status.lastRejection && now - status.lastRejection.at < REJECTION_DISPLAY_MS);
    if (now - this.lastDrawAt < HUD_UPDATE_INTERVAL_MS) return;
    if (this.lastStatus && !hudChanged(status, this.lastStatus, showRejection, this.lastShowRejection)) {
      this.lastDrawAt = now;
      return;
    }
    this.lastDrawAt = now;
    this.lastStatus = status;
    this.lastShowRejection = showRejection;

    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.font = '24px sans-serif';
    let y = 32;
    const line = (text: string): void => {
      ctx.fillText(text, 16, y);
      y += 32;
    };
    line(`tier ${status.tier}  mode ${status.mode}`);
    line(`frame p95 ${status.frameP95.toFixed(1)}ms`);
    line(`depth age ${Number.isFinite(status.depthAgeMs) ? status.depthAgeMs.toFixed(0) : '—'}ms`);
    line(`selected: ${status.selectedObjectId ?? 'none'}`);
    if (showRejection && status.lastRejection) {
      ctx.fillStyle = '#ff6666';
      line(`✗ ${status.lastRejection.reason}: ${status.lastRejection.explanation}`);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    (this.panel.material as THREE.SpriteMaterial).dispose();
  }
}

export class DomHud {
  readonly root: HTMLDivElement;
  private readonly statusEl: HTMLPreElement;
  private lastDrawAt = -Infinity;

  constructor(container: HTMLElement, headless: boolean, buttons: HudButtons) {
    this.root = document.createElement('div');
    this.root.id = 're-hud';
    this.root.style.cssText = [
      'position:fixed',
      'left:8px',
      'top:8px',
      'z-index:10',
      'font-family:monospace',
      'font-size:12px',
      'color:#fff',
      'background:rgba(0,0,0,0.6)',
      'padding:8px',
      'border-radius:6px',
      'max-width:260px',
    ].join(';');

    this.statusEl = document.createElement('pre');
    this.statusEl.style.cssText = 'margin:0 0 8px 0; white-space:pre-wrap;';
    this.root.appendChild(this.statusEl);

    const buttonBar = document.createElement('div');
    buttonBar.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px;';
    const addButton = (label: string, onClick: () => void): void => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'font-size:11px;padding:4px 6px;';
      btn.addEventListener('click', onClick);
      buttonBar.appendChild(btn);
    };
    addButton('Enter AR', buttons.onEnterAR);
    addButton('Discover', buttons.onDiscover);
    addButton('Capture plate', buttons.onCapturePlate);
    addButton('Delete', buttons.onDelete);
    addButton('Restore', buttons.onRestore);
    addButton('Undo', buttons.onUndo);
    addButton('Redo', buttons.onRedo);
    addButton('Mode toggle', buttons.onModeToggle);
    addButton('Spawn cube', buttons.onSpawnCube);
    addButton('Spawn sphere', buttons.onSpawnSphere);
    this.root.appendChild(buttonBar);

    this.root.style.display = headless ? 'none' : 'block';
    container.appendChild(this.root);
  }

  update(status: HudStatus, decision: QualityDecision, now: number): void {
    if (now - this.lastDrawAt < HUD_UPDATE_INTERVAL_MS) return;
    this.lastDrawAt = now;
    const showRejection = status.lastRejection && now - status.lastRejection.at < REJECTION_DISPLAY_MS;
    const lines = [
      `tier ${status.tier} (${decision.reasons.join(',') || 'ok'})`,
      `mode ${status.mode}`,
      `frame p95 ${status.frameP95.toFixed(1)}ms`,
      `depth age ${Number.isFinite(status.depthAgeMs) ? status.depthAgeMs.toFixed(0) : '—'}ms`,
      `selected ${status.selectedObjectId ?? 'none'}`,
    ];
    if (showRejection && status.lastRejection) {
      lines.push(`rejected: ${status.lastRejection.reason} — ${status.lastRejection.explanation}`);
    }
    this.statusEl.textContent = lines.join('\n');
  }

  dispose(): void {
    this.root.remove();
  }
}
