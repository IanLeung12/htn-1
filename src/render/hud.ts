/**
 * Minimal HUD: an in-XR canvas-texture status strip attached to the camera,
 * plus a DOM panel for desktop/simulator use (hidden when headless). Both
 * show the same status snapshot; the DOM panel additionally hosts the
 * required action buttons.
 *
 * Design goal (see docs/ui.md): the in-XR surface should read as a thin
 * instrument strip at the bottom of the view, not a panel that competes with
 * the room. A separate world-anchored label carries the selected object's
 * name instead of stuffing it into the strip.
 *
 * ---------------------------------------------------------------------------
 * One-line change needed in src/app/main.ts (not applied here - main.ts is
 * owned by another agent) to light up the selected-object floating label:
 *
 *   1. `scene.add(inXRHud.label);` next to the existing `scene.add(inXRHud.panel);`
 *   2. In the `inXRHud.update({...}, now)` call, add two fields to the status
 *      object passed in:
 *        selectedObjectName: interaction.selectedId
 *          ? snapshot.objects[interaction.selectedId]?.userName ?? null
 *          : null,
 *        selectedObjectPosition: interaction.selectedId
 *          ? snapshot.objects[interaction.selectedId]?.currentPose.position ?? null
 *          : null,
 *
 * Without this, `HudStatus.selectedObjectName`/`selectedObjectPosition` are
 * simply omitted (both optional) and the label stays hidden - the strip
 * itself works fully either way.
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';
import type { QualityDecision, QualityTier, VisualMode } from '@/core/types';
import type { CaptureGuide } from '@/app/contract';
import type { Vec3 } from '@/core/types';

export interface HudStatus {
  tier: QualityTier;
  frameP95: number;
  depthAgeMs: number;
  mode: VisualMode;
  selectedObjectId: string | null;
  lastRejection: { reason: string; explanation: string; at: number } | null;
  guide?: CaptureGuide;
  /** Selected object's display name, for the floating world label. See the
   * module doc above for the one-line main.ts wiring this needs. */
  selectedObjectName?: string | null;
  /** Selected object's current world position, for the floating world label. */
  selectedObjectPosition?: Vec3 | null;
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

/** Strip geometry, shared with src/render/hand-menu.ts's MicButton so the mic
 * glyph lands inside the strip's right end without either module needing a
 * reference to the other. */
export const HUD_DISTANCE_M = 0.45;
export const HUD_WIDTH_M = 0.22;
export const HUD_HEIGHT_M = 0.05;
/** How far below the view centre the strip sits, at HUD_DISTANCE_M. */
export const HUD_VERTICAL_OFFSET_M = -0.13;

const STRIP_CANVAS_W = 440;
const STRIP_CANVAS_H = 100;
const FULL_CANVAS_W = 512;
const FULL_CANVAS_H = 256;
const CORNER_RADIUS_PX = 8;

export type HudDensity = 'minimal' | 'full';

function shortMode(mode: VisualMode): string {
  return mode === 'captured-shell' ? 'shell' : 'live';
}

function fmtFps(frameP95: number): string {
  if (!Number.isFinite(frameP95) || frameP95 <= 0) return '—';
  return Math.round(1000 / frameP95).toString();
}

function fmtDepth(depthAgeMs: number): string {
  return Number.isFinite(depthAgeMs) ? `${Math.round(depthAgeMs)}ms` : '—';
}

