/**
 * Deterministic voice grammar. Pure TypeScript - no DOM, no three.js, no
 * speech APIs. Parses a transcript against the current SceneSnapshot into a
 * VoiceCommand: a discriminated union that maps 1:1 onto store `Intent`s or
 * a small set of app-level actions (spawn/select/list/explain/capture).
 *
 * Per reality-editor-canonical-architecture.md, voice is a convenience layer
 * over the same deterministic resolver: this module never mutates a
 * transform itself. Where a command implies an Intent (move/delete/restore/
 * undo/redo/setMode), the resulting VoiceCommand carries a ready-to-dispatch
 * `pose`/payload but the actual mutation still goes through
 * `store.dispatch()` -> the resolver in src/app/voice.ts, which is what
 * enforces tier/coverage/envelope checks (reality-editor-capture-and-
 * editability.md: voice cannot override a Tier E result).
 */
import type { EditableObject, Pose, SceneSnapshot, Surface, VisualMode } from '@/core/types';
import { add, distance, normalize, quatRotateVec3, scale } from '@/core/math';
import { findCatalogEntry } from './catalog';

export type MoveDirection = 'left' | 'right' | 'forward' | 'back' | 'up' | 'down';

export type VoiceCommand =
  | { kind: 'delete'; objectId: string; label: string }
  | { kind: 'restore'; objectId: string; label: string }
  | { kind: 'move'; objectId: string; label: string; direction: MoveDirection; distanceM: number; pose: Pose }
  | { kind: 'placeOn'; objectId: string; label: string; surfaceId: string; surfaceLabel: string; pose: Pose }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'spawn'; shape: 'cube' | 'sphere' }
  | { kind: 'spawnAsset'; entryId: string; label: string }
  | { kind: 'select'; objectId: string; label: string }
  | { kind: 'setMode'; mode: VisualMode }
  | { kind: 'listEditable' }
  | { kind: 'explainLast' }
  | { kind: 'captureCleanPlate'; objectId: string; label: string };

export interface VoiceContext {
  /** Currently selected object id, if any - used as a tiebreaker for ambiguous names. */
  selectedId?: string;
  /** Current head pose, used for direction vectors and nearest-object disambiguation. */
  headPose: Pose;
}

const DEFAULT_MOVE_DISTANCE_M = 0.2;

const ARTICLES = new Set(['a', 'an', 'the']);

const ORDINALS: Record<string, number> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  sixth: 5,
  seventh: 6,
  eighth: 7,
  ninth: 8,
  tenth: 9,
  '1st': 0,
  '2nd': 1,
  '3rd': 2,
  '4th': 3,
  '5th': 4,
};

const UNIT_METERS: Record<string, number> = {
  cm: 0.01,
  centimeter: 0.01,
  centimeters: 0.01,
  m: 1,
  meter: 1,
  meters: 1,
  inch: 0.0254,
  inches: 0.0254,
};

function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  return text.split(' ').filter(Boolean);
}

function stripArticles(tokens: string[]): string[] {
  return tokens.filter((t) => !ARTICLES.has(t));
}

/** Prefix/contains/exact scoring against a single candidate string. Higher is better; 0 = no match. */
function scoreName(query: string, candidate: string): number {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (!q || !c) return 0;
  if (c === q) return 3;
  if (c.startsWith(q)) return 2;
  if (c.includes(q)) return 1;
  return 0;
}

interface ScoredObject {
  object: EditableObject;
  rank: number;
  distance: number;
}

/**
 * Find objects whose userName or semantic label fuzzy-matches `rawQuery`
 * (case-insensitive, articles ignored, optional leading ordinal like
 * "second table"). Results are ranked by name-match quality, then by
 * distance from the head (nearest first) - "preferring the nearest object to
 * the head when ambiguous".
 */
