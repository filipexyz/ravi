/**
 * The voice door. Runs in the daemon.
 *
 * It turns call utterances into session turns (one at a time per call, after
 * the session's current reply), watches the session's runtime events for the
 * turn, reads the reply from the transcript, extracts the spoken lead, speaks
 * it through the call's engine and stores every step as a call event.
 *
 * Spec: `voice` (.ravi/specs/voice/SPEC.md).
 */
import { randomUUID } from "node:crypto";
import { readThisTurnAssistantText, snapshotTranscriptCursor } from "../cli/session-cli-surface.js";
import { logger } from "../utils/logger.js";
import {
  listOpenVoiceApprovals,
  parseVoiceApprovalMessageId,
  publishVoiceApprovalOutcome,
  VOICE_ACCOUNT_ID,
  VOICE_CHANNEL,
} from "./approvals.js";
import { mockEngine } from "./engines/mock.js";
import { pushEngine } from "./engines/push.js";
import {
  LiveSideband,
  LIVE_USD_PER_ACTIVE_MINUTE,
  closeLiveSession,
  liveApiKey,
  type LiveSidebandHandlers,
} from "./engines/live.js";
import { getVoiceEngine } from "./engines/index.js";
import type { ClipSpeechEngine } from "./engines/types.js";
import { emitVoiceEvent, type VoiceControlMessage, type VoiceEventSink } from "./events.js";
import { revokeVoiceDeviceContext } from "./authority.js";
import { createVoiceTurnOwnership, noteVoiceTurnRuntimeEvent, type VoiceTurnOwnership } from "./turn-ownership.js";
import { buildVoicePrompt, classifySpokenControl, extractSpokenLead, sanitizeForSpeech } from "./speech.js";
import {
  addVoiceDailyUsage,
  deleteVoiceAudioForCall,
  getVoiceCall,
  getVoiceDailyUsage,
  getVoiceDevice,
  getVoiceProfile,
  getVoiceTurn,
  insertVoiceTurn,
  listVoiceCalls,
  listVoiceDevices,
  listVoiceTurns,
  saveVoiceAudio,
  updateOpenVoiceCall,
  updateVoiceCall,
  updateVoiceTurnState,
} from "./store.js";
import {
  DEFAULT_VOICE_PROFILE_ID,
  type VoiceAgentState,
  type VoiceCall,
  type VoiceEventType,
  type VoiceProfile,
  type VoiceSpeaker,
  type VoiceTurn,
  type VoiceUsage,
  voiceSubjects,
} from "./types.js";

const log = logger.child("voice:door");

/** A voice turn that outlives this ends with a spoken failure and frees the call. */
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const LIMIT_SWEEP_MS = 15_000;
const FAILURE_LINE = "Não consegui terminar isso. Os detalhes estão na sessão.";
const CANCELLED_LINE = "Cancelado.";

type HistoryMessage = { id: number; role: string; content: string };

interface SidebandLike {
  connect(): void;
  commentary(text: string, delegationId: string | null): void;
  thinking(text: string, delegationId: string | null): void;
  /** Publish pending speech while the call still accepts transcripts. */
  drain?(): void;
  close(): void;
}

export interface VoiceDoorDeps {
  subscribe: (...args: Array<string | { signal?: AbortSignal; queue?: string }>) => AsyncIterable<{
    topic: string;
    data: Record<string, unknown>;
  }>;
  emit: (topic: string, data: Record<string, unknown>) => Promise<void>;
  publishPrompt: (sessionName: string, payload: Record<string, unknown>) => Promise<void>;
  readHistory: (sessionName: string, limit: number) => HistoryMessage[];
  clipEngines?: { push: ClipSpeechEngine; mock: ClipSpeechEngine };
  createSideband?: (input: { apiKey: string; sessionId: string; handlers: LiveSidebandHandlers }) => SidebandLike;
  closeLiveProviderSession?: (input: { apiKey: string; sessionId: string }) => Promise<void>;
  now?: () => number;
  turnTimeoutMs?: number;
  transcriptWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

interface RunningTurn {
  turn: VoiceTurn;
  delegationId?: string;
  wait: VoiceTurnOwnership;
  cancelRequested: boolean;
  abortSent: boolean;
  /** Ends the wait for this turn's terminal (the call ended under it). */
  release: (kind: string) => void;
}

interface CallRuntime {
  callId: string;
  queue: Array<{ turn: VoiceTurn; delegationId?: string }>;
  running: RunningTurn | null;
  draining: boolean;
  sideband?: SidebandLike;
  providerSessionId?: string;
  lastLiveSeconds: number;
}

export class VoiceDoorService {
  private readonly calls = new Map<string, CallRuntime>();
  private readonly sessionTurns = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sink: VoiceEventSink;
  private readonly now: () => number;
  private readonly clip: { push: ClipSpeechEngine; mock: ClipSpeechEngine };