function hudChanged(a: HudStatus, b: HudStatus, showRejection: boolean, prevShowRejection: boolean): boolean {
  return (
    a.tier !== b.tier ||
    a.mode !== b.mode ||
    a.selectedObjectId !== b.selectedObjectId ||
    a.lastRejection !== b.lastRejection ||
    a.guide?.active !== b.guide?.active ||
    a.guide?.hint !== b.guide?.hint ||
    showRejection !== prevShowRejection ||
    // Frame timing/depth age change continuously; round so they don't force a
    // redraw every call while still reflecting real movement once per tick.
    fmtFps(a.frameP95) !== fmtFps(b.frameP95) ||
    Math.round(a.depthAgeMs) !== Math.round(b.depthAgeMs)
  );
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class InXRHud {
  readonly panel: THREE.Sprite;
  /** World-anchored billboard label for the selected object's name; add to
   * the scene once (see module doc). Hidden whenever there is nothing (or
   * no position data) to show. */
  readonly label: THREE.Sprite;

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private lastDrawAt = -Infinity;
  private lastStatus: HudStatus | null = null;
  private lastShowRejection = false;
  private density: HudDensity = 'minimal';

  private readonly labelCanvas = document.createElement('canvas');
  private readonly labelCtx: CanvasRenderingContext2D;
  private readonly labelTexture: THREE.CanvasTexture;
  private lastLabelName: string | null | undefined = undefined;
  // Reused per-frame temporary - the label follows the object without
  // allocating a new vector every update() call.
  private readonly tmpLabelPos = new THREE.Vector3();

  constructor() {
    this.canvas.width = STRIP_CANVAS_W;
    this.canvas.height = STRIP_CANVAS_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    const material = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false });
    this.panel = new THREE.Sprite(material);
    this.panel.renderOrder = 1000;
    this.applyDensityScale();

    this.labelCanvas.width = 256;
    this.labelCanvas.height = 64;
    const labelCtx = this.labelCanvas.getContext('2d');
    if (!labelCtx) throw new Error('2d context unavailable');
    this.labelCtx = labelCtx;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    const labelMaterial = new THREE.SpriteMaterial({ map: this.labelTexture, transparent: true, depthTest: false });
    this.label = new THREE.Sprite(labelMaterial);
    this.label.scale.set(0.22, 0.055, 1);
    this.label.renderOrder = 1000;
    this.label.visible = false;
  }

  /** 'minimal' (default): a thin one/two-line status strip. 'full': the
   * previous multi-line debug panel, for development use. */
  setDensity(density: HudDensity): void {
    if (this.density === density) return;
    this.density = density;
    this.applyDensityScale();
    this.lastStatus = null; // force a redraw at the new size
    this.lastDrawAt = -Infinity;
  }

  private applyDensityScale(): void {
    if (this.density === 'minimal') {
      this.canvas.width = STRIP_CANVAS_W;
      this.canvas.height = STRIP_CANVAS_H;
      this.panel.scale.set(HUD_WIDTH_M, HUD_HEIGHT_M * 2, 1); // *2 tall to fit the auto-hiding second line
    } else {
      this.canvas.width = FULL_CANVAS_W;
      this.canvas.height = FULL_CANVAS_H;
      this.panel.scale.set(0.32, 0.18, 1);
    }
  }

  /** Position bottom-centre of the given camera, HUD_DISTANCE_M away. */
  attachTo(camera: THREE.Camera): void {
    const offset = new THREE.Vector3(0, HUD_VERTICAL_OFFSET_M, -HUD_DISTANCE_M);
    offset.applyQuaternion(camera.quaternion);
    this.panel.position.copy(camera.position).add(offset);
    this.panel.quaternion.copy(camera.quaternion);
  }

  update(status: HudStatus, now: number): void {
    const showRejection = Boolean(status.lastRejection && now - status.lastRejection.at < REJECTION_DISPLAY_MS);
    this.updateLabel(status, now);
    if (now - this.lastDrawAt < HUD_UPDATE_INTERVAL_MS) return;
    if (this.lastStatus && !hudChanged(status, this.lastStatus, showRejection, this.lastShowRejection)) {
      this.lastDrawAt = now;
      return;
    }
    this.lastDrawAt = now;
    this.lastStatus = status;
    this.lastShowRejection = showRejection;

    if (this.density === 'minimal') this.drawMinimal(status, showRejection);
    else this.drawFull(status, showRejection);
    this.texture.needsUpdate = true;
  }

  private drawMinimal(status: HudStatus, showRejection: boolean): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    const stripH = height / 2;
    roundRectPath(ctx, 0, 0, width, stripH, CORNER_RADIUS_PX);
    ctx.fillStyle = 'rgba(10,10,14,0.30)';
    ctx.fill();

    ctx.font = '600 30px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';

    // Room-mode glyph, left end: a tiny house/room outline.
    this.drawRoomGlyph(ctx, 26, stripH / 2, status.mode === 'captured-shell');

    const line = `T${status.tier} · ${fmtFps(status.frameP95)}fps · depth ${fmtDepth(status.depthAgeMs)} · ${shortMode(status.mode)}`;
    ctx.fillText(line, 52, stripH / 2 + 1);

    // Right end is reserved for the mic glyph (a separate mesh drawn by
    // MicButton in hand-menu.ts, aligned to the same HUD_* constants) - leave
    // it visually empty here so the two don't overlap.

    if (showRejection && status.lastRejection) {
      roundRectPath(ctx, 0, stripH + 4, width, stripH - 4, CORNER_RADIUS_PX);
      ctx.fillStyle = 'rgba(120,0,0,0.35)';
      ctx.fill();
      ctx.font = '500 22px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = '#ffb3b3';
      ctx.fillText(this.truncate(ctx, `${status.lastRejection.reason}: ${status.lastRejection.explanation}`, width - 24), 12, stripH + 4 + stripH / 2);
    } else if (status.guide?.active) {
      roundRectPath(ctx, 0, stripH + 4, width, stripH - 4, CORNER_RADIUS_PX);
      ctx.fillStyle = 'rgba(0,60,50,0.35)';
      ctx.fill();
      ctx.font = '500 22px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = '#8ffcd6';
      ctx.fillText(this.truncate(ctx, status.guide.hint, width - 24), 12, stripH + 4 + stripH / 2);
    }
  }

  private truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
    return `${s}…`;
  }

  private drawRoomGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, filled: boolean): void {
    const s = 9;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = filled ? 'rgba(140,200,255,0.85)' : 'transparent';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - s, cy + s * 0.6);
    ctx.lineTo(cx - s, cy - s * 0.2);
    ctx.lineTo(cx, cy - s * 1.1);
    ctx.lineTo(cx + s, cy - s * 0.2);
    ctx.lineTo(cx + s, cy + s * 0.6);
    ctx.closePath();
    if (filled) ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawFull(status: HudStatus, showRejection: boolean): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    roundRectPath(ctx, 0, 0, width, height, CORNER_RADIUS_PX);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
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
  }

  private updateLabel(status: HudStatus, now: number): void {
    void now;
    const pos = status.selectedObjectPosition;
    const name = status.selectedObjectName;
    if (!pos || !name) {
      this.label.visible = false;
      return;
    }
    this.label.visible = true;
    // Float just above the object; allocation-free (reused temporary).
    this.tmpLabelPos.set(pos.x, pos.y + 0.14, pos.z);
    this.label.position.copy(this.tmpLabelPos);

    if (this.lastLabelName === name) return;
    this.lastLabelName = name;
    const ctx = this.labelCtx;
    const { width, height } = this.labelCanvas;
    ctx.clearRect(0, 0, width, height);
    roundRectPath(ctx, 4, height / 2 - 20, width - 8, 40, 10);
    ctx.fillStyle = 'rgba(10,10,14,0.55)';
    ctx.fill();
    ctx.font = '600 24px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(this.truncate(ctx, name, width - 24), width / 2, height / 2);
    this.labelTexture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    (this.panel.material as THREE.SpriteMaterial).dispose();
    this.labelTexture.dispose();
    (this.label.material as THREE.SpriteMaterial).dispose();
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
    const addButton = (label: string, onClick: () => void, dataAction?: string): void => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'font-size:11px;padding:4px 6px;';
      if (dataAction) btn.dataset.action = dataAction;
      btn.addEventListener('click', onClick);
      buttonBar.appendChild(btn);
    };
    // 'enter-ar' is a stable hook so other UI (e.g. the landing page in
    // index.html/src/sim/entry.ts) can trigger the exact same action - either
    // by calling AppHandle.enterAR() directly, or by dispatching a click at
    // `#re-hud [data-action="enter-ar"]` when only the DOM is at hand.
    addButton('Enter AR', buttons.onEnterAR, 'enter-ar');
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