export function findObjectsByName(
  snapshot: SceneSnapshot,
  rawQuery: string,
  headPose: Pose,
  opts: { includeHidden?: boolean } = {},
): EditableObject[] {
  let tokens = stripArticles(tokenize(normalizeText(rawQuery)));
  let ordinalIndex: number | undefined;
  const firstToken = tokens[0];
  if (tokens.length > 1 && firstToken !== undefined && firstToken in ORDINALS) {
    ordinalIndex = ORDINALS[firstToken];
    tokens = tokens.slice(1);
  }
  const query = tokens.join(' ');
  if (!query) return [];

  const pool = Object.values(snapshot.objects).filter((o) => opts.includeHidden || o.visible);

  const scored: ScoredObject[] = pool
    .map((object) => ({
      object,
      rank: Math.max(scoreName(query, object.userName), scoreName(query, object.label)),
      distance: distance(object.currentPose.position, headPose.position),
    }))
    .filter((m) => m.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.distance - b.distance);

  if (scored.length === 0) return [];

  if (ordinalIndex !== undefined) {
    const byDistance = [...scored].sort((a, b) => a.distance - b.distance);
    const picked = byDistance[ordinalIndex];
    return picked ? [picked.object] : [];
  }

  return scored.map((m) => m.object);
}

/** Resolve a single target, preferring the currently selected object when it matches. */
function resolveTarget(
  snapshot: SceneSnapshot,
  rawQuery: string,
  context: VoiceContext,
  includeHidden = false,
): EditableObject | null {
  const matches = findObjectsByName(snapshot, rawQuery, context.headPose, { includeHidden });
  if (matches.length === 0) return null;
  if (context.selectedId) {
    const selected = matches.find((m) => m.id === context.selectedId);
    if (selected) return selected;
  }
  return matches[0] ?? null;
}

function findSurfaceByName(snapshot: SceneSnapshot, rawQuery: string, headPose: Pose): Surface | null {
  const tokens = stripArticles(tokenize(normalizeText(rawQuery)));
  const query = tokens.join(' ');
  if (!query) return null;

  const center = (s: Surface) => ({
    x: (s.aabb.min.x + s.aabb.max.x) / 2,
    y: s.aabb.max.y,
    z: (s.aabb.min.z + s.aabb.max.z) / 2,
  });

  const scored = Object.values(snapshot.surfaces)
    .map((s) => ({ surface: s, rank: scoreName(query, s.label), distance: distance(center(s), headPose.position) }))
    .filter((m) => m.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.distance - b.distance);

  return scored[0]?.surface ?? null;
}

function directionVector(direction: MoveDirection, headPose: Pose): { x: number; y: number; z: number } {
  switch (direction) {
    case 'up':
      return { x: 0, y: 1, z: 0 };
    case 'down':
      return { x: 0, y: -1, z: 0 };
    case 'forward': {
      const f = quatRotateVec3(headPose.rotation, { x: 0, y: 0, z: -1 });
      return normalize({ x: f.x, y: 0, z: f.z });
    }
    case 'back': {
      const f = quatRotateVec3(headPose.rotation, { x: 0, y: 0, z: -1 });
      return normalize({ x: -f.x, y: 0, z: -f.z });
    }
    case 'right': {
      const r = quatRotateVec3(headPose.rotation, { x: 1, y: 0, z: 0 });
      return normalize({ x: r.x, y: 0, z: r.z });
    }
    case 'left': {
      const r = quatRotateVec3(headPose.rotation, { x: 1, y: 0, z: 0 });
      return normalize({ x: -r.x, y: 0, z: -r.z });
    }
    default: {
      const exhaustive: never = direction;
      return exhaustive;
    }
  }
}

/**
 * Parse one utterance against the current snapshot/context. Returns `null`
 * when the text does not match any known pattern, or when a referenced
 * object/surface name cannot be resolved - the caller (src/app/voice.ts)
 * treats both cases as "unrecognized" and can offer feedback.
 */
