/**
 * Persistent surface registry: RANSAC output flickers run to run (a bed top
 * is a table in one run and missing in the next, its box jitters by
 * centimetres). Physics and `surfaceBelow` need a STABLE support, so the
 * app never registers raw estimates; it feeds them through this registry,
 * which matches incoming surfaces to remembered ones by geometry (same
 * orientation, height within `matchHeightM`, overlapping XZ boxes),
 * smooths their boxes with an EMA, keeps them alive for `keepAliveMs`
 * after they stop being detected, and only reports a change to the store
 * when a smoothed box moved by more than `changeEpsM`. Pure TS.
 */
import type { Aabb, Millis, Surface } from '@/core/types';
import type { EstimatedSurface } from '../contract';

export interface SurfaceRegistryOptions {
  keepAliveMs?: number;
  /** EMA weight of the NEW observation (0..1). */
  smoothing?: number;
  matchHeightM?: number;
  changeEpsM?: number;
  /** Observations needed before a new surface is published (debounces one-run ghosts). */
  minObservations?: number;
}

export interface RegistryDelta {
  register: Surface[];
  remove: string[];
}

interface Entry {
  surface: Surface;
  confidence: number;
  lastSeen: Millis;
  observations: number;
  published: boolean;
  /** Box last handed to the store, to gate re-registration. */
  publishedAabb: Aabb | null;
}

function xzOverlap(a: Aabb, b: Aabb): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

function yzOverlapVertical(a: Aabb, b: Aabb): boolean {
  // Walls: same orientation band, boxes overlapping in XZ (they are thin) and Y.
  return xzOverlap(a, b) && a.min.y <= b.max.y && a.max.y >= b.min.y;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothAabb(prev: Aabb, next: Aabb, t: number): Aabb {
  return {
    min: { x: lerp(prev.min.x, next.min.x, t), y: lerp(prev.min.y, next.min.y, t), z: lerp(prev.min.z, next.min.z, t) },
    max: { x: lerp(prev.max.x, next.max.x, t), y: lerp(prev.max.y, next.max.y, t), z: lerp(prev.max.z, next.max.z, t) },
  };
}

function maxDelta(a: Aabb, b: Aabb): number {
  return Math.max(
    Math.abs(a.min.x - b.min.x), Math.abs(a.min.y - b.min.y), Math.abs(a.min.z - b.min.z),
    Math.abs(a.max.x - b.max.x), Math.abs(a.max.y - b.max.y), Math.abs(a.max.z - b.max.z),
  );
}

/** Rebuild pose/polygon from a (smoothed) aabb for horizontal surfaces; walls keep the centre. */
function surfaceFromAabb(base: Surface, aabb: Aabb, now: Millis): Surface {
  const cx = (aabb.min.x + aabb.max.x) / 2;
  const cz = (aabb.min.z + aabb.max.z) / 2;
  const cy = base.orientation === 'horizontal' ? (aabb.min.y + aabb.max.y) / 2 : (aabb.min.y + aabb.max.y) / 2;
  const halfX = (aabb.max.x - aabb.min.x) / 2;
  const halfZ = (aabb.max.z - aabb.min.z) / 2;
  return {
    ...base,
    pose: { position: { x: cx, y: cy, z: cz }, rotation: base.pose.rotation },
    polygon: base.orientation === 'horizontal'
      ? [{ x: -halfX, z: -halfZ }, { x: halfX, z: -halfZ }, { x: halfX, z: halfZ }, { x: -halfX, z: halfZ }]
      : base.polygon,
    aabb,
    lastChanged: now,
  };
}

export class SurfaceRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly keepAliveMs: number;
  private readonly smoothing: number;
  private readonly matchHeightM: number;
  private readonly changeEpsM: number;
  private readonly minObservations: number;
  private nextId = 0;

  constructor(opts: SurfaceRegistryOptions = {}) {
    this.keepAliveMs = opts.keepAliveMs ?? 6000;
    this.smoothing = opts.smoothing ?? 0.3;
    this.matchHeightM = opts.matchHeightM ?? 0.12;
    this.changeEpsM = opts.changeEpsM ?? 0.02;
    this.minObservations = opts.minObservations ?? 2;
  }

  /** Surfaces currently alive (published or pending). */
  get surfaces(): Surface[] {
    return [...this.entries.values()].filter((e) => e.published).map((e) => e.surface);
  }

  private match(incoming: Surface): Entry | undefined {
    let best: Entry | undefined;
    let bestScore = -Infinity;
    for (const entry of this.entries.values()) {
      const s = entry.surface;
      if (s.orientation !== incoming.orientation) continue;
      if (s.label === 'floor' || incoming.label === 'floor') {
        if (s.label === incoming.label) return entry; // the single ground surface
        continue;
      }
      if (incoming.orientation === 'horizontal') {
        if (Math.abs(s.pose.position.y - incoming.pose.position.y) > this.matchHeightM) continue;
        if (!xzOverlap(s.aabb, incoming.aabb)) continue;
      } else if (!yzOverlapVertical(s.aabb, incoming.aabb)) {
        continue;
      }
      const score = -Math.abs(s.pose.position.y - incoming.pose.position.y) - 0.1 * Math.hypot(s.pose.position.x - incoming.pose.position.x, s.pose.position.z - incoming.pose.position.z);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best;
  }

  /**
   * Feed one estimator run. Returns the surfaces the store should
   * (re)register and the ids it should remove. Ids are the registry's own
   * (stable across runs), except the ground surface which keeps its id.
   */
  ingest(estimated: readonly EstimatedSurface[], now: Millis): RegistryDelta {
    const register: Surface[] = [];
    const remove: string[] = [];
    const seen = new Set<Entry>();

    for (const est of estimated) {
      const incoming = est.surface;
      let entry = this.match(incoming);
      if (entry && seen.has(entry)) entry = undefined; // one match per run
      if (!entry) {
        const id = incoming.label === 'floor' ? incoming.id : `${incoming.orientation === 'vertical' ? 'wall' : 'surface'}-${this.nextId++}`;
        entry = {
          surface: { ...incoming, id, lastChanged: now },
          confidence: est.confidence,
          lastSeen: now,
          observations: 1,
          published: false,
          publishedAabb: null,
        };
        this.entries.set(id, entry);
      } else {
        entry.observations += 1;
        entry.lastSeen = now;
        entry.confidence = lerp(entry.confidence, est.confidence, this.smoothing);
        if (incoming.label !== 'floor') {
          const smoothed = smoothAabb(entry.surface.aabb, incoming.aabb, this.smoothing);
          entry.surface = surfaceFromAabb({ ...entry.surface, label: incoming.label }, smoothed, entry.surface.lastChanged);
        } else if (incoming.lastChanged !== entry.surface.lastChanged) {
          entry.surface = { ...incoming, id: entry.surface.id };
        }
      }
      seen.add(entry);

      const ready = entry.observations >= this.minObservations || incoming.label === 'floor';
      if (!ready) continue;
      const moved = !entry.publishedAabb || maxDelta(entry.publishedAabb, entry.surface.aabb) > this.changeEpsM;
      if (!entry.published || moved) {
        entry.surface = { ...entry.surface, lastChanged: now };
        entry.published = true;
        entry.publishedAabb = entry.surface.aabb;
        register.push(entry.surface);
      }
    }

    for (const [id, entry] of this.entries) {
      if (seen.has(entry)) continue;
      if (entry.surface.label === 'floor') continue; // the ground never expires
      if (now - entry.lastSeen < this.keepAliveMs) continue;
      this.entries.delete(id);
      if (entry.published) remove.push(id);
    }

    return { register, remove };
  }
}
