/**
 * Latest-coherent-value bus for asynchronous subsystems (PCA, depth,
 * hand pose, etc). Consumers read the newest stamped value and can check
 * staleness/version compatibility before trusting it.
 */
import type { Millis, Stamped, Subsystem } from './types';
import type { FreshnessBus } from './api';

export function createFreshnessBus(): FreshnessBus {
  const latestBySubsystem = new Map<Subsystem, Stamped<unknown>>();

  return {
    publish<T>(subsystem: Subsystem, stamped: Stamped<T>): void {
      const existing = latestBySubsystem.get(subsystem);
      // Keep only the newest by timestamp; out-of-order publishes are ignored.
      if (!existing || stamped.timestamp >= existing.timestamp) {
        latestBySubsystem.set(subsystem, stamped);
      }
    },

    latest<T>(subsystem: Subsystem): Stamped<T> | undefined {
      return latestBySubsystem.get(subsystem) as Stamped<T> | undefined;
    },

    age(subsystem: Subsystem, now: Millis): number {
      const v = latestBySubsystem.get(subsystem);
      if (!v) return Infinity;
      return now - v.timestamp;
    },

    isFresh(subsystem: Subsystem, now: Millis, maxAgeMs: number, minVersion?: number): boolean {
      const v = latestBySubsystem.get(subsystem);
      if (!v) return false;
      const age = now - v.timestamp;
      if (age > maxAgeMs) return false;
      if (minVersion !== undefined && v.sceneVersion < minVersion) return false;
      return true;
    },
  };
}

export default createFreshnessBus;
