/**
 * RoomAnchor: manages a single room-scale persistent WebXR anchor.
 *
 * On a real headset the reference space origin ('local-floor') is only
 * stable within one session - it can move between sessions and after
 * relocalization (see reality-editor-research-ledger.md: "anchors should be
 * within 3 m of the content they stabilize"). Persisting world poses
 * directly is therefore only correct for the session that produced them.
 * This module gives the app one stable frame of reference (the room anchor)
 * that persisted content can be expressed relative to (src/core/math.ts's
 * `toAnchorSpace`/`fromAnchorSpace`, src/core/snapshot-transform.ts).
 *
 * Everything here is feature-detected and never throws: `anchors` may be
 * fully unsupported (frame.createAnchor missing), or supported without
 * persistent handles (session.restorePersistentAnchor /
 * anchor.requestPersistentHandle missing - true of most current runtimes),
 * in which case the room gets a fresh (non-persistent) anchor every session
 * and callers fall back to identity-space persistence.
 */
import type { Pose } from '@/core/types';
import { ROOM_ANCHOR_ID } from '@/core/types';

function poseFromXRPose(xrPose: XRPose): Pose {
  const p = xrPose.transform.position;
  const o = xrPose.transform.orientation;
  return {
    position: { x: p.x, y: p.y, z: p.z },
    rotation: { x: o.x, y: o.y, z: o.z, w: o.w },
  };
}

function localStorageKey(persistKey: string): string {
  return `reality-editor:anchor:${persistKey}`;
}

export interface RoomAnchorOptions {
  /** When set, a successfully persistent-handled anchor is saved/restored under this key. */
  persistKey?: string;
}

export class RoomAnchor {
  readonly anchorId = ROOM_ANCHOR_ID;

  /** Populated with `anchorId` exactly when `localized` is true (see RuntimeConditions.localizedAnchors). */
  readonly localizedAnchors = new Set<string>();

  /** Latest anchor pose in the current reference space, or null if never localized. */
  anchorPose: Pose | null = null;

  /** True once the anchor's pose has been resolved at least once this session and is current. */
  localized = false;

  /** Time from the first XR frame this manager saw to first localization, or null if not yet localized. */
  relocalizationMs: number | null = null;

  /** True once a persistent handle for this anchor has been obtained (this session or a prior one). */
  hasPersistentHandle = false;

  private readonly storageKey: string | null;
  private anchor: XRAnchor | null = null;
  private acquireStarted = false;
  private sessionStartAt: number | null = null;
  private waiters: Array<() => void> = [];

  constructor(options: RoomAnchorOptions = {}) {
    this.storageKey = options.persistKey ? localStorageKey(options.persistKey) : null;
  }

  /**
   * Call once per rendered XR frame with the active frame/reference space
   * (and, when available, the session, needed for persistent-handle
   * lookups). No-ops outside an XR frame.
   */
  update(frame: XRFrame | undefined, refSpace: XRReferenceSpace | null, session?: XRSession | null): void {
    if (!frame || !refSpace) return;
    if (this.sessionStartAt === null) this.sessionStartAt = performance.now();

    if (!this.anchor && !this.acquireStarted) {
      this.acquireStarted = true;
      void this.acquireAnchor(frame, refSpace, session ?? null);
    }

    if (!this.anchor) return;

    let pose: XRPose | undefined;
    try {
      pose = frame.getPose(this.anchor.anchorSpace, refSpace);
    } catch {
      pose = undefined;
    }

    if (pose) {
      this.anchorPose = poseFromXRPose(pose);
      if (!this.localized) {
        this.localized = true;
        this.localizedAnchors.add(this.anchorId);
        this.relocalizationMs = this.sessionStartAt !== null ? performance.now() - this.sessionStartAt : null;
        this.resolveWaiters();
      }
    } else {
      // Anchor space temporarily unresolvable (tracking loss); the resolver's
      // anchor_lost rule should fire on edits until it comes back.
      this.localized = false;
      this.localizedAnchors.delete(this.anchorId);
    }
  }

  private async acquireAnchor(frame: XRFrame, refSpace: XRReferenceSpace, session: XRSession | null): Promise<void> {
    try {
      if (session && this.storageKey && typeof session.restorePersistentAnchor === 'function') {
        const savedHandle = this.readSavedHandle();
        if (savedHandle) {
          try {
            this.anchor = await session.restorePersistentAnchor(savedHandle);
            this.hasPersistentHandle = true;
            return;
          } catch {
            // Handle stale/unknown to this runtime (different room, cleared storage, ...);
            // fall through to creating a fresh anchor below.
          }
        }
      }

      if (typeof frame.createAnchor !== 'function') return;
      const anchor = await frame.createAnchor(new XRRigidTransform(), refSpace);
      this.anchor = anchor;

      if (session && this.storageKey && typeof anchor.requestPersistentHandle === 'function') {
        try {
          const handle = await anchor.requestPersistentHandle();
          this.saveHandle(handle);
          this.hasPersistentHandle = true;
        } catch {
          // Persistent handles unsupported on this runtime; the anchor still
          // works for the remainder of this session.
        }
      }
    } catch {
      // Anchors unsupported entirely, or the frame/session ended before the
      // promise settled. Leave this.anchor null; every getter degrades to
      // "not localized" and callers fall back to identity-space behaviour.
    }
  }

  private readSavedHandle(): string | null {
    if (!this.storageKey) return null;
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }

  private saveHandle(handle: string): void {
    if (!this.storageKey) return;
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(this.storageKey, handle);
    } catch {
      // Storage unavailable/full/quota-exceeded; not fatal.
    }
  }

  /** Resolves true once localized, or false after `timeoutMs` elapses. Never rejects. */
  waitForLocalization(timeoutMs: number): Promise<boolean> {
    if (this.localized) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      this.waiters.push(() => finish(true));
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  private resolveWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  dispose(): void {
    try {
      this.anchor?.delete();
    } catch {
      // Anchor may already be invalid/deleted.
    }
  }
}

export default RoomAnchor;
