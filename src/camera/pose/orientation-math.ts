/**
 * Pure math for turning `deviceorientation` angles into a world-frame
 * camera orientation. No DOM access here - runs under vitest node exactly
 * as it runs in the browser; `orientation.ts` is the thin DOM-facing wrapper
 * that feeds this module real event data.
 *
 * Derivation matches three.js's `DeviceOrientationControls` (the de facto
 * standard for this): build a quaternion from the device's alpha/beta/gamma
 * Euler angles (order 'YXZ'), rotate so the camera looks out the back of the
 * device rather than off its screen, then correct for the screen's current
 * rotation relative to the device.
 */
import type { Quat } from '@/core/types';
import { quatFromAxisAngle, quatMultiply, quatNormalize, quatRotateVec3 } from '@/core/math';

const DEG2RAD = Math.PI / 180;

/**
 * Quaternion for intrinsic Euler angles (x, y, z) applied in three.js's
 * 'YXZ' order convention (i.e. Euler.set(x, y, z, 'YXZ').toQuaternion()).
 * `@/core/math` has no generic Euler->Quat helper, so it lives here; it is
 * only ever used by `quatFromDeviceOrientation`.
 */
function quatFromEulerYXZ(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);

  return quatNormalize({
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  });
}

/** -90 degrees about +X: turns "device flat, screen up" into "camera looks out the back". */
const Q_LOOK_OUT_BACK: Quat = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);

/**
 * World-frame camera orientation for a raw `deviceorientation` reading.
 * `alphaDeg`/`betaDeg`/`gammaDeg` are the event's own fields; `screenOrientationDeg`
 * is `screen.orientation.angle` (or the legacy `window.orientation`), degrees.
 */
export function quatFromDeviceOrientation(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenOrientationDeg: number,
): Quat {
  const alpha = alphaDeg * DEG2RAD;
  const beta = betaDeg * DEG2RAD;
  const gamma = gammaDeg * DEG2RAD;
  const orient = screenOrientationDeg * DEG2RAD;

  let q = quatFromEulerYXZ(beta, alpha, -gamma); // 'YXZ' order: euler.set(beta, alpha, -gamma)
  q = quatMultiply(q, Q_LOOK_OUT_BACK);
  q = quatMultiply(q, quatFromAxisAngle({ x: 0, y: 0, z: 1 }, -orient));
  return quatNormalize(q);
}

/**
 * Heading (radians) about +Y of the camera's forward (-Z local) vector, with
 * 0 meaning "forward is exactly -Z" (matches `removeYaw`'s target).
 */
export function yawOf(q: Quat): number {
  const forward = quatRotateVec3(q, { x: 0, y: 0, z: -1 });
  return Math.atan2(-forward.x, -forward.z);
}

/**
 * Pre-rotate `q` about +Y by `-yawRad` so that a quaternion whose heading is
 * `yawRad` (as `yawOf` measures it) maps back to a -Z heading. Used to fix
 * "wherever the phone happened to be pointed at start" as the forward
 * direction.
 */
export function removeYaw(q: Quat, yawRad: number): Quat {
  const undoYaw = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, -yawRad);
  return quatNormalize(quatMultiply(undoYaw, q));
}
