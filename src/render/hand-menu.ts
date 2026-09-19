/**
 * Palm-up hand menu, attached to the left hand's wrist joint, plus a small
 * MicButton. Both are canvas-textured three.js quads (cheap, consistent with
 * src/render/hud.ts), sharing its font and rounded-corner look.
 *
 * The menu shows only while the left palm faces the head
 * (dot(palmNormal, toHead) > 0.6). Buttons highlight when the right index
 * tip is within 4cm (hover) and show press feedback when poking within
 * ~2cm or pinching while the right hand's ray hits a button. `update()` runs
 * every rendered frame and only touches pre-allocated temporaries - no
 * per-frame allocation.
 */
import * as THREE from 'three';
import type { HandState, InputState } from '@/xr/input';
import { HUD_DISTANCE_M, HUD_WIDTH_M, HUD_VERTICAL_OFFSET_M } from '@/render/hud';

export type HandMenuAction =
  | 'delete'
  | 'restore'
  | 'undo'
  | 'redo'
  | 'roomToggle'
  | 'spawnCube'
  | 'capture';

interface ButtonDef {
  action: HandMenuAction;
  label: string;
}

const BUTTONS: ButtonDef[] = [
  { action: 'delete', label: 'Delete' },
  { action: 'restore', label: 'Restore' },
  { action: 'undo', label: 'Undo' },
  { action: 'redo', label: 'Redo' },
  { action: 'roomToggle', label: 'Room' },
  { action: 'spawnCube', label: 'Spawn cube' },
  { action: 'capture', label: 'Capture' },
];

const PALM_DOT_THRESHOLD = 0.6;
const HOVER_DIST_M = 0.04;
const PRESS_DIST_M = 0.02;
const BUTTON_W = 0.05;
const BUTTON_H = 0.024;
const GAP = 0.03;
const CORNER_RADIUS_PX = 10;
const COLUMNS = 2;
const FONT = '600 22px system-ui, -apple-system, "Segoe UI", sans-serif';

type ButtonVisualState = 'idle' | 'hover' | 'pressed';

interface ButtonEntry {
  def: ButtonDef;
  mesh: THREE.Mesh;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  state: ButtonVisualState;
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

export class HandMenu {
  readonly group = new THREE.Group();
  visible = false;

  private readonly buttons: ButtonEntry[] = [];
  private readonly callbacks: Array<(action: HandMenuAction) => void> = [];

  // Reused per-frame temporaries (see module doc: no per-frame allocation).
  private readonly tmpToHead = new THREE.Vector3();
  private readonly tmpButtonWorldPos = new THREE.Vector3();
  private readonly tmpDelta = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();

  constructor() {
    BUTTONS.forEach((def, i) => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 72;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
      const geometry = new THREE.PlaneGeometry(BUTTON_W, BUTTON_H);
      const mesh = new THREE.Mesh(geometry, material);

      const col = i % COLUMNS;
      const row = Math.floor(i / COLUMNS);
      mesh.position.set((col - (COLUMNS - 1) / 2) * (BUTTON_W + GAP), -row * (BUTTON_H + GAP), 0);
      this.group.add(mesh);

      const entry: ButtonEntry = { def, mesh, ctx, texture, state: 'idle' };
      this.drawButton(entry);
      this.buttons.push(entry);
    });

    // Palm-facing quads work best angled slightly toward where a raised palm
    // would present them; simplest default keeps the menu flat on the wrist.
    this.group.visible = false;
  }

  private drawButton(entry: ButtonEntry): void {
    const { ctx } = entry;
    const { width, height } = ctx.canvas;
    ctx.clearRect(0, 0, width, height);
    const bg =
      entry.state === 'pressed'
        ? 'rgba(70,150,255,0.95)'
        : entry.state === 'hover'
          ? 'rgba(60,110,180,0.85)'
          : 'rgba(20,20,20,0.72)';
    roundRectPath(ctx, 2, 2, width - 4, height - 4, CORNER_RADIUS_PX);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(entry.def.label, width / 2, height / 2);
    entry.texture.needsUpdate = true;
  }

  onAction(cb: (action: HandMenuAction) => void): void {
    this.callbacks.push(cb);
  }

  private emit(action: HandMenuAction): void {
    for (const cb of this.callbacks) cb(action);
  }

