/**
 * Wiring glue for the voice layer + in-XR hand menu. Kept in its own module
 * (rather than inline in main.ts) so main.ts only needs two calls: construct
 * this once at startup, and call `.update(now)` once per rendered frame. See
 * the module doc below for the exact lines.
 *
 * ---------------------------------------------------------------------------
 * Wiring instructions for src/app/main.ts (two call sites):
 *
 * 1. After `const interaction = new InteractionController(store);` and after
 *    `spawnPrimitive`/`captureCleanPlate` are defined (they're used as
 *    callbacks), construct the controller:
 *
 *      const voiceAndMenu = installVoiceAndMenu({
 *        store, interaction, scene, input, camera, conditions,
 *        captureCleanPlate, spawnPrimitive,
 *        setMode: (mode) => store.dispatch(
 *          { intent: { kind: 'setMode', mode }, source: 'voice', issuedAt: performance.now(), basedOnVersion: store.current.version },
 *          conditions(),
 *        ),
 *      });
 *
 * 2. Inside `renderer.setAnimationLoop((time, frame) => { ... })`, anywhere
 *    after `conditions()`/`interaction.update(...)` have run for the frame:
 *
 *      voiceAndMenu.update(now);
 *
 * Also add `voice: voiceAndMenu.voice` to the returned `AppHandle`, and call
 * `voiceAndMenu.dispose()` inside `handle.dispose()`. main.ts is owned by
 * another agent, so those edits are documented here rather than applied.
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';
import type { SceneStore } from '@/core/api';
import type { RuntimeConditions, VisualMode } from '@/core/types';
import type { InteractionController } from './interaction';
import type { XRInput } from '@/xr/input';
import { createVoiceController, type VoiceController } from './voice';
import { HandMenu, MicButton, type HandMenuAction } from '@/render/hand-menu';

export interface VoiceAndMenuDeps {
  store: SceneStore;
  interaction: InteractionController;
  scene: THREE.Scene;
  input: XRInput;
  camera: THREE.Camera;
  conditions(): RuntimeConditions;
  captureCleanPlate(objectId: string): Promise<{ tier: string; coverage: number }>;
  spawnPrimitive(kind: 'cube' | 'sphere'): void;
  setMode(mode: VisualMode): void;
  /** Disable speechSynthesis (tests, headless simulator runs). Default true. */
  speak?: boolean;
}

export interface VoiceAndMenuHandle {
  voice: VoiceController;
  menu: HandMenu;
  mic: MicButton;
  update(now: number): void;
  dispose(): void;
}

function listEditableText(store: SceneStore): string {
  const objects = Object.values(store.current.objects).filter((o) => o.approved);
  if (objects.length === 0) return 'Nothing is approved for editing yet.';
  return objects
    .map((o) => `${o.userName} (tier ${o.tier}${o.visible ? '' : ', hidden'})`)
    .join(', ');
}

function explainLastText(interaction: InteractionController): string {
  const rejection = interaction.lastRejection;
  if (!rejection) return 'Nothing has been rejected recently.';
  return `${rejection.reason}: ${rejection.explanation}`;
}

/** Wires the voice controller and hand menu together and returns a single per-frame update()/dispose(). */
export function installVoiceAndMenu(deps: VoiceAndMenuDeps): VoiceAndMenuHandle {
  const menu = new HandMenu();
  deps.scene.add(menu.group);

  const mic = new MicButton();
  deps.scene.add(mic.mesh);

  const voice = createVoiceController({
    store: deps.store,
    getConditions: deps.conditions,
    getSelectedId: () => deps.interaction.selectedId ?? undefined,
    actions: {
      captureCleanPlate: (id) => {
        void deps.captureCleanPlate(id);
      },
      spawn: (shape) => deps.spawnPrimitive(shape),
      explainLast: () => explainLastText(deps.interaction),
      list: () => listEditableText(deps.store),
      setMode: deps.setMode,
      select: (id) => {
        deps.interaction.selectedId = id;
      },
    },
    onTranscript: (_text, result) => {
      // Surface voice rejections through the same HUD path as hand/UI
      // rejections (InteractionController.lastRejection -> hud.ts).
      if (result.status === 'rejected') {
        deps.interaction.lastRejection = {
          reason: result.reason,
          explanation: result.explanation,
          at: deps.conditions().now,
        };
      }
    },
    speak: deps.speak ?? true,
  });

  function dispatchUndoRedo(kind: 'undo' | 'redo'): void {
    const conditions = deps.conditions();
    deps.store.dispatch(
      { intent: { kind }, source: 'ui', issuedAt: conditions.now, basedOnVersion: deps.store.current.version },
      conditions,
    );
  }

  menu.onAction((action: HandMenuAction) => {
    const conditions = deps.conditions();
    switch (action) {
      case 'delete':
        deps.interaction.deleteSelected(conditions);
        break;
      case 'restore':
        deps.interaction.restoreSelected(conditions);
        break;
      case 'undo':
        dispatchUndoRedo('undo');
        break;
      case 'redo':
        dispatchUndoRedo('redo');
        break;
      case 'roomToggle': {
        const mode: VisualMode = deps.store.current.mode === 'live-overlay' ? 'captured-shell' : 'live-overlay';
        deps.setMode(mode);
        break;
      }
      case 'spawnCube':
        deps.spawnPrimitive('cube');
        break;
      case 'capture':
        if (deps.interaction.selectedId) void deps.captureCleanPlate(deps.interaction.selectedId);
        break;
      default: {
        const exhaustive: never = action;
        void exhaustive;
      }
    }
  });

  mic.onToggle(() => voice.toggle());

  function update(now: number): void {
    void now;
    menu.update(deps.input.state, deps.camera);
    mic.attachTo(deps.camera);
    mic.setListening(voice.listening);
  }

  function dispose(): void {
    voice.dispose();
    menu.dispose();
    mic.dispose();
    deps.scene.remove(menu.group);
    deps.scene.remove(mic.mesh);
  }

  return { voice, menu, mic, update, dispose };
}

export default installVoiceAndMenu;