  constructor(private readonly deps: VoiceDoorDeps) {
    this.sink = { emit: deps.emit };
    this.now = deps.now ?? Date.now;
    this.clip = deps.clipEngines ?? { push: pushEngine, mock: mockEngine };
  }

  /** Daemon boot: recover stored calls, then listen for control messages. */
  async start(): Promise<void> {
    await this.recoverAfterRestart();
    void this.listen();
    void this.listenApprovalResponses();
    this.sweepTimer = setInterval(() => {
      void this.sweepLimits();
    }, LIMIT_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const runtime of this.calls.values()) {
      runtime.sideband?.close();
    }
    this.calls.clear();
  }

  private async listen(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        for await (const message of this.deps.subscribe(voiceSubjects.allControl, {
          queue: "ravi-voice-door",
          signal: this.abort.signal,
        })) {
          await this.handleControl(message.data as unknown as VoiceControlMessage).catch((error) => {
            log.warn("Voice control failed", { topic: message.topic, error });
          });
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        log.warn("Voice control subscription dropped; resubscribing", { error });
        await (this.deps.sleep ?? defaultSleep)(1000);
      }
      if (this.abort.signal.aborted) return;
    }
  }

  /**
   * The approval service publishes `ravi.approval.response` when it commits a
   * decision (or the request expires). A voice request's message id names the
   * call, so the outcome reaches the call even when the `calls approve` that
   * sent the tap gave up waiting. The limits sweep repeats this from the store.
   */
  private async listenApprovalResponses(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        for await (const message of this.deps.subscribe("ravi.approval.response", { signal: this.abort.signal })) {
          const messageId = typeof message.data.messageId === "string" ? message.data.messageId : "";
          const target = parseVoiceApprovalMessageId(messageId);
          if (!target) continue;
          await this.reconcileApproval(target.callId, target.approvalId).catch((error) => {
            log.warn("Voice approval outcome failed", { callId: target.callId, error });
          });
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        log.warn("Approval response subscription dropped; resubscribing", { error });
        await (this.deps.sleep ?? defaultSleep)(1000);
      }
      if (this.abort.signal.aborted) return;
    }
  }

  /** Publish what the approval store committed for one request shown in the call. Public for tests. */
  async reconcileApproval(callId: string, approvalId: string): Promise<void> {
    const outcome = await publishVoiceApprovalOutcome(callId, approvalId, { sink: this.sink });
    // The approval service resumes the turn either way; a late outcome for a
    // turn that already ended leaves the call's state alone.
    if (outcome && this.calls.get(callId)?.running) await this.setAgentState(callId, "thinking");
  }

  /** Public for tests and for in-process callers. */
  async handleControl(message: VoiceControlMessage): Promise<void> {
    if (!message || typeof message !== "object" || typeof message.callId !== "string") return;
    const call = getVoiceCall(message.callId);
    if (!call || call.state === "ended") return;
    switch (message.op) {
      case "utterance":
        await this.handleUtterance(call, message);
        return;
      case "cancel-turn":
        await this.cancelTurn(call, message.turnId, message.actor);
        return;
      case "silence":
        // Always emitted (even when already listening) so players stop at once.
        updateVoiceCall(call.id, { agentState: "listening" }, this.now());
        await this.emitOpen(call.id, "agent.state", { state: "listening", reason: "silenced" }, this.sink);
        return;
      case "end":
        await this.endCall(call.id, message.reason || "ended");
        return;
      case "live-attach":
        await this.attachLive(call, message.providerSessionId);
        return;
      case "approval-resolved":
        // The approval service resumes the turn; reflect it only while a turn
        // of this call is running (a stale notice leaves the state alone).
        if (this.calls.get(call.id)?.running) await this.setAgentState(call.id, "thinking");
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Utterances and turns
  // -------------------------------------------------------------------------

  private async handleUtterance(
    call: VoiceCall,
    message: Extract<VoiceControlMessage, { op: "utterance" }>,
    delegationId?: string,
    /** Live: the part of `text` not already on screen; "" shows nothing new. */
    displayText?: string,
    /** Live: the last utterance; spoken cancel and deny are read from it, not from the whole request. */
    controlText?: string,
  ): Promise<void> {
    const text = message.text.trim();
    const speaker = normalizeSpeaker(message.speaker, call.speaker);
    if (message.audioInSeconds || message.sttCostUsd) {
      await this.addUsage(call.id, {
        audioInSeconds: message.audioInSeconds ?? 0,
        estimatedCostUsd: message.sttCostUsd ?? 0,
      });
    }
    if (!text) return;
    const shown = displayText === undefined ? text : displayText.trim();
    if (shown)
      await this.emitOpen(call.id, "user.transcript", { text: shown, speaker, turnId: message.turnId }, this.sink);

    const profile = this.profileFor(call);
    if (speaker.kind === "guest" && !profile.allowGuests) {
      await this.emitOpen(
        call.id,
        "error",
        { code: "VOICE_GUEST_FORBIDDEN", message: "Guest speech ignored: the profile does not accept guests." },
        this.sink,
      );
      return;
    }

    // Spoken cancel and deny are allowed (never a spoken approval), only from the person.
    if (speaker.kind !== "guest") {
      const control = classifySpokenControl(controlText?.trim() || text);
      const runtime = this.runtime(call.id);
      if (control === "cancel" && (runtime.running || runtime.queue.length > 0)) {
        const target = runtime.running?.turn.id ?? runtime.queue[runtime.queue.length - 1]?.turn.id;
        if (target) await this.cancelTurn(call, target, speaker.id);
        if (delegationId) runtime.sideband?.commentary(CANCELLED_LINE, delegationId);
        return;
      }
      if (control === "deny") {
        // A spoken "no" while an approval is open is a deny, handled by the command
        // layer (`calls deny`); the door records the intent for the app.
        await this.emitOpen(call.id, "agent.state", { state: "listening", hint: "spoken_deny" }, this.sink);
      }
    }

    const turn = insertVoiceTurn({
      id: message.turnId || newTurnId(),
      callId: call.id,
      text,
      speaker,
      state: "queued",
      createdAt: this.now(),
    });
    const runtime = this.runtime(call.id);
    runtime.queue.push({ turn, ...(delegationId ? { delegationId } : {}) });
    await this.emitOpen(call.id, "work.state", { turnId: turn.id, state: "queued" }, this.sink);
    void this.drain(call.id);
  }

  private async drain(callId: string): Promise<void> {
    const runtime = this.runtime(callId);
    if (runtime.draining) return;
    runtime.draining = true;
    try {
      while (runtime.queue.length > 0) {
        const call = getVoiceCall(callId);
        if (!call || call.state === "ended") break;
        await this.inSessionOrder(call.sessionKey, async () => {
          // The turn leaves the queue only once it holds the session, so a
          // cancel while it waits still finds it there.
          const next = runtime.queue.shift();
          if (!next) return;
          // Re-read after waiting for the session: the call or turn may be gone.
          const current = getVoiceCall(callId);
          if (!current || current.state === "ending" || current.state === "ended") return;
          if (getVoiceTurn(next.turn.id)?.state === "cancelled") return;
          // The door stopped while this turn waited for the session.
          if (this.abort.signal.aborted) return;
          try {
            await this.runTurn(current, next.turn, next.delegationId);
          } catch (error) {
            // One failed turn never stalls the turns queued behind it.
            log.warn("Voice turn failed", { callId, turnId: next.turn.id, error });
            if (runtime.running?.turn.id === next.turn.id) runtime.running = null;
            const stored = getVoiceTurn(next.turn.id);
            if (stored && (stored.state === "queued" || stored.state === "running")) {
              updateVoiceTurnState(next.turn.id, "failed", this.now());
            }
          }
        });
      }
    } finally {
      runtime.draining = false;
    }
  }

  /**
   * One voice turn at a time per session, across calls. A turn's reply is
   * read from the session after its own prompt, so a second call's prompt goes
   * in only when the first call's turn has ended; two calls never read each
   * other's reply.
   */
  private async inSessionOrder(sessionKey: string, work: () => Promise<void>): Promise<void> {
    const previous = this.sessionTurns.get(sessionKey) ?? Promise.resolve();
    const current = previous.then(work);
    // no-cause: the tail only orders the next turn; this turn's error still reaches the caller through `await current`.
    const tail = current.catch(() => {});
    this.sessionTurns.set(sessionKey, tail);
    try {
      await current;
    } finally {
      if (this.sessionTurns.get(sessionKey) === tail) this.sessionTurns.delete(sessionKey);
    }
  }

  private async runTurn(call: VoiceCall, turn: VoiceTurn, delegationId?: string): Promise<void> {
    const runtime = this.runtime(call.id);
    const profile = this.profileFor(call);
    const running: RunningTurn = {
      turn,
      ...(delegationId ? { delegationId } : {}),
      wait: createVoiceTurnOwnership(turn.id),
      cancelRequested: false,
      abortSent: false,
      release: () => {},
    };
    // Settable before any await: the call can end while this turn is being announced.
    let resolveTerminal: (kind: string) => void = () => {};
    const terminal = new Promise<string>((resolve) => {
      resolveTerminal = resolve;
    });
    running.release = (kind) => resolveTerminal(kind);
    runtime.running = running;
    updateVoiceTurnState(turn.id, "running", this.now());
    // The full request text rides on turn.accepted, so a turn can be matched to
    // what was said even when the live transcript was already on screen.
    await this.emitOpen(
      call.id,
      "turn.accepted",
      { turnId: turn.id, sessionName: call.sessionName, text: turn.text },
      this.sink,
    );
    await this.setAgentState(call.id, "thinking");

    const sessionName = call.sessionName;
    // Replies after this cursor are this turn's. When the prompt queued behind a
    // turn in flight, the cursor moves past that turn's reply as soon as its
    // terminal event arrives (the reply is stored before that event, and this
    // turn has not started yet), so that reply is never read as this one's.
    let cursor = snapshotTranscriptCursor(this.deps.readHistory(sessionName, 1));
    const watch = new AbortController();
    const stopWatch = () => watch.abort();
    this.abort.signal.addEventListener("abort", stopWatch, { once: true });

    const watcher = (async () => {
      try {
        for await (const event of this.deps.subscribe(
          `ravi.session.${sessionName}.runtime`,
          `ravi.session.${sessionName}.claude`,
          { signal: watch.signal },
        )) {
          const type = event.data.type;
          // The legacy provider topic carries no ownership; the runtime terminal decides.
          if (event.topic.endsWith(".claude")) continue;
          const noted = noteVoiceTurnRuntimeEvent(running.wait, event.data);
          const firstOwn = noted.verdict === "own_event" && !running.wait.started;
          running.wait = noted.state;
          if (noted.verdict === "other_terminal") {
            // Another turn's reply is stored before its terminal, so it is never read as this one's.
            if (!running.wait.started) {
              cursor = Math.max(cursor, snapshotTranscriptCursor(this.deps.readHistory(sessionName, 1)));
            }
            continue;
          }
          if (noted.verdict === "other") continue;
          const open = this.isOpen(call.id);
          if (firstOwn) {
            if (open) await this.emitOpen(call.id, "work.state", { turnId: turn.id, state: "running" }, this.sink);
            if (running.cancelRequested) await this.sendAbort(call, running);
          }
          if (open && (type === "tool.started" || type === "tool.completed")) {
            const name = typeof event.data.toolName === "string" ? event.data.toolName : event.data.name;
            await this.emitOpen(
              call.id,
              "work.tool",
              {
                turnId: turn.id,
                phase: type === "tool.started" ? "started" : "completed",
                ...(typeof name === "string" ? { name: name.slice(0, 80) } : {}),
              },
              this.sink,
            );
          }
          if (noted.verdict === "own_terminal") {
            resolveTerminal(String(type));
            return;
          }
        }
      } catch (error) {
        if (!watch.signal.aborted) log.warn("Voice turn watch failed", { callId: call.id, error });
      }
    })();

    let outcome: string;
    try {
      await this.deps.publishPrompt(sessionName, {
        prompt: buildVoicePrompt({ text: turn.text, speaker: turn.speaker, language: profile.language }),
        deliveryBarrier: "after_response",
        deliveryBarrierSource: "default",
        _cliDestination: true,
        _correlationId: turn.id,
        _approvalSource: { channel: VOICE_CHANNEL, accountId: VOICE_ACCOUNT_ID, chatId: call.id },
        ...(call.turnOrigin ? { _turnOrigin: call.turnOrigin } : {}),
      });
      outcome = await raceTimeout(terminal, this.deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, "timeout");
    } catch (error) {
      log.warn("Voice turn publish failed", { callId: call.id, error });
      outcome = "publish_failed";
    } finally {
      watch.abort();
      this.abort.signal.removeEventListener("abort", stopWatch);
    }
    // no-cause: the watcher logs its own failure; the outcome below covers it.
    await watcher.catch(() => {});
    if (this.abort.signal.aborted) return;

    if (outcome === "call_ended") {
      // The call is gone; the session turn may still finish, and its reply stays in the session.
      await this.finishTurn(call, running, "cancelled", "", "");
      return;
    }
    if (running.cancelRequested || outcome === "turn.interrupted") {
      await this.finishTurn(call, running, "cancelled", "", "");
      if (running.cancelRequested) await this.speak(call, running, CANCELLED_LINE, CANCELLED_LINE, profile);
      return;
    }
    if (outcome !== "turn.complete") {
      await this.emitOpen(
        call.id,
        "error",
        { code: outcome === "timeout" ? "VOICE_TURN_TIMEOUT" : "VOICE_TURN_FAILED", turnId: turn.id },
        this.sink,
      );
      await this.finishTurn(call, running, "failed", "", "");
      await this.speak(call, running, FAILURE_LINE, FAILURE_LINE, profile);
      return;
    }

    const fullText = (await this.readReply(call.id, sessionName, cursor)) ?? "";
    const { spokenText, screenText } = extractSpokenLead(fullText);
    await this.finishTurn(call, running, "done", spokenText, screenText);
    await this.speak(call, running, spokenText, screenText, profile);
  }

  private async readReply(callId: string, sessionName: string, cursor: number): Promise<string | null> {
    const deadline = this.now() + (this.deps.transcriptWaitMs ?? 10_000);
    const sleep = this.deps.sleep ?? defaultSleep;
    for (;;) {
      const found = readThisTurnAssistantText(this.deps.readHistory(sessionName, 50), cursor);
      if (found) return found.text;
      // An ended call speaks nothing more; do not hold the session's next voice turn.
      if (this.now() >= deadline || !this.isOpen(callId)) return null;
      await sleep(250);
    }
  }

  private async finishTurn(
    call: VoiceCall,
    running: RunningTurn,
    state: "done" | "failed" | "cancelled",
    spokenText: string,
    fullText: string,
  ): Promise<void> {
    updateVoiceTurnState(running.turn.id, state, this.now());
    // An ended call already dropped its runtime; do not recreate it.
    const runtime = this.calls.get(call.id);
    if (runtime?.running === running) runtime.running = null;
    // The reply stays in the session; an ended call gets no more output.
    if (!this.isOpen(call.id)) return;
    await this.emitOpen(call.id, "work.state", { turnId: running.turn.id, state }, this.sink);
    if (state === "done") {
      // Stored and published before speech so the screen never waits for audio.
      await this.emitOpen(
        call.id,
        "turn.completed",
        { turnId: running.turn.id, spokenText, fullText, delivery: this.profileFor(call).delivery },
        this.sink,
      );
    }
  }

  /** Speak through the call's engine. Text is already sanitized. */
  private async speak(
    call: VoiceCall,
    running: RunningTurn,
    spokenText: string,
    fullText: string,
    profile: VoiceProfile,
  ): Promise<void> {
    if (!this.isOpen(call.id)) return;
    const runtime = this.runtime(call.id);
    // The live model is a third party: it gets the sanitized text, never the raw screen text.
    const liveContext = call.engine === "live" ? sanitizeForSpeech(fullText) : "";
    if (!spokenText || profile.delivery === "silent") {
      if (liveContext) runtime.sideband?.thinking(liveContext, running.delegationId ?? null);
      await this.setAgentState(call.id, "listening");
      return;
    }
    if (call.engine === "live") {
      runtime.sideband?.commentary(spokenText, running.delegationId ?? null);
      if (liveContext && liveContext !== spokenText)
        runtime.sideband?.thinking(liveContext, running.delegationId ?? null);
      await this.emitOpen(call.id, "agent.transcript", { text: spokenText, turnId: running.turn.id }, this.sink);
      await this.setAgentState(call.id, "listening");
      return;
    }
    let audio: { item: string; mime: string; durationSec: number } | undefined;
    if (call.engine === "push" || call.engine === "mock") {
      try {
        await this.setAgentState(call.id, "speaking");
        const clip = await this.clip[call.engine].synthesize({ text: spokenText, profile });
        // The call may have ended (and its clips been deleted) while synthesizing.
        if (!this.isOpen(call.id)) return;
        if (clip) {
          const itemId = `va_${running.turn.id}`;
          saveVoiceAudio(call.id, itemId, clip.mime, clip.bytes, this.now());
          audio = { item: itemId, mime: clip.mime, durationSec: clip.durationSec };
          await this.addUsage(call.id, {
            audioOutSeconds: clip.durationSec,
            charactersSpoken: clip.characters,
            estimatedCostUsd: clip.costUsd,
          });
        }
      } catch (error) {
        log.warn("Voice synthesis failed", { callId: call.id, error });
        await this.emitOpen(call.id, "error", { code: "VOICE_TTS_FAILED", turnId: running.turn.id }, this.sink);
      }
    }
    if (!this.isOpen(call.id)) return;
    await this.emitOpen(
      call.id,
      "agent.transcript",
      { text: spokenText, turnId: running.turn.id, delivery: profile.delivery, ...(audio ? { audio } : {}) },
      this.sink,
    );
    // Hands-free: the worker reads `agent.transcript` from the stream and speaks it.
    await this.setAgentState(call.id, "listening");
  }

  private async cancelTurn(call: VoiceCall, turnId: string, actor: string): Promise<void> {
    const runtime = this.runtime(call.id);
    const queuedIndex = runtime.queue.findIndex((item) => item.turn.id === turnId);
    if (queuedIndex >= 0) {
      runtime.queue.splice(queuedIndex, 1);
      updateVoiceTurnState(turnId, "cancelled", this.now());
      await this.emitOpen(call.id, "work.state", { turnId, state: "cancelled", actor }, this.sink);
      return;
    }
    const running = runtime.running;
    if (!running || running.turn.id !== turnId) return;
    running.cancelRequested = true;
    // Only this call's own turn: abort once it is running; until then the first own event sends it.
    if (running.wait.started) {
      await this.sendAbort(call, running, actor);
    }
  }

  private async sendAbort(call: VoiceCall, running: RunningTurn, actor = "voice"): Promise<void> {
    if (running.abortSent) return;
    running.abortSent = true;
    await this.deps
      .emit("ravi.session.abort", {
        sessionKey: call.sessionKey,
        sessionName: call.sessionName,
        source: "voice",
        action: "voice.calls.cancel-turn",
        reason: "voice_cancel_turn",
        actor,
        correlationId: running.turn.id,
      })
      .catch((error) => {
        // Let a later cancel try again.
        running.abortSent = false;
        log.warn("Voice cancel abort failed", { callId: call.id, error });
      });
  }

  // -------------------------------------------------------------------------
  // Live engine
  // -------------------------------------------------------------------------

  private async attachLive(call: VoiceCall, providerSessionId: string): Promise<void> {
    if (call.engine !== "live") return;
    const apiKey = liveApiKey(this.deps.env ?? process.env);
    if (!apiKey) {
      await this.emitOpen(call.id, "error", { code: "VOICE_ENGINE_NOT_READY", engine: "live" }, this.sink);
      await this.endCall(call.id, "engine_not_ready");
      return;
    }
    const runtime = this.runtime(call.id);
    // Retire the old sideband before closing it: its close callback must not
    // end the call that a new connect is taking over.
    const previous = runtime.sideband;
    runtime.sideband = undefined;
    previous?.close();
    runtime.providerSessionId = providerSessionId;
    const self: { sideband: SidebandLike | null } = { sideband: null };
    const handlers: LiveSidebandHandlers = {
      onDelegation: ({ delegationId, text, displayText, lastUtterance }) => {
        // A sideband that was replaced, or a call that is ending, starts no work.
        if (!self.sideband || runtime.sideband !== self.sideband) return;
        const current = getVoiceCall(call.id);
        if (!current || current.state === "ended" || current.state === "ending") return;
        if (!text) {
          runtime.sideband?.thinking("The request was not heard clearly. Ask the person to repeat it.", delegationId);
          return;
        }
        void this.handleUtterance(
          current,
          { op: "utterance", callId: call.id, turnId: newTurnId(), text, speaker: current.speaker as never },
          delegationId,
          displayText,
          lastUtterance,
        );
      },
      onUserTranscript: (text) => {
        void this.emitOpen(call.id, "user.transcript", { text, speaker: call.speaker, source: "live" }, this.sink);
      },
      onAgentTranscript: (text) => {
        void this.emitOpen(call.id, "agent.transcript", { text, source: "live" }, this.sink);
      },
      onUsage: ({ seconds, activeSeconds }) => {
        const billed = activeSeconds ?? seconds;
        const delta = Math.max(0, billed - runtime.lastLiveSeconds);
        runtime.lastLiveSeconds = billed;
        void this.addUsage(call.id, {
          engineSeconds: delta,
          estimatedCostUsd: (delta / 60) * LIVE_USD_PER_ACTIVE_MINUTE,
        });
      },
      onClosed: (reason) => {
        // Only the call's current sideband ends it.
        if (!self.sideband || runtime.sideband !== self.sideband) return;
        void this.endCall(call.id, reason === "closed_by_door" ? "ended" : reason);
      },
      onError: (error) => {
        void this.emitOpen(
          call.id,
          "error",
          {
            code: "VOICE_LIVE_ERROR",
            message: error.message,
            ...(error.providerCode ? { providerCode: error.providerCode } : {}),
            ...(error.providerType ? { providerType: error.providerType } : {}),
            ...(error.param ? { param: error.param } : {}),
          },
          this.sink,
        );
      },
    };
    const sideband = this.deps.createSideband
      ? this.deps.createSideband({ apiKey, sessionId: providerSessionId, handlers })
      : new LiveSideband({ apiKey, sessionId: providerSessionId, handlers });
    self.sideband = sideband;
    const latest = getVoiceCall(call.id);
    if (!latest || latest.state === "ending" || latest.state === "ended") return;
    runtime.sideband = sideband;
    sideband.connect();
    if (!updateOpenVoiceCall(call.id, { state: "active", providerRef: providerSessionId }, this.now())) return;
    await this.emitOpen(call.id, "call.state", { state: "active" }, this.sink);
  }

  // -------------------------------------------------------------------------
  // Call lifecycle, usage and limits
  // -------------------------------------------------------------------------

  async endCall(callId: string, reason: string): Promise<void> {
    const call = getVoiceCall(callId);
    if (!call || call.state === "ended") return;
    // Words said right before hanging up are stored before the call stops accepting them.
    this.calls.get(callId)?.sideband?.drain?.();
    updateVoiceCall(callId, { state: "ending" }, this.now());
    const runtime = this.calls.get(callId);
    if (runtime) {
      for (const queued of runtime.queue) updateVoiceTurnState(queued.turn.id, "cancelled", this.now());
      runtime.queue = [];
      // A turn still waiting on the session would hold every later turn of that session.
      runtime.running?.release("call_ended");
      const sideband = runtime.sideband;
      runtime.sideband = undefined;
      sideband?.close();
      if (runtime.providerSessionId) {
        const apiKey = liveApiKey(this.deps.env ?? process.env);
        if (apiKey) {
          await (this.deps.closeLiveProviderSession ?? closeLiveSession)({
            apiKey,
            sessionId: runtime.providerSessionId,
          }).catch((error) => {
            log.warn("Live provider session close failed", { callId, error });
          });
        }
      }
    }
    const ended = updateVoiceCall(
      callId,
      { state: "ended", agentState: "idle", endedReason: reason, endedAt: this.now() },
      this.now(),
    );
    deleteVoiceAudioForCall(callId);
    await emitVoiceEvent(callId, "call.state", { state: "ended" }, this.sink);
    await emitVoiceEvent(callId, "call.ended", { reason, usage: ended?.usage ?? call.usage }, this.sink);
    this.calls.delete(callId);
  }

  private async addUsage(callId: string, delta: Partial<VoiceUsage>): Promise<void> {
    const call = getVoiceCall(callId);
    if (!call) return;
    const usage: VoiceUsage = {
      audioInSeconds: round(call.usage.audioInSeconds + (delta.audioInSeconds ?? 0)),
      audioOutSeconds: round(call.usage.audioOutSeconds + (delta.audioOutSeconds ?? 0)),
      charactersSpoken: call.usage.charactersSpoken + (delta.charactersSpoken ?? 0),
      engineSeconds: round(call.usage.engineSeconds + (delta.engineSeconds ?? 0)),
      estimatedCostUsd: round(call.usage.estimatedCostUsd + (delta.estimatedCostUsd ?? 0), 5),
    };
    updateVoiceCall(callId, { usage }, this.now());
    addVoiceDailyUsage(
      delta.estimatedCostUsd ?? 0,
      (delta.engineSeconds ?? 0) + (delta.audioInSeconds ?? 0) + (delta.audioOutSeconds ?? 0),
      this.now(),
    );
    await this.emitOpen(callId, "usage", { ...usage }, this.sink);
    await this.enforceLimits(callId);
  }

  private async enforceLimits(callId: string): Promise<void> {
    const call = getVoiceCall(callId);
    if (!call || call.state === "ended") return;
    const profile = this.profileFor(call);
    const minutes = (this.now() - call.createdAt) / 60_000;
    const daily = getVoiceDailyUsage(this.now());
    const exceeded =
      minutes >= profile.maxCallMinutes
        ? "max_call_minutes"
        : call.usage.estimatedCostUsd >= profile.maxCallCostUsd
          ? "max_call_cost"
          : daily.costUsd >= profile.maxDailyCostUsd
            ? "max_daily_cost"
            : null;
    if (!exceeded) return;
    await this.emitOpen(callId, "error", { code: "VOICE_LIMIT_REACHED", limit: exceeded }, this.sink);
    await this.endCall(callId, "limit");
  }

  /** One pass of the periodic sweep. Public for tests. */
  async sweepNow(): Promise<void> {
    await this.sweepLimits();
  }

  private async sweepLimits(): Promise<void> {
    try {
      // A revoke that stopped after the device record: finish the context.
      for (const device of listVoiceDevices({ includeRevoked: true })) {
        if (device.revokedAt) revokeVoiceDeviceContext(device.contextId);
      }
      for (const call of listVoiceCalls({ activeOnly: true, limit: "all" })) {
        // The revoked device record is the durable "end its calls" request:
        // `devices revoke` asks right away, and this sweep retries if that ask
        // was lost.
        if (call.speaker.kind === "device" && getVoiceDevice(call.speaker.id)?.revokedAt) {
          await this.endCall(call.id, "device_revoked");
          continue;
        }
        await this.enforceLimits(call.id);
        for (const open of listOpenVoiceApprovals(call.id)) {
          await this.reconcileApproval(call.id, open.approvalId);
        }
      }
    } catch (error) {
      log.warn("Voice limit sweep failed", { error });
    }
  }

  /**
   * Every door event except the call's own end goes through here: the
   * liveness check and the store append run in the same tick, so nothing is
   * recorded or published after `call.ended`, whatever awaits came before.
   */
  private async emitOpen(
    callId: string,
    type: VoiceEventType,
    data: Record<string, unknown>,
    sink: VoiceEventSink = this.sink,
  ): Promise<void> {
    if (!this.isOpen(callId)) return;
    await emitVoiceEvent(callId, type, data, sink);
  }

  private isOpen(callId: string): boolean {
    const call = getVoiceCall(callId);
    return Boolean(call && call.state !== "ending" && call.state !== "ended");
  }

  private async setAgentState(callId: string, state: VoiceAgentState): Promise<void> {
    const call = getVoiceCall(callId);
    if (!call || call.state === "ended" || call.agentState === state) return;
    updateVoiceCall(callId, { agentState: state }, this.now());
    await this.emitOpen(callId, "agent.state", { state }, this.sink);
  }

  /**
   * After a daemon restart: live calls cannot reconnect their sideband, so they
   * end; turns that were in flight are marked failed (the session may still
   * finish them, the reply stays in the session).
   */
  private async recoverAfterRestart(): Promise<void> {
    for (const call of listVoiceCalls({ activeOnly: true, limit: "all" })) {
      for (const turn of listVoiceTurns(call.id)) {
        if (turn.state === "queued" || turn.state === "running") {
          updateVoiceTurnState(turn.id, "failed", this.now());
          await this.emitOpen(
            call.id,
            "work.state",
            { turnId: turn.id, state: "failed", reason: "door_restart" },
            this.sink,
          );
        }
      }
      if (call.engine === "live") {
        await this.endCall(call.id, "daemon_restart");
      } else if (call.agentState !== "listening") {
        await this.setAgentState(call.id, "listening");
      }
    }
  }

  private runtime(callId: string): CallRuntime {
    let runtime = this.calls.get(callId);
    if (!runtime) {
      runtime = { callId, queue: [], running: null, draining: false, lastLiveSeconds: 0 };
      this.calls.set(callId, runtime);
    }
    return runtime;
  }

  private profileFor(call: VoiceCall): VoiceProfile {
    return getVoiceProfile(call.profileId) ?? (getVoiceProfile(DEFAULT_VOICE_PROFILE_ID) as VoiceProfile);
  }
}

function normalizeSpeaker(value: unknown, fallback: VoiceSpeaker): VoiceSpeaker {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const kind = record.kind === "guest" || record.kind === "device" || record.kind === "operator" ? record.kind : null;
  const id = typeof record.id === "string" && record.id ? record.id : null;
  if (!kind || !id) return fallback;
  return {
    kind,
    id,
    ...(typeof record.contactId === "string" ? { contactId: record.contactId } : {}),
    ...(typeof record.label === "string" ? { label: record.label.slice(0, 80) } : {}),
  };
}

export function newTurnId(): string {
  return `vt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The engine descriptor the door reports for a call (used by `calls show`). */
export function describeCallEngine(call: VoiceCall) {
  const engine = getVoiceEngine(call.engine);
  return { id: engine.id, label: engine.label, capabilities: engine.capabilities };
}

// ---------------------------------------------------------------------------
// Daemon wiring
// ---------------------------------------------------------------------------

let activeDoor: VoiceDoorService | null = null;

export async function startVoiceDoor(): Promise<VoiceDoorService> {
  if (activeDoor) return activeDoor;
  const [{ nats }, { publishSessionPrompt }, { getRecentHistory }, { registerVoiceGrantorResolver }] =
    await Promise.all([
      import("../nats.js"),
      import("../omni/session-stream.js"),
      import("../db.js"),
      import("./approvals.js"),
    ]);
  registerVoiceGrantorResolver();
  const door = new VoiceDoorService({
    subscribe: (...args) => nats.subscribe(...(args as [string, ...string[]])),
    emit: (topic, data) => nats.emit(topic, data),
    publishPrompt: (sessionName, payload) => publishSessionPrompt(sessionName, payload),
    readHistory: (sessionName, limit) => getRecentHistory(sessionName, limit) as unknown as HistoryMessage[],
  });
  await door.start();
  activeDoor = door;
  return door;
}

export async function stopVoiceDoor(): Promise<void> {
  const door = activeDoor;
  activeDoor = null;
  await door?.stop();
}
