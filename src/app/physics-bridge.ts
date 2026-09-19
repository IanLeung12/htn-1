/**
 * Wires the pure proxy physics simulation (src/core/physics.ts) into the app:
 * runs it against the store's current snapshot each frame and commits any
 * resulting moves back through the store as system-sourced intents. Physics
 * itself never touches the store (see src/core/physics.ts); this is the only
 * place that does.
 *
 * Not wired into src/app/main.ts by this change (another agent owns that
 * file). To enable it, main.ts needs two lines:
 *
 *   const physics = createProxyPhysics();
 *   const physicsBridge = createPhysicsBridge(store, physics, conditions);
 *
 * ...and, inside the animation loop (after `const cond = conditions();`):
 *
 *   physicsBridge.update(now);
 */
import type { SceneStore } from '@/core/api';
import type { ProxyPhysics } from '@/core/physics';
import type { RuntimeConditions } from '@/core/types';

export interface PhysicsBridge {
  /** Call once per rendered frame with the current monotonic clock (e.g. performance.now()). */
  update(now: number): void;
}

export function createPhysicsBridge(
  store: SceneStore,
  physics: ProxyPhysics,
  conditions: () => RuntimeConditions,
): PhysicsBridge {
  let lastTime: number | null = null;

  return {
    update(now: number): void {
      const dtMs = lastTime === null ? 0 : now - lastTime;
      lastTime = now;
      if (dtMs <= 0) return;

      const result = physics.step(store.current, dtMs, now);
      for (const move of result.moves) {
        store.dispatch(
          {
            intent: { kind: 'move', objectId: move.objectId, pose: move.pose },
            source: 'system',
            issuedAt: now,
            basedOnVersion: store.current.version,
          },
          conditions(),
        );
      }
    },
  };
}

export default createPhysicsBridge;
