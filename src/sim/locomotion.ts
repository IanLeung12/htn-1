/**
 * Keyboard/mouse locomotion for a human driving the simulator.
 *
 * Meta's DevUI maps WASD/arrows to controller thumbsticks and does not move the
 * headset, so this module moves the emulated head directly:
 *   W/A/S/D  walk on the horizontal plane (relative to head yaw)
 *   -  / =   lower / raise the head
 *   Shift + mouse move, or right-mouse drag   look around (yaw + pitch)
 * Keys are ignored while typing in an input/textarea.
 */
import type { XRDevice } from 'iwer';

const WALK_MPS = 1.4;
const CLIMB_MPS = 0.8;
const LOOK_RAD_PER_PX = 0.0035;
const MAX_PITCH = Math.PI / 2 - 0.05;

export function installLocomotion(xrDevice: XRDevice): () => void {
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let lookDrag = false;
  let lastT = performance.now();
  let raf = 0;

  // Seed yaw/pitch from the current quaternion (YXZ order).
  const q = xrDevice.quaternion;
  const sinp = 2 * (q.w * q.x - q.y * q.z);
  pitch = Math.asin(Math.max(-1, Math.min(1, sinp)));
  yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));

  const isTyping = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e)) return;
    keys.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code);
  };
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 2) lookDrag = true;
  };
  const onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) lookDrag = false;
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!(lookDrag || e.shiftKey)) return;
    yaw -= e.movementX * LOOK_RAD_PER_PX;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch - e.movementY * LOOK_RAD_PER_PX));
    applyRotation();
  };
  const onContextMenu = (e: MouseEvent): void => {
    if (lookDrag) e.preventDefault();
  };

  function applyRotation(): void {
    // YXZ: yaw about world Y, then pitch about local X.
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    const cp = Math.cos(pitch / 2);
    const sp = Math.sin(pitch / 2);
    xrDevice.quaternion.set(sp * cy, cp * sy, -sp * sy, cp * cy);
  }

  function tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    let fwd = 0;
    let side = 0;
    let up = 0;
    if (keys.has('KeyW')) fwd += 1;
    if (keys.has('KeyS')) fwd -= 1;
    if (keys.has('KeyD')) side += 1;
    if (keys.has('KeyA')) side -= 1;
    if (keys.has('Equal')) up += 1;
    if (keys.has('Minus')) up -= 1;
    if (fwd !== 0 || side !== 0 || up !== 0) {
      const p = xrDevice.position;
      // Forward is -Z rotated by yaw.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      const step = WALK_MPS * dt;
      p.set(
        p.x + (fx * fwd + rx * side) * step,
        Math.max(0.3, p.y + up * CLIMB_MPS * dt),
        p.z + (fz * fwd + rz * side) * step,
      );
    }
    raf = requestAnimationFrame(tick);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('contextmenu', onContextMenu);
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('contextmenu', onContextMenu);
  };
}
