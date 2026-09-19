/**
 * Minimal HUD: an in-XR canvas-texture panel attached to the camera, plus a
 * DOM panel for desktop/simulator use (hidden when headless). Both show the
 * same status snapshot; the DOM panel additionally hosts the required
 * action buttons.
 */
import * as THREE from 'three';
import type { QualityDecision, QualityTier, VisualMode } from '@/core/types';
import type { CaptureGuide } from '@/app/contract';

export interface HudStatus {
  tier: QualityTier;
  frameP95: number;
  depthAgeMs: number;
  mode: VisualMode;
  selectedObjectId: string | null;
  lastRejection: { reason: string; explanation: string; at: number } | null;
  guide?: CaptureGuide;
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

export class InXRHud {
  readonly panel: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private lastDrawKey = '';

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
    const showRejection = status.lastRejection && now - status.lastRejection.at < REJECTION_DISPLAY_MS;
    const key = JSON.stringify([status, showRejection]);
    if (key === this.lastDrawKey) return;
    this.lastDrawKey = key;

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
    if (status.guide?.active) {
      ctx.fillStyle = '#66ffcc';
      line(status.guide.hint);
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
    if (status.guide?.active) {
      lines.push(`guide: ${status.guide.hint}`);
    }
    this.statusEl.textContent = lines.join('\n');
  }

  dispose(): void {
    this.root.remove();
  }
}

/**
 * 3D floor marker for the guided capture flow: a ring at the target
 * viewpoint's XZ (on the floor) plus a small arrow at head height pointing
 * the way the target viewpoint looks, so a user in the headset can see where
 * to stand and which way to face. Text hint is rendered by InXRHud/DomHud
 * above (see HudStatus.guide).
 */
export class GuideOverlay {
  readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly arrow: THREE.Mesh;

  constructor() {
    const ringGeometry = new THREE.RingGeometry(0.16, 0.22, 32);
    ringGeometry.rotateX(-Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x33ffaa,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(ringGeometry, ringMaterial);
    this.ring.renderOrder = 999;

    const arrowGeometry = new THREE.ConeGeometry(0.05, 0.14, 8);
    const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0x33ffaa, depthWrite: false });
    this.arrow = new THREE.Mesh(arrowGeometry, arrowMaterial);
    this.arrow.renderOrder = 999;

    this.group.add(this.ring, this.arrow);
    this.group.visible = false;
  }

  update(guide: CaptureGuide | undefined, floorY: number): void {
    if (!guide?.active || !guide.targetPose) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const { position, rotation } = guide.targetPose;
    this.ring.position.set(position.x, floorY + 0.01, position.z);
    this.arrow.position.set(position.x, floorY + 0.3, position.z);
    this.arrow.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    // Cone points +Y by default; rotate so its tip points along local -Z
    // (the guide pose's forward/look direction).
    this.arrow.rotateX(Math.PI / 2);
  }

  dispose(): void {
    this.group.clear();
    (this.ring.material as THREE.Material).dispose();
    (this.arrow.material as THREE.Material).dispose();
    this.ring.geometry.dispose();
    this.arrow.geometry.dispose();
  }
}
