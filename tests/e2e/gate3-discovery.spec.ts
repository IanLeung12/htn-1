/**
 * Gate C (editable object): candidate discovery must propose at least one plausible
 * editable object from the room, and approval must be a first-class, auditable
 * transaction (source 'test' here stands in for the UI/voice path) - see
 * reality-editor-research-ledger.md "Go / no-go gates" > Gate C.
 */
import { test, expect } from './fixtures';

test('runCandidateDiscovery proposes at least one physical candidate', async ({ evalApp }) => {
  // Give scene-understanding a few frames to pick up SEM's planes/meshes first.
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const ids = await evalApp(() => window.__realityEditor!.runCandidateDiscovery());
  expect(ids.length).toBeGreaterThanOrEqual(1);

  const labels = await evalApp(
    (candidateIds) => candidateIds.map((id) => window.__realityEditor!.store.current.objects[id]?.label),
    ids,
  );
  expect(labels.length).toBe(ids.length);
});

test('approving a candidate is a dispatched, auditable intent', async ({ evalApp }) => {
  await expect
    .poll(async () => evalApp(() => Object.keys(window.__realityEditor!.store.current.surfaces).length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const ids = await evalApp(() => window.__realityEditor!.runCandidateDiscovery());
  expect(ids.length).toBeGreaterThanOrEqual(1);
  const objectId = ids[0]!;

  const label = await evalApp((id: string) => window.__realityEditor!.store.current.objects[id]?.label, objectId);
  expect(['table', 'desk', 'shelf', 'couch', 'bed', 'storage', 'lamp', 'plant', 'screen', 'other']).toContain(label);

  const result = await evalApp(
    (id: string) => window.__testHelpers!.dispatchIntent({ kind: 'approve', objectId: id, approved: true }, 'test'),
    objectId,
  );
  expect(result.ok).toBe(true);

  const approved = await evalApp((id: string) => window.__realityEditor!.store.current.objects[id]?.approved, objectId);
  expect(approved).toBe(true);
});
