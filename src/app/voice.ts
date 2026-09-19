/**
 * Voice controller: wraps the Web Speech API (when available) and always
 * exposes `submitText()` so tests, the simulator, and the in-XR mic button
 * can inject utterances without a real microphone.
 *
 * Every command that implies a scene mutation (delete/restore/move/placeOn/
 * undo/redo/setMode) is dispatched through `store.dispatch()` - the same
 * resolver hand/controller/ui intents go through - so tier/coverage/envelope
 * checks always apply (reality-editor-canonical-architecture.md:
 * "Interaction transaction"; reality-editor-capture-and-editability.md:
 * voice cannot override a Tier E result, it can only explain or offer
 * recapture). This module never mutates a transform itself.
 */
import type { SceneStore } from '@/core/api';
import type { Intent, ResolveResult, RuntimeConditions, VisualMode } from '@/core/types';
import { parseCommand, type VoiceCommand } from './voice-grammar';

export interface VoiceActions {
  captureCleanPlate(objectId: string): void | Promise<unknown>;
  spawn(shape: 'cube' | 'sphere'): void;
  explainLast(): string;
  list(): string;
  setMode(mode: VisualMode): void;
  /** Optional: app-level selection (there is no store Intent for "select"). */
  select?(objectId: string): void;
}

export type VoiceCommandResult =
  | { status: 'unrecognized'; text: string }
  | { status: 'ok'; text: string; command: VoiceCommand; message: string }
  | { status: 'rejected'; text: string; command: VoiceCommand; reason: string; explanation: string };

export interface VoiceControllerOptions {
  store: SceneStore;
  getConditions(): RuntimeConditions;
  getSelectedId(): string | undefined;
  actions: VoiceActions;
  onTranscript?(text: string, result: VoiceCommandResult): void;
  /** Speak confirmations/rejections via speechSynthesis. Default true; set false in tests. */
  speak?: boolean;
  /** BCP-47 language for SpeechRecognition. Defaults to navigator.language. */
  lang?: string;
}

