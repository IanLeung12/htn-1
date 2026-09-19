/**
 * Palm-up hand menu, attached to the left hand's wrist joint, plus a small
 * MicButton. Both are canvas-textured three.js quads (cheap, consistent with
 * src/render/hud.ts).
 *
 * The menu shows only while the left palm faces the head
 * (dot(palmNormal, toHead) > 0.6) and is selected either by poking within
 * ~2cm with the right index tip, or by pinching while the right hand's ray
 * hits a button. `update()` runs every rendered frame and only touches
 * pre-allocated temporaries - no per-frame allocation.
 */
import * as THREE from 'three';
import type { HandState, InputState } from '@/xr/input';

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
const POKE_DIST_M = 0.02;
const BUTTON_W = 0.045;
const BUTTON_H = 0.02;
const GAP = 0.006;
const COLUMNS = 2;

interface ButtonEntry {
  def: ButtonDef;
  mesh: THREE.Mesh;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  pressed: boolean;
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

      const entry: ButtonEntry = { def, mesh, ctx, texture, pressed: false };
      this.drawButton(entry, false);
      this.buttons.push(entry);
    });

    // Palm-facing quads work best angled slightly toward where a raised palm
    // would present them; simplest default keeps the menu flat on the wrist.
    this.group.visible = false;
  }

  private drawButton(entry: ButtonEntry, active: boolean): void {
    const { ctx } = entry;
    const { width, height } = ctx.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = active ? 'rgba(70,150,255,0.92)' : 'rgba(20,20,20,0.78)';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, width - 2, height - 2);
    ctx.fillStyle = '#fff';
    ctx.font = '22px sans-serif';
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
      for (const btn of this.buttons) this.setPressed(btn, false);
      return;
    }

    const pinchRayActive = right.pinching;

    for (const btn of this.buttons) {
      btn.mesh.getWorldPosition(this.tmpButtonWorldPos);
      this.tmpDelta.copy(right.position).sub(this.tmpButtonWorldPos);
      const poking = this.tmpDelta.length() < POKE_DIST_M;
      const pinchHit = pinchRayActive && this.rayHitsButton(right, btn.mesh);
      this.setPressed(btn, poking || pinchHit);
    }
  }

  private rayHitsButton(hand: HandState, mesh: THREE.Mesh): boolean {
    this.raycaster.set(hand.ray.origin, hand.ray.direction);
    return this.raycaster.intersectObject(mesh, false).length > 0;
  }

  private setPressed(entry: ButtonEntry, pressed: boolean): void {
    if (entry.pressed === pressed) return;
    entry.pressed = pressed;
    this.drawButton(entry, pressed);
    if (pressed) this.emit(entry.def.action);
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

const MIC_SIZE = 0.045;

/** Small camera-attached mic toggle button with a visual listening state. */
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
    ctx.arc(width / 2, height / 2, width / 2 - 3, 0, Math.PI * 2);
    ctx.fillStyle = this.listeningState ? 'rgba(255,70,70,0.92)' : 'rgba(50,50,50,0.85)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MIC', width / 2, height / 2);
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

  /** Position bottom-right of the given camera, mirroring InXRHud's placement. */
  attachTo(camera: THREE.Camera): void {
    const offset = new THREE.Vector3(0.14, -0.09, -0.3);
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