  private setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.group.visible = v;
  }

  /** Call once per rendered frame. */
  update(input: InputState, camera: THREE.Camera): void {
    const left = input.left;
    if (!left.active || left.source !== 'hand' || left.palmNormal.lengthSq() === 0) {
      this.setVisible(false);
      return;
    }

    camera.getWorldPosition(this.tmpToHead);
    this.tmpToHead.sub(left.wristPosition).normalize();
    const facingHead = left.palmNormal.dot(this.tmpToHead) > PALM_DOT_THRESHOLD;

    this.setVisible(facingHead);
    if (!facingHead) return;

    this.group.position.copy(left.wristPosition);
    this.group.quaternion.copy(left.wristQuaternion);
    this.group.updateMatrixWorld(true);

    this.updateSelection(input.right);
  }

  private updateSelection(right: HandState): void {
    if (!right.active) {
      for (const btn of this.buttons) this.setState(btn, 'idle');
      return;
    }

    const pinchRayActive = right.pinching;

    for (const btn of this.buttons) {
      btn.mesh.getWorldPosition(this.tmpButtonWorldPos);
      this.tmpDelta.copy(right.position).sub(this.tmpButtonWorldPos);
      const dist = this.tmpDelta.length();
      const pinchHit = pinchRayActive && this.rayHitsButton(right, btn.mesh);
      const state: ButtonVisualState = dist < PRESS_DIST_M || pinchHit ? 'pressed' : dist < HOVER_DIST_M ? 'hover' : 'idle';
      this.setState(btn, state);
    }
  }

  private rayHitsButton(hand: HandState, mesh: THREE.Mesh): boolean {
    this.raycaster.set(hand.ray.origin, hand.ray.direction);
    return this.raycaster.intersectObject(mesh, false).length > 0;
  }

  private setState(entry: ButtonEntry, state: ButtonVisualState): void {
    if (entry.state === state) return;
    const wasPressed = entry.state === 'pressed';
    entry.state = state;
    this.drawButton(entry);
    if (state === 'pressed' && !wasPressed) this.emit(entry.def.action);
  }

  dispose(): void {
    for (const btn of this.buttons) {
      btn.texture.dispose();
      (btn.mesh.material as THREE.Material).dispose();
      btn.mesh.geometry.dispose();
    }
    this.group.clear();
  }
}

const MIC_SIZE = 0.032;
/** Inset from the strip's right/bottom edges so the glyph sits inside it
 * rather than on the border. */
const MIC_MARGIN_M = 0.02;

/**
 * Small camera-attached mic toggle glyph, positioned at the right end of the
 * in-XR HUD strip (src/render/hud.ts) so it reads as part of the same
 * instrument, not a floating button in the middle of the view.
 *
 * `voice-install.ts` calls `attachTo(camera)` once per frame (it has no
 * reference to InXRHud) - this computes the strip-relative offset itself
 * from the shared HUD_* constants, so no cross-module wiring is needed.
 */
export class MicButton {
  readonly mesh: THREE.Mesh;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly callbacks: Array<() => void> = [];
  private listeningState = false;

  constructor() {
    this.canvas.width = 96;
    this.canvas.height = 96;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(MIC_SIZE, MIC_SIZE), material);
    this.mesh.renderOrder = 1000;
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, width / 2 - 4, 0, Math.PI * 2);
    ctx.fillStyle = this.listeningState ? 'rgba(255,80,80,0.95)' : 'rgba(20,20,24,0.55)';
    ctx.fill();
    ctx.strokeStyle = this.listeningState ? '#ffdede' : 'rgba(255,255,255,0.8)';
    ctx.lineWidth = this.listeningState ? 3 : 2;
    ctx.stroke();

    // Simple mic glyph (capsule + stand) rather than a text label, to read as
    // an icon at HUD scale.
    const cx = width / 2;
    const capsuleTop = height * 0.28;
    const capsuleH = height * 0.32;
    const capsuleW = width * 0.22;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(cx - capsuleW / 2, capsuleTop, capsuleW, capsuleH, capsuleW / 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, capsuleTop + capsuleH * 0.65, capsuleW * 1.05, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, capsuleTop + capsuleH * 0.65 + capsuleW * 1.05 * 0.55);
    ctx.lineTo(cx, height * 0.78);
    ctx.stroke();
    this.texture.needsUpdate = true;
  }

  get listening(): boolean {
    return this.listeningState;
  }

  setListening(v: boolean): void {
    if (this.listeningState === v) return;
    this.listeningState = v;
    this.draw();
  }

  onToggle(cb: () => void): void {
    this.callbacks.push(cb);
  }

  /** Poke/pinch/click handler wires here (e.g. from a raycast hit test in the app layer). */
  trigger(): void {
    for (const cb of this.callbacks) cb();
  }

  /**
   * Position at the right end of the in-XR HUD strip (src/render/hud.ts),
   * slightly nearer the camera than the strip so it never z-fights with it.
   */
  attachTo(camera: THREE.Camera): void {
    const x = HUD_WIDTH_M / 2 - MIC_MARGIN_M - MIC_SIZE / 2;
    const offset = new THREE.Vector3(x, HUD_VERTICAL_OFFSET_M, -HUD_DISTANCE_M + 0.002);
    offset.applyQuaternion(camera.quaternion);
    this.mesh.position.copy(camera.position).add(offset);
    this.mesh.quaternion.copy(camera.quaternion);
  }

  dispose(): void {
    this.texture.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.geometry.dispose();
  }
}