export function parseCommand(text: string, snapshot: SceneSnapshot, context: VoiceContext): VoiceCommand | null {
  const norm = normalizeText(text);
  if (!norm) return null;

  if (norm === 'undo') return { kind: 'undo' };
  if (norm === 'redo') return { kind: 'redo' };
  if (/^what can i edit\??$/.test(norm) || /^list( the)? editable objects?$/.test(norm)) {
    return { kind: 'listEditable' };
  }
  if (norm === 'why' || /^why (did that fail|not|was that rejected)\??$/.test(norm)) {
    return { kind: 'explainLast' };
  }

  let m: RegExpMatchArray | null;

  m = norm.match(/^(?:spawn|add|create)(?: a| an)? (cube|sphere)$/);
  if (m) return { kind: 'spawn', shape: m[1] as 'cube' | 'sphere' };

  // Catalog assets: "spawn/add/create/put a <catalog name>" - checked before
  // the generic move/place patterns below so e.g. "put a chair" spawns a new
  // chair, while "put the chair on the table" (an existing object) still
  // falls through to the placeOn pattern (findCatalogEntry requires an
  // exact/alias/unique-prefix match against the *whole* remaining phrase, so
  // "chair on the table" does not match the "chair" entry).
  m = norm.match(/^(?:spawn|add|create|put)(?: a| an| the)? (.+)$/);
  if (m) {
    const entry = findCatalogEntry(m[1] ?? '');
    if (entry) return { kind: 'spawnAsset', entryId: entry.id, label: entry.name };
  }

  m = norm.match(/^(show|hide) the room$/);
  if (m) {
    const mode: VisualMode = m[1] === 'show' ? 'captured-shell' : 'live-overlay';
    return { kind: 'setMode', mode };
  }

  m = norm.match(/^(?:delete|remove|hide) (?:the )?(.+)$/);
  if (m) {
    const target = resolveTarget(snapshot, m[1] ?? '', context);
    if (!target) return null;
    return { kind: 'delete', objectId: target.id, label: target.userName };
  }

  m = norm.match(/^(?:restore|bring back) (?:the )?(.+)$/);
  if (m) {
    const target = resolveTarget(snapshot, m[1] ?? '', context, true);
    if (!target) return null;
    return { kind: 'restore', objectId: target.id, label: target.userName };
  }

  m = norm.match(/^capture (?:the )?(.+)$/);
  if (m) {
    const target = resolveTarget(snapshot, m[1] ?? '', context, true);
    if (!target) return null;
    return { kind: 'captureCleanPlate', objectId: target.id, label: target.userName };
  }

  m = norm.match(/^select (?:the )?(.+)$/);
  if (m) {
    const target = resolveTarget(snapshot, m[1] ?? '', context, true);
    if (!target) return null;
    return { kind: 'select', objectId: target.id, label: target.userName };
  }

  m = norm.match(
    /^move (?:the )?(.+?) (left|right|forward|back|up|down)(?: (\d+(?:\.\d+)?) ?(cm|centimeters?|meters?|inches?))?$/,
  );
  if (m) {
    const [, nameQuery, dirRaw, amountStr, unitRaw] = m;
    const target = resolveTarget(snapshot, nameQuery ?? '', context);
    if (!target) return null;
    const direction = dirRaw as MoveDirection;
    let distanceM = DEFAULT_MOVE_DISTANCE_M;
    if (amountStr && unitRaw) {
      const unitKey = unitRaw.replace(/s$/, '');
      const unitMeters = UNIT_METERS[unitRaw] ?? UNIT_METERS[unitKey] ?? 1;
      distanceM = parseFloat(amountStr) * unitMeters;
    }
    const dirVec = directionVector(direction, context.headPose);
    const position = add(target.currentPose.position, scale(dirVec, distanceM));
    const pose: Pose = { position, rotation: target.currentPose.rotation };
    return { kind: 'move', objectId: target.id, label: target.userName, direction, distanceM, pose };
  }

  m = norm.match(/^(?:put|place) (?:the )?(.+?) on (?:the )?(.+)$/);
  if (m) {
    const [, nameQuery, surfaceQuery] = m;
    const target = resolveTarget(snapshot, nameQuery ?? '', context);
    if (!target) return null;
    const surface = findSurfaceByName(snapshot, surfaceQuery ?? '', context.headPose);
    if (!surface) return null;
    const position = {
      x: (surface.aabb.min.x + surface.aabb.max.x) / 2,
      y: surface.aabb.max.y,
      z: (surface.aabb.min.z + surface.aabb.max.z) / 2,
    };
    const pose: Pose = { position, rotation: target.currentPose.rotation };
    return {
      kind: 'placeOn',
      objectId: target.id,
      label: target.userName,
      surfaceId: surface.id,
      surfaceLabel: surface.label,
      pose,
    };
  }

  return null;
}

export default parseCommand;
