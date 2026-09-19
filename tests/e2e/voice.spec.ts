/**
 * Voice command layer e2e: exercises src/app/voice.ts + src/app/voice-grammar.ts
 * end to end through `window.__realityEditor.voice.submitText`, the same entry
 * point the mic button and SpeechRecognition results use (see src/app/voice.ts).
 *
 * Per reality-editor-canonical-architecture.md ("Interaction transaction"),
 * voice is a convenience layer over the same deterministic resolver: every
 * mutating command here goes through `store.dispatch()`, so a Tier E object
 * is rejected exactly as it would be for a hand/controller/UI intent (see
 * reality-editor-capture-and-editability.md and tests/e2e/gate4-cleanplate-edit.spec.ts
 * for the equivalent non-voice assertion).
 *
 * `voice` is optional on AppHandle until src/app/main.ts is wired up with
 * `installVoiceAndMenu` (see src/app/voice-install.ts); every test here is
 * skipped until then so the suite stays green in the interim.
 *
 * Note: every `evalApp` callback below is self-contained (Playwright
 * serializes and re-runs it inside the browser context), so the
 * `voice.submitText` cast is repeated inline rather than factored into a
 * shared Node-side helper.
 */
import { test, expect } from './fixtures';

/** submitText's real return type is VoiceCommandResult (src/app/voice.ts); the
 * AppHandle contract only promises `void` so main.ts's field stays simple. */
type SubmitTextResult = { status: 'ok' | 'rejected' | 'unrecognized'; message?: string; explanation?: string };

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

test.beforeEach(async ({ evalApp }) => {
  const hasVoice = await evalApp(() => Boolean(window.__realityEditor?.voice));
  test.skip(!hasVoice, 'voice layer not wired into main.ts yet (see src/app/voice-install.ts)');
});

test('move the cube up 20 cm raises its y position by 0.2', async ({ evalApp }) => {
  const cubeId = await evalApp(
    (rotation) =>
      window.__testHelpers!.spawnTestObject(
        { position: { x: 0, y: 1, z: -1 }, rotation },
        { id: 'voice-cube', userName: 'Cube', label: 'other' },
      ),
    IDENTITY,
  );

  const before = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.currentPose.position.y, cubeId);

  await evalApp((text) => {
    const voice = window.__realityEditor!.voice as unknown as { submitText(t: string): SubmitTextResult };
    return voice.submitText(text);
  }, 'move the cube up 20 cm');

  const after = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.currentPose.position.y, cubeId);
  expect(after - before).toBeCloseTo(0.2, 3);
});

test('delete the cube hides it, and undo restores it', async ({ evalApp }) => {
  const cubeId = await evalApp(
    (rotation) =>
      window.__testHelpers!.spawnTestObject(
        { position: { x: 0, y: 1, z: -1 }, rotation },
        { id: 'voice-cube-2', userName: 'Cube', label: 'other' },
      ),
    IDENTITY,
  );

  await evalApp((text) => {
    const voice = window.__realityEditor!.voice as unknown as { submitText(t: string): SubmitTextResult };
    return voice.submitText(text);
  }, 'delete the cube');
  const afterDelete = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.visible, cubeId);
  expect(afterDelete).toBe(false);

  await evalApp((text) => {
    const voice = window.__realityEditor!.voice as unknown as { submitText(t: string): SubmitTextResult };
    return voice.submitText(text);
  }, 'undo');
  const afterUndo = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.visible, cubeId);
  expect(afterUndo).toBe(true);
});

test('delete the table is rejected for a tier E physical object and explains why', async ({ evalApp }) => {
  const tableId = await evalApp(
    (rotation) =>
      window.__testHelpers!.spawnTestObject(
        { position: { x: 2, y: 0.4, z: -2 }, rotation },
        {
          id: 'voice-table-e',
          userName: 'Table',
          label: 'table',
          origin: 'physical',
          tier: 'E',
          background: [],
        },
      ),
    IDENTITY,
  );

  const visibleBefore = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.visible, tableId);
  expect(visibleBefore).toBe(true);

  const deleteResult = await evalApp((text) => {
    const voice = window.__realityEditor!.voice as unknown as { submitText(t: string): SubmitTextResult };
    return voice.submitText(text);
  }, 'delete the table');
  expect(deleteResult.status).toBe('rejected');
  expect(`${deleteResult.explanation ?? ''}`.toLowerCase()).toMatch(/tier e|recapture/);

  const visibleAfter = await evalApp((id) => window.__realityEditor!.store.current.objects[id]!.visible, tableId);
  expect(visibleAfter).toBe(true); // Tier E: delete must be refused, not just "no evidence".

  // "why" surfaces the same explanation the HUD shows via InteractionController.lastRejection.
  const why = await evalApp((text) => {
    const voice = window.__realityEditor!.voice as unknown as { submitText(t: string): SubmitTextResult };
    return voice.submitText(text);
  }, 'why');
  expect(why.status).toBe('ok');
  expect(`${why.message ?? ''}`.toLowerCase()).toMatch(/tier e|recapture/);
});

test('what can I edit lists the spawned cube', async ({ evalApp }) => {
  await evalApp(
    (rotation) =>
      window.__testHelpers!.spawnTestObject(
        { position: { x: 0, y: 1, z: -1 }, rotation },
        { id: 'voice-cube-3', userName: 'Cube', label: 'other' },
      ),
    IDENTITY,
  );

  const result = await evalApp((text) => {
    const voice = window.__realityEditor!.voice as unknown as { submitText(t: string): SubmitTextResult };
    return voice.submitText(text);
  }, 'what can I edit');
  expect(result.status).toBe('ok');
  expect(result.message ?? '').toContain('Cube');
});