export interface VoiceController {
  readonly listening: boolean;
  start(): void;
  stop(): void;
  toggle(): void;
  /** Inject an utterance as if it had been spoken. Used by tests, the simulator, and the mic button's fallback UI. */
  submitText(text: string): VoiceCommandResult;
  dispose(): void;
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
};

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function speak(text: string): void {
  if (typeof window === 'undefined') return;
  const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  const Utterance = (window as unknown as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
    .SpeechSynthesisUtterance;
  if (!synth || !Utterance) return;
  try {
    synth.speak(new Utterance(text));
  } catch {
    // Best-effort only; never let TTS failures break voice command handling.
  }
}

function dispatchIntent(
  store: SceneStore,
  intent: Intent,
  conditions: RuntimeConditions,
): ResolveResult {
  return store.dispatch(
    { intent, source: 'voice', issuedAt: conditions.now, basedOnVersion: store.current.version },
    conditions,
  );
}

export function createVoiceController(opts: VoiceControllerOptions): VoiceController {
  const shouldSpeak = opts.speak ?? true;
  let recognition: SpeechRecognitionLike | null = null;
  let listening = false;
  let stoppedIntentionally = false;

  function say(text: string): void {
    if (shouldSpeak) speak(text);
  }

  function handleOk(command: VoiceCommand, message: string, text: string): VoiceCommandResult {
    say(message);
    return { status: 'ok', text, command, message };
  }

  function handleRejected(command: VoiceCommand, result: { reason: string; explanation: string }, text: string): VoiceCommandResult {
    say(result.explanation);
    return { status: 'rejected', text, command, reason: result.reason, explanation: result.explanation };
  }

  function runIntent(command: VoiceCommand, intent: Intent, okMessage: string, text: string): VoiceCommandResult {
    const conditions = opts.getConditions();
    const result = dispatchIntent(opts.store, intent, conditions);
    if (result.ok) return handleOk(command, okMessage, text);
    return handleRejected(command, result, text);
  }

  function submitText(text: string): VoiceCommandResult {
    const snapshot = opts.store.current;
    const conditions = opts.getConditions();
    const command = parseCommand(text, snapshot, { selectedId: opts.getSelectedId(), headPose: conditions.headPose });

    let result: VoiceCommandResult;
    if (!command) {
      say("Sorry, I didn't understand that.");
      result = { status: 'unrecognized', text };
    } else {
      result = handleCommand(command, text);
    }

    opts.onTranscript?.(text, result);
    return result;
  }

  function handleCommand(command: VoiceCommand, text: string): VoiceCommandResult {
    switch (command.kind) {
      case 'delete':
        return runIntent(command, { kind: 'delete', objectId: command.objectId }, `Deleted ${command.label}.`, text);
      case 'restore':
        return runIntent(command, { kind: 'restore', objectId: command.objectId }, `Restored ${command.label}.`, text);
      case 'move':
        return runIntent(
          command,
          { kind: 'move', objectId: command.objectId, pose: command.pose },
          `Moved ${command.label} ${command.direction}.`,
          text,
        );
      case 'placeOn':
        return runIntent(
          command,
          { kind: 'move', objectId: command.objectId, pose: command.pose },
          `Placed ${command.label} on the ${command.surfaceLabel}.`,
          text,
        );
      case 'undo':
        return runIntent(command, { kind: 'undo' }, 'Undone.', text);
      case 'redo':
        return runIntent(command, { kind: 'redo' }, 'Redone.', text);
      case 'setMode':
        return runIntent(
          command,
          { kind: 'setMode', mode: command.mode },
          command.mode === 'captured-shell' ? 'Showing the captured room.' : 'Showing live passthrough.',
          text,
        );
      case 'spawn':
        opts.actions.spawn(command.shape);
        return handleOk(command, `Spawning a ${command.shape}.`, text);
      case 'select':
        opts.actions.select?.(command.objectId);
        return handleOk(command, `Selected ${command.label}.`, text);
      case 'captureCleanPlate':
        void opts.actions.captureCleanPlate(command.objectId);
        return handleOk(command, `Capturing ${command.label}.`, text);
      case 'listEditable':
        return handleOk(command, opts.actions.list(), text);
      case 'explainLast':
        return handleOk(command, opts.actions.explainLast(), text);
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  function attachRecognitionHandlers(rec: SpeechRecognitionLike): void {
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = opts.lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
    rec.onresult = (event: unknown) => {
      const e = event as { results: ArrayLike<SpeechRecognitionResultLike> };
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r?.isFinal) submitText(r[0].transcript);
      }
    };
    rec.onerror = () => {
      // Swallow recognition errors (no-speech, network, aborted, ...); the
      // mic stays visually off via `listening` and the caller can retry.
      listening = false;
    };
    rec.onend = () => {
      listening = false;
      if (!stoppedIntentionally) {
        // Some browsers stop `continuous` recognition unexpectedly; restart.
        try {
          rec.start();
          listening = true;
        } catch {
          /* ignore */
        }
      }
    };
  }

  function start(): void {
    if (listening) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return; // No mic support in this environment; submitText() remains available.
    stoppedIntentionally = false;
    if (!recognition) {
      recognition = new Ctor();
      attachRecognitionHandlers(recognition);
    }
    try {
      recognition.start();
      listening = true;
    } catch {
      /* already started, or blocked; leave `listening` as-is */
    }
  }

  function stop(): void {
    stoppedIntentionally = true;
    listening = false;
    recognition?.stop();
  }

  function toggle(): void {
    if (listening) stop();
    else start();
  }

  function dispose(): void {
    stop();
    recognition = null;
  }

  return {
    get listening() {
      return listening;
    },
    start,
    stop,
    toggle,
    submitText,
    dispose,
  };
}

export default createVoiceController;
