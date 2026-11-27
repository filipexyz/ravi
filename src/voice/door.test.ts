import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { claimApprovalDecision, createApprovalRequest, expireApprovalRequest } from "../approval/store.js";
import { dbGetContext } from "../router/router-db.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { voiceApprovalMessageId } from "./approvals.js";
import { VOICE_DEVICE_CAPABILITIES, VOICE_DEVICE_CONTEXT_KIND } from "./authority.js";
import { VoiceDoorService, type VoiceDoorDeps } from "./door.js";
import type { ClipSpeechEngine } from "./engines/types.js";
import {
  addVoiceDailyUsage,
  appendVoiceEvent,
  getVoiceCall,
  getVoiceDailyUsage,
  getVoiceProfileDailyUsage,
  insertVoiceCall,
  listVoiceEvents,
  listVoiceTurns,
  saveVoiceProfile,
  defaultVoiceProfile,
  deleteVoiceProfile,
  updateOpenVoiceCall,
  endOpenVoiceCall,
  updateVoiceCall,
  findActiveVoiceCall,
  listVoiceCalls,
  insertVoiceDevice,
  markVoiceDeviceRevoked,
} from "./store.js";
import { emptyVoiceUsage, type VoiceCall, type VoiceMode, voiceSubjects } from "./types.js";

type Message = { topic: string; data: Record<string, unknown> };

function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.split(".");
  const t = topic.split(".");
  if (p.length !== t.length) return false;
  return p.every((part, index) => part === "*" || part === t[index]);
}

class Hub {
  private subs: Array<{ patterns: string[]; push: (message: Message) => void }> = [];
  published: Message[] = [];
  subscribe = (...args: Array<string | { signal?: AbortSignal }>) => {
    const last = args[args.length - 1];
    const options = typeof last === "object" ? last : {};
    const patterns = args.filter((arg): arg is string => typeof arg === "string");
    const queue: Message[] = [];
    let wake: (() => void) | null = null;
    const sub = {
      patterns,
      push: (message: Message) => {
        queue.push(message);
        wake?.();
      },
    };
    this.subs.push(sub);
    const hub = this;
    return (async function* () {
      try {
        while (!options.signal?.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            wake = null;
            continue;
          }
          yield queue.shift() as Message;
        }
      } finally {
        hub.subs = hub.subs.filter((candidate) => candidate !== sub);
      }
    })();
  };
  emit = async (topic: string, data: Record<string, unknown>) => {
    this.published.push({ topic, data });
    for (const sub of this.subs) {
      if (sub.patterns.some((pattern) => topicMatches(pattern, topic))) sub.push({ topic, data });
    }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

let stateDir: string | null = null;

function makeCall(mode: VoiceMode = "mock", overrides: Partial<VoiceCall> = {}): VoiceCall {
  const now = Date.now();
  return insertVoiceCall({
    id: `vc_test_${Math.random().toString(36).slice(2, 10)}`,
    sessionKey: "agent:main:main",
    sessionName: "main",
    mode,
    engine: mode,
    profileId: "default",
    state: "active",
    agentState: "listening",
    speaker: { kind: "operator", id: "operator" },
    turnOrigin: { producer: "session-relay" },
    connectionKind: "none",
    usage: emptyVoiceUsage(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function harness(
  options: {
    reply?: string;
    terminal?: string;
    clip?: ClipSpeechEngine;
    inFlightReply?: string;
    beforeEmit?: (topic: string, data: Record<string, unknown>) => Promise<void>;
    /** Reply per prompt text, for tests with several calls. */
    replyFor?: (prompt: string) => string;
    /** The session runs one prompt at a time, in arrival order, like the real queue. */
    sessionQueue?: boolean;
    /** Like Claude: the provider emits no `turn.started`. */
    noTurnStarted?: boolean;
    /** An isolated prompt queued earlier runs as its own turn between the in-flight turn and this one. */
    otherPromptQueues?: boolean;
  } = {},
) {
  let sessionChain: Promise<void> = Promise.resolve();
  const hub = new Hub();
  const history: Array<{ id: number; role: string; content: string }> = [{ id: 1, role: "user", content: "old" }];
  const prompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
  const deps: VoiceDoorDeps = {
    subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
    emit: async (topic, data) => {
      await options.beforeEmit?.(topic, data);
      await hub.emit(topic, data);
    },
    publishPrompt: async (sessionName, payload) => {
      prompts.push({ sessionName, payload });
      // The host stamps every runtime event of a physical turn with the ids of the prompts it consumed.
      const own = { _correlationIds: [payload._correlationId] };
      const simulate = async () => {
        // A turn was running when the prompt arrived: the prompt queues, that turn
        // stores its reply and completes, then this turn starts.
        if (options.inFlightReply) {
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "dispatch.queued", reason: "response" });
          history.push({ id: history.length + 1, role: "assistant", content: options.inFlightReply });
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.complete", _correlationIds: [] });
          if (options.otherPromptQueues) {
            history.push({ id: history.length + 1, role: "assistant", content: "Resposta da mensagem isolada." });
            await hub.emit(`ravi.session.${sessionName}.runtime`, {
              type: "turn.complete",
              _correlationIds: ["vt_someone_else"],
            });
          }
          await tick();
        }
        if (!options.noTurnStarted) {
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.started", ...own });
        }
        await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "tool.started", toolName: "Bash", ...own });
        if ((options.terminal ?? "turn.complete") === "turn.complete") {
          history.push({
            id: history.length + 1,
            role: "assistant",
            content: options.replyFor?.(String(payload.prompt)) ?? options.reply ?? "🔊 Feito.\nTudo certo.",
          });
        }
        await hub.emit(`ravi.session.${sessionName}.runtime`, { type: options.terminal ?? "turn.complete", ...own });
      };
      if (options.sessionQueue) {
        sessionChain = sessionChain.then(() => tick()).then(simulate);
      } else {
        setTimeout(simulate, 10);
      }
    },
    readHistory: () => history,
    clipEngines: {
      push: options.clip ?? {
        transcribe: async () => ({ text: "", durationSec: 0, provider: "test" }),
        synthesize: async ({ text }) => ({
          bytes: new Uint8Array([1, 2, 3]),
          mime: "audio/mpeg",
          characters: text.length,
          costUsd: 0.01,
          durationSec: 1,
        }),
      },
      mock: {
        transcribe: async () => ({ text: "", durationSec: 0, provider: "mock" }),
        synthesize: async () => null,
      },
    },
    transcriptWaitMs: 200,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  };
  return { hub, history, prompts, door: new VoiceDoorService(deps) };
}

describe("voice door", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-voice-door-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("turns an utterance into an after-response, sourceless session turn and speaks the lead", async () => {
    const { door, prompts } = harness();
    const call = makeCall("push");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_1",
      text: "manda o resumo",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(call.id)[0]?.state === "done", "turn done");
    await until(() => listVoiceEvents(call.id).some((event) => event.type === "agent.transcript"), "speech");

    const payload = prompts[0]?.payload ?? {};
    expect(prompts[0]?.sessionName).toBe("main");
    expect(payload.deliveryBarrier).toBe("after_response");
    expect(payload._cliDestination).toBe(true);
    expect(payload.source).toBeUndefined();
    expect(payload._approvalSource).toEqual({ channel: "voice", accountId: "voice", chatId: call.id });
    expect(String(payload.prompt)).toContain("manda o resumo");

    const types = listVoiceEvents(call.id).map((event) => event.type);
    expect(types).toContain("user.transcript");
    expect(types).toContain("turn.accepted");
    expect(types).toContain("work.tool");
    const completed = listVoiceEvents(call.id).find((event) => event.type === "turn.completed");
    expect(completed?.data.spokenText).toBe("Feito.");
    expect(completed?.data.fullText).toBe("Tudo certo.");
    const spoken = listVoiceEvents(call.id).find((event) => event.type === "agent.transcript");
    expect((spoken?.data.audio as { item: string } | undefined)?.item).toBe("va_vt_1");
    expect(getVoiceCall(call.id)?.usage.charactersSpoken).toBe(6);
  });

  it("speaks only its own turn's reply, not the reply of the turn that was in flight", async () => {
    const { door } = harness({ inFlightReply: "Resposta de outro turno.", reply: "🔊 Só a minha.\nDetalhe." });
    const call = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_own",
      text: "e a minha?",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(call.id)[0]?.state === "done", "turn done");
    const completed = listVoiceEvents(call.id).find((event) => event.type === "turn.completed");
    expect(completed?.data.spokenText).toBe("Só a minha.");
    expect(String(completed?.data.fullText)).not.toContain("outro turno");
  });

  it("a provider without turn.started still ends a turn queued behind two others (Claude, isolated prompt)", async () => {
    const { door, prompts } = harness({
      inFlightReply: "Resposta de outro turno.",
      reply: "🔊 Oi, tô ouvindo.\nDetalhe.",
      noTurnStarted: true,
      otherPromptQueues: true,
    });
    const call = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_claude",
      text: "oi",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(call.id)[0]?.state === "done", "turn done");
    expect(prompts[0]?.payload._correlationId).toBe("vt_claude");
    const completed = listVoiceEvents(call.id).find((event) => event.type === "turn.completed");
    expect(completed?.data.spokenText).toBe("Oi, tô ouvindo.");
    expect(String(completed?.data.fullText)).not.toContain("outro turno");
    expect(String(completed?.data.fullText)).not.toContain("mensagem isolada");
  });

  it("another prompt queuing on the session never makes this turn skip its own terminal", async () => {
    const hub = new Hub();
    const history = [{ id: 1, role: "user", content: "old" }];
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async (sessionName, payload) => {
        setTimeout(async () => {
          // Idle session: this prompt starts at once. A Slack message then queues behind it.
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "dispatch.queued", reason: "response" });
          history.push({ id: 2, role: "assistant", content: "🔊 Minha.\nResto." });
          await hub.emit(`ravi.session.${sessionName}.runtime`, {
            type: "turn.complete",
            _correlationIds: [payload._correlationId],
          });
        }, 5);
      },
      readHistory: () => history,
      transcriptWaitMs: 50,
    });
    const call = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_idle",
      text: "oi",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(call.id)[0]?.state === "done", "turn done");
    const completed = listVoiceEvents(call.id).find((event) => event.type === "turn.completed");
    expect(completed?.data.spokenText).toBe("Minha.");
  });

  it("ending the call frees a turn still waiting on the session, so the next call's turn runs", async () => {
    const hub = new Hub();
    const history = [{ id: 1, role: "user", content: "old" }];
    let answerSecond = false;
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async (sessionName, payload) => {
        // The first turn never gets a terminal; the second one does.
        if (payload._correlationId !== "vt_second") return;
        answerSecond = true;
        setTimeout(async () => {
          history.push({ id: 2, role: "assistant", content: "🔊 Segunda.\nOk." });
          await hub.emit(`ravi.session.${sessionName}.runtime`, {
            type: "turn.complete",
            _correlationIds: ["vt_second"],
          });
        }, 5);
      },
      readHistory: () => history,
      transcriptWaitMs: 50,
    });
    const first = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: first.id,
      turnId: "vt_stuck",
      text: "oi",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(first.id)[0]?.state === "running", "first running");
    await door.endCall(first.id, "ended");
    await until(() => listVoiceTurns(first.id)[0]?.state === "cancelled", "first released");
    expect(hub.published.some((message) => message.topic === "ravi.session.abort")).toBe(false);

    const second = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: second.id,
      turnId: "vt_second",
      text: "e essa, chegou?",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(second.id)[0]?.state === "done", "second done");
    expect(answerSecond).toBe(true);
  });

  it("an ended call gets no more output, and a late write never revives it", async () => {
    const { door } = harness();
    const call = makeCall("push");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_late",
      text: "demora",
      speaker: { kind: "operator", id: "operator" },
    });
    await door.handleControl({ op: "end", callId: call.id, reason: "user" });
    // The call stops waiting on the session at once; the session turn keeps its reply.
    await until(() => listVoiceTurns(call.id)[0]?.state === "cancelled", "turn released by the end");
    await tick();
    const types = listVoiceEvents(call.id).map((event) => event.type);
    const endedAt = types.indexOf("call.ended");
    expect(endedAt).toBeGreaterThanOrEqual(0);
    expect(types.slice(endedAt + 1)).toEqual([]);
    updateVoiceCall(call.id, { state: "active", agentState: "listening" });
    expect(getVoiceCall(call.id)?.state).toBe("ended");
  });

  it("records nothing after call.ended even when the call ends while an event is being published", async () => {
    let doorRef: VoiceDoorService | null = null;
    let callId = "";
    const { door } = harness({
      beforeEmit: async (_topic, data) => {
        const inner = data.data as { state?: string } | undefined;
        // The call ends while `work.state done` is still being published.
        if (data.type === "work.state" && inner?.state === "done") {
          await doorRef?.handleControl({ op: "end", callId, reason: "user" });
        }
      },
    });
    doorRef = door;
    const call = makeCall("push");
    callId = call.id;
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_race",
      text: "corrida",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceEvents(call.id).some((event) => event.type === "call.ended"), "ended");
    await tick();
    await tick();
    const types = listVoiceEvents(call.id).map((event) => event.type);
    expect(types.slice(types.indexOf("call.ended") + 1)).toEqual([]);
    expect(types).not.toContain("turn.completed");
  });

  it("finds a speaker's active call past the newest fifty", () => {
    const first = makeCall("mock", { speaker: { kind: "device", id: "vd_old" } });
    for (let i = 0; i < 55; i++) makeCall("mock", { speaker: { kind: "device", id: `vd_${i}` } });
    expect(findActiveVoiceCall("agent:main:main", "vd_old")?.id).toBe(first.id);
    expect(listVoiceCalls({ activeOnly: true, limit: "all" }).length).toBe(56);
  });

  it("runs one turn at a time per call, in order", async () => {
    const { door, prompts } = harness();
    const call = makeCall("mock");
    for (const [index, text] of ["primeiro", "segundo"].entries()) {
      await door.handleControl({
        op: "utterance",
        callId: call.id,
        turnId: `vt_${index}`,
        text,
        speaker: { kind: "operator", id: "operator" },
      });
    }
    await until(() => listVoiceTurns(call.id).every((turn) => turn.state === "done"), "both done");
    expect(prompts.map((prompt) => String(prompt.payload.prompt).split("\n").at(-1))).toEqual(["primeiro", "segundo"]);
  });

  it("drops guest speech unless the profile accepts guests", async () => {
    const { door, prompts } = harness();
    const call = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_g",
      text: "apaga tudo",
      speaker: { kind: "guest", id: "guest:tv" },
    });
    await tick();
    expect(prompts).toHaveLength(0);
    expect(listVoiceEvents(call.id).some((event) => event.data.code === "VOICE_GUEST_FORBIDDEN")).toBe(true);

    saveVoiceProfile({ ...defaultVoiceProfile(), id: "guests", allowGuests: true });
    const open = makeCall("mock", { profileId: "guests", speaker: { kind: "operator", id: "op2" } });
    await door.handleControl({
      op: "utterance",
      callId: open.id,
      turnId: "vt_g2",
      text: "qual o horário?",
      speaker: { kind: "guest", id: "guest:cliente", label: "cliente" },
    });
    await until(() => prompts.length === 1, "guest prompt");
    expect(String(prompts[0]?.payload.prompt)).toContain("Guest speaker (cliente)");
    await until(() => listVoiceTurns(open.id)[0]?.state === "done", "guest turn done");
  });

  it("a spoken cancel aborts only the call's running turn", async () => {
    const hub = new Hub();
    const history = [{ id: 1, role: "user", content: "old" }];
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async (sessionName, payload) => {
        setTimeout(
          () =>
            hub.emit(`ravi.session.${sessionName}.runtime`, {
              type: "turn.started",
              _correlationIds: [payload._correlationId],
            }),
          5,
        );
      },
      readHistory: () => history,
      transcriptWaitMs: 50,
    });
    const call = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_long",
      text: "faz o relatório",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceEvents(call.id).some((event) => event.data.state === "running"), "running");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_cancel",
      text: "cancela",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => hub.published.some((message) => message.topic === "ravi.session.abort"), "abort");
    const abort = hub.published.find((message) => message.topic === "ravi.session.abort");
    expect(abort?.data).toMatchObject({ sessionName: "main", source: "voice", correlationId: "vt_long" });
    await hub.emit("ravi.session.main.runtime", { type: "turn.interrupted", _correlationIds: ["vt_long"] });
    await until(() => listVoiceTurns(call.id)[0]?.state === "cancelled", "cancelled");
    expect(listVoiceTurns(call.id)).toHaveLength(1);
  });

  it("live: a spoken cancel is read from the last utterance, not from the whole request", async () => {
    const hub = new Hub();
    let handlers: any = null;
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async (sessionName, payload) => {
        setTimeout(
          () =>
            hub.emit(`ravi.session.${sessionName}.runtime`, {
              type: "turn.started",
              _correlationIds: [payload._correlationId],
            }),
          5,
        );
      },
      readHistory: () => [],
      env: { RAVI_VOICE_OPENAI_API_KEY: "k" },
      createSideband: (input) => {
        handlers = input.handlers;
        return { connect: () => {}, commentary: () => {}, thinking: () => {}, close: () => {} };
      },
      closeLiveProviderSession: async () => {},
      transcriptWaitMs: 50,
    });
    const call = makeCall("live", { state: "starting" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_c" });
    handlers.onDelegation({ delegationId: "d1", text: "faz o relatório", displayText: "faz o relatório" });
    await until(() => listVoiceEvents(call.id).some((event) => event.data.state === "running"), "running");
    handlers.onDelegation({ delegationId: "d2", text: "E aí para", displayText: "para", lastUtterance: "para" });
    await until(() => hub.published.some((message) => message.topic === "ravi.session.abort"), "abort");
    expect(listVoiceTurns(call.id)).toHaveLength(1);
  });

  it("a cancel while queued behind another turn never aborts that turn; it aborts its own once it starts", async () => {
    const hub = new Hub();
    const history = [{ id: 1, role: "user", content: "old" }];
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async () => {},
      readHistory: () => history,
      transcriptWaitMs: 50,
    });
    const call = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_queued",
      text: "faz o relatório",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(call.id)[0]?.state === "running", "running");
    await door.handleControl({ op: "cancel-turn", callId: call.id, turnId: "vt_queued", actor: "operator" });
    // The turn ahead (someone else's) progresses and ends: no abort may target it.
    await hub.emit("ravi.session.main.runtime", { type: "tool.started", toolName: "Bash", _correlationIds: [] });
    await hub.emit("ravi.session.main.runtime", { type: "turn.complete", _correlationIds: ["vt_other"] });
    await tick();
    expect(hub.published.some((message) => message.topic === "ravi.session.abort")).toBe(false);
    // This turn's first event arrives: now the abort is its own.
    await hub.emit("ravi.session.main.runtime", { type: "runtime.status", _correlationIds: ["vt_queued"] });
    await until(() => hub.published.some((message) => message.topic === "ravi.session.abort"), "abort");
    expect(hub.published.find((message) => message.topic === "ravi.session.abort")?.data).toMatchObject({
      correlationId: "vt_queued",
    });
    await hub.emit("ravi.session.main.runtime", { type: "turn.interrupted", _correlationIds: ["vt_queued"] });
    await until(() => listVoiceTurns(call.id)[0]?.state === "cancelled", "cancelled");
  });

  it("speaks a failure line when the turn fails", async () => {
    const { door } = harness({ terminal: "turn.failed" });
    const call = makeCall("mock");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_f",
      text: "x",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(call.id)[0]?.state === "failed", "failed");
    await until(() => listVoiceEvents(call.id).some((event) => event.type === "agent.transcript"), "failure line");
    expect(listVoiceEvents(call.id).some((event) => event.data.code === "VOICE_TURN_FAILED")).toBe(true);
  });

  it("ends the call when its spend limit is reached and counts the day's usage", async () => {
    saveVoiceProfile({ ...defaultVoiceProfile(), id: "cheap", maxCallCostUsd: 0.005 });
    const { door } = harness();
    const call = makeCall("push", { profileId: "cheap" });
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_l",
      text: "oi",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => getVoiceCall(call.id)?.state === "ended", "ended by limit");
    expect(getVoiceCall(call.id)?.endedReason).toBe("limit");
    expect(getVoiceDailyUsage().costUsd).toBeGreaterThan(0);
  });

  it("meters the daily limit per profile: another profile's spend neither blocks nor ends a call", async () => {
    addVoiceDailyUsage("busy", 5, 60);
    saveVoiceProfile({ ...defaultVoiceProfile(), id: "quiet", maxDailyCostUsd: 1 });
    const { door } = harness();
    const call = makeCall("push", { profileId: "quiet" });
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_q",
      text: "oi",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => listVoiceTurns(call.id)[0]?.state === "done", "turn done");
    await until(() => getVoiceProfileDailyUsage("quiet").costUsd > 0, "quiet metered");
    expect(getVoiceCall(call.id)?.state).not.toBe("ended");
    expect(listVoiceEvents(call.id).some((event) => event.data.limit === "max_daily_cost")).toBe(false);
    expect(getVoiceProfileDailyUsage("busy").costUsd).toBe(5);
    expect(getVoiceDailyUsage().costUsd).toBeCloseTo(5 + getVoiceProfileDailyUsage("quiet").costUsd, 5);
  });

  it("a call whose profile was deleted spends and is limited on the default profile", async () => {
    saveVoiceProfile({ ...defaultVoiceProfile(), maxCallCostUsd: 100, maxDailyCostUsd: 0.005 });
    saveVoiceProfile({ ...defaultVoiceProfile(), id: "gone", maxCallCostUsd: 100, maxDailyCostUsd: 100 });
    const { door } = harness();
    const call = makeCall("push", { profileId: "gone" });
    deleteVoiceProfile("gone");
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_g",
      text: "oi",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => getVoiceCall(call.id)?.state === "ended", "ended by the default daily limit");
    expect(listVoiceEvents(call.id).some((event) => event.data.limit === "max_daily_cost")).toBe(true);
    expect(getVoiceProfileDailyUsage("default").costUsd).toBeGreaterThan(0);
    expect(getVoiceProfileDailyUsage("gone").costUsd).toBe(0);
  });

  it("ends the call when its own profile reaches the daily limit", async () => {
    saveVoiceProfile({ ...defaultVoiceProfile(), id: "tight", maxCallCostUsd: 100, maxDailyCostUsd: 0.005 });
    const { door } = harness();
    const call = makeCall("push", { profileId: "tight" });
    await door.handleControl({
      op: "utterance",
      callId: call.id,
      turnId: "vt_t",
      text: "oi",
      speaker: { kind: "operator", id: "operator" },
    });
    await until(() => getVoiceCall(call.id)?.state === "ended", "ended by daily limit");
    expect(getVoiceCall(call.id)?.endedReason).toBe("limit");
    expect(listVoiceEvents(call.id).some((event) => event.data.limit === "max_daily_cost")).toBe(true);
  });

  it("live calls end on restart; other calls survive and in-flight turns fail", async () => {
    const live = makeCall("live");
    const push = makeCall("push", { speaker: { kind: "operator", id: "other" } });
    const { door } = harness();
    const { insertVoiceTurn } = await import("./store.js");
    insertVoiceTurn({
      id: "vt_stuck",
      callId: push.id,
      text: "x",
      speaker: push.speaker,
      state: "running",
      createdAt: Date.now(),
    });
    await door.start();
    await door.stop();
    expect(getVoiceCall(live.id)?.state).toBe("ended");
    expect(getVoiceCall(live.id)?.endedReason).toBe("daemon_restart");
    expect(getVoiceCall(push.id)?.state).toBe("active");
    expect(listVoiceTurns(push.id)[0]?.state).toBe("failed");
  });

  it("live delegations become turns and results go back as commentary", async () => {
    const frames: Array<{ kind: string; text: string; id: string | null }> = [];
    let handlers: any = null;
    const hub = new Hub();
    const history = [{ id: 1, role: "user", content: "old" }];
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async (sessionName, payload) => {
        setTimeout(async () => {
          const own = { _correlationIds: [payload._correlationId] };
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.started", ...own });
          history.push({ id: 2, role: "assistant", content: "🔊 A reunião é às três.\nDetalhes: sala 2." });
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.complete", ...own });
        }, 5);
      },
      readHistory: () => history,
      env: { RAVI_VOICE_OPENAI_API_KEY: "k" },
      createSideband: (input) => {
        handlers = input.handlers;
        return {
          connect: () => {},
          commentary: (text, id) => frames.push({ kind: "commentary", text, id }),
          thinking: (text, id) => frames.push({ kind: "thinking", text, id }),
          close: () => {},
        };
      },
      closeLiveProviderSession: async () => {},
      transcriptWaitMs: 100,
    });
    const call = makeCall("live", { state: "starting" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_1" });
    expect(getVoiceCall(call.id)?.state).toBe("active");
    handlers.onDelegation({ delegationId: "d1", text: "que horas é a reunião?" });
    await until(() => frames.some((frame) => frame.kind === "commentary"), "commentary");
    expect(frames.find((frame) => frame.kind === "commentary")).toEqual({
      kind: "commentary",
      text: "A reunião é às três.",
      id: "d1",
    });
    expect(frames.find((frame) => frame.kind === "thinking")?.text).toBe("Detalhes: sala 2.");
    handlers.onUsage({ seconds: 60 });
    await until(() => (getVoiceCall(call.id)?.usage.engineSeconds ?? 0) === 60, "usage");
    expect(getVoiceCall(call.id)?.usage.estimatedCostUsd).toBeCloseTo(0.05, 5);
  });

  it("live gets sanitized context, never secrets or paths from the screen text", async () => {
    const frames: Array<{ kind: string; text: string; id: string | null }> = [];
    let handlers: any = null;
    const hub = new Hub();
    const history = [{ id: 1, role: "user", content: "old" }];
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async (sessionName, payload) => {
        setTimeout(async () => {
          const own = { _correlationIds: [payload._correlationId] };
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.started", ...own });
          history.push({
            id: 2,
            role: "assistant",
            content: "🔊 Pronto.\nChave sk-abcdefghijklmnop1234 em /Users/luis/.ravi/.env, ver https://x.example/a",
          });
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.complete", ...own });
        }, 5);
      },
      readHistory: () => history,
      env: { RAVI_VOICE_OPENAI_API_KEY: "k" },
      createSideband: (input) => {
        handlers = input.handlers;
        return {
          connect: () => {},
          commentary: (text, id) => frames.push({ kind: "commentary", text, id }),
          thinking: (text, id) => frames.push({ kind: "thinking", text, id }),
          close: () => {},
        };
      },
      closeLiveProviderSession: async () => {},
      transcriptWaitMs: 100,
    });
    const call = makeCall("live", { state: "starting" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_s" });
    handlers.onDelegation({ delegationId: "d1", text: "onde está a chave?" });
    await until(() => frames.some((frame) => frame.kind === "commentary"), "commentary");
    const sent = JSON.stringify(frames);
    expect(sent).not.toContain("sk-abcdefghijklmnop1234");
    expect(sent).not.toContain("/Users/luis");
    expect(sent).not.toContain("https://");
  });

  it("ending a live call drains pending speech while the call still accepts transcripts", async () => {
    const hub = new Hub();
    const statesAtDrain: Array<string | undefined> = [];
    let handlers: any = null;
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async () => {},
      readHistory: () => [],
      env: { RAVI_VOICE_OPENAI_API_KEY: "k" },
      createSideband: (input) => {
        handlers = input.handlers;
        return {
          connect: () => {},
          commentary: () => {},
          thinking: () => {},
          drain: () => {
            statesAtDrain.push(getVoiceCall(call.id)?.state);
            handlers.onUserTranscript("até amanhã");
          },
          close: () => {},
        };
      },
      closeLiveProviderSession: async () => {},
      transcriptWaitMs: 100,
    });
    const call = makeCall("live", { state: "starting" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_d" });
    await door.endCall(call.id, "ended");
    expect(statesAtDrain).toEqual(["active"]);
  });

  it("a second connect replaces the sideband without ending the call; closing the current one ends it", async () => {
    const all: any[] = [];
    const hub = new Hub();
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async () => {},
      readHistory: () => [],
      env: { RAVI_VOICE_OPENAI_API_KEY: "k" },
      createSideband: (input) => {
        const handlers = input.handlers;
        all.push(handlers);
        // Like the real sideband: close reports closed_by_door synchronously.
        return {
          connect: () => {},
          commentary: () => {},
          thinking: () => {},
          close: () => handlers.onClosed("closed_by_door"),
        };
      },
      closeLiveProviderSession: async () => {},
    });
    const call = makeCall("live", { state: "starting" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_1" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_2" });
    await tick();
    expect(getVoiceCall(call.id)).toMatchObject({ state: "active", providerRef: "ls_2" });
    all[0].onClosed("remote_closed");
    await tick();
    expect(getVoiceCall(call.id)?.state).toBe("active");
    all[1].onClosed("remote_closed");
    await until(() => getVoiceCall(call.id)?.state === "ended", "ended by current sideband");
  });

  it("a replaced live sideband starts no work; displayText decides what shows", async () => {
    const all: any[] = [];
    const prompts: string[] = [];
    const hub = new Hub();
    const door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit: hub.emit,
      publishPrompt: async (_session, payload: any) => {
        prompts.push(String(payload.prompt ?? payload.text ?? ""));
      },
      readHistory: () => [],
      env: { RAVI_VOICE_OPENAI_API_KEY: "k" },
      createSideband: (input) => {
        all.push(input.handlers);
        return { connect: () => {}, commentary: () => {}, thinking: () => {}, close: () => {} };
      },
      closeLiveProviderSession: async () => {},
      transcriptWaitMs: 50,
    });
    const call = makeCall("live", { state: "starting" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_1" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_2" });
    // The retired sideband's late delegation is ignored.
    all[0].onDelegation({ delegationId: "d0", text: "não faz nada", displayText: "não faz nada" });
    await tick();
    expect(prompts).toHaveLength(0);
    // The current one delegates; the text already on screen is not shown again.
    all[1].onDelegation({ delegationId: "d1", text: "oi manda o resumo", displayText: "manda o resumo" });
    await until(() => prompts.length === 1, "prompt published");
    expect(prompts[0]).toContain("oi manda o resumo");
  });

  it("a sideband replaced while the transcript is published starts no turn", async () => {
    const all: any[] = [];
    const prompts: string[] = [];
    const hub = new Hub();
    let door: VoiceDoorService | null = null;
    let replaceOnce = true;
    const emit: VoiceDoorDeps["emit"] = async (topic, data) => {
      await hub.emit(topic, data);
      if (replaceOnce && (data as any)?.type === "user.transcript") {
        replaceOnce = false;
        await door?.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_new" });
      }
    };
    door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit,
      publishPrompt: async (_session, payload: any) => {
        prompts.push(String(payload.prompt ?? ""));
      },
      readHistory: () => [],
      env: { RAVI_VOICE_OPENAI_API_KEY: "k" },
      createSideband: (input) => {
        all.push(input.handlers);
        return { connect: () => {}, commentary: () => {}, thinking: () => {}, close: () => {} };
      },
      closeLiveProviderSession: async () => {},
      transcriptWaitMs: 50,
    });
    const call = makeCall("live", { state: "starting" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_old" });
    all[0].onDelegation({ delegationId: "d1", text: "faz o relatório", displayText: "faz o relatório" });
    await tick();
    await tick();
    expect(listVoiceTurns(call.id)).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("a spoken cancel from a sideband replaced while the transcript is published cancels nothing", async () => {
    const all: any[] = [];
    const hub = new Hub();
    let door: VoiceDoorService | null = null;
    let replaceOnTranscript = false;
    const emit: VoiceDoorDeps["emit"] = async (topic, data) => {
      await hub.emit(topic, data);
      if (replaceOnTranscript && (data as any)?.type === "user.transcript") {
        replaceOnTranscript = false;
        await door?.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_new" });
      }
    };
    door = new VoiceDoorService({
      subscribe: hub.subscribe as VoiceDoorDeps["subscribe"],
      emit,
      publishPrompt: async (sessionName, payload) => {
        setTimeout(
          () =>
            hub.emit(`ravi.session.${sessionName}.runtime`, {
              type: "turn.started",
              _correlationIds: [payload._correlationId],
            }),
          5,
        );
      },
      readHistory: () => [],
      env: { RAVI_VOICE_OPENAI_API_KEY: "k" },
      createSideband: (input) => {
        all.push(input.handlers);
        return { connect: () => {}, commentary: () => {}, thinking: () => {}, close: () => {} };
      },
      closeLiveProviderSession: async () => {},
      transcriptWaitMs: 50,
    });
    const call = makeCall("live", { state: "starting" });
    await door.handleControl({ op: "live-attach", callId: call.id, providerSessionId: "ls_old" });
    all[0].onDelegation({ delegationId: "d1", text: "faz o relatório", displayText: "faz o relatório" });
    await until(() => listVoiceEvents(call.id).some((event) => event.data.state === "running"), "running");
    replaceOnTranscript = true;
    all[0].onDelegation({ delegationId: "d2", text: "para", displayText: "para", lastUtterance: "para" });
    await tick();
    await tick();
    expect(hub.published.some((message) => message.topic === "ravi.session.abort")).toBe(false);
  });

  it("a turn that throws does not stall the turns queued behind it", async () => {
    const { door, prompts } = harness();
    const call = makeCall("push");
    let first = true;
    const original = (door as any).runTurn.bind(door);
    (door as any).runTurn = async (...args: unknown[]) => {
      if (first) {
        first = false;
        throw new Error("publish failed");
      }
      return original(...args);
    };
    for (const turnId of ["vt_boom", "vt_after"]) {
      await door.handleControl({
        op: "utterance",
        callId: call.id,
        turnId,
        text: turnId,
        speaker: { ...call.speaker },
      });
    }
    await until(() => listVoiceTurns(call.id).find((turn) => turn.id === "vt_after")?.state === "done", "second turn");
    expect(listVoiceTurns(call.id).find((turn) => turn.id === "vt_boom")?.state).toBe("failed");
    expect(prompts).toHaveLength(1);
  });

  it("a revoke interrupted after the device record is finished by the sweep", async () => {
    const context = createRuntimeContext({
      kind: VOICE_DEVICE_CONTEXT_KIND,
      capabilities: VOICE_DEVICE_CAPABILITIES.map((capability) => ({ ...capability })),
      metadata: { voiceDeviceId: "vd_cut" },
      ttlMs: 60_000,
    });
    insertVoiceDevice({
      id: "vd_cut",
      label: "phone",
      contactId: "contact_1",
      sessions: ["agent:main:main"],
      contextId: context.contextId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const call = makeCall("push", { speaker: { kind: "device", id: "vd_cut" } });
    // `devices revoke` wrote the device record and stopped before the context.
    markVoiceDeviceRevoked("vd_cut");
    expect(dbGetContext(context.contextId)?.revokedAt).toBeFalsy();
    const { door } = harness();
    await door.sweepNow();
    expect(dbGetContext(context.contextId)?.revokedAt).toBeTruthy();
    expect(getVoiceCall(call.id)?.state).toBe("ended");
    expect(getVoiceCall(call.id)?.endedReason).toBe("device_revoked");
    // A second sweep finds nothing left to do.
    await door.sweepNow();
  });

  it("a turn waiting for the session behind another call can still be cancelled", async () => {
    const { door, prompts } = harness({ sessionQueue: true });
    const first = makeCall("push");
    const second = makeCall("push", { speaker: { kind: "device", id: "vd_wait" } });
    await door.handleControl({
      op: "utterance",
      callId: first.id,
      turnId: "vt_hold",
      text: "primeira",
      speaker: { ...first.speaker },
    });
    await door.handleControl({
      op: "utterance",
      callId: second.id,
      turnId: "vt_wait",
      text: "segunda",
      speaker: { ...second.speaker },
    });
    await door.handleControl({ op: "cancel-turn", callId: second.id, turnId: "vt_wait", actor: "operator" });
    await until(() => listVoiceTurns(first.id)[0]?.state === "done", "first turn done");
    await tick();
    await tick();
    expect(listVoiceTurns(second.id)[0]?.state).toBe("cancelled");
    expect(prompts).toHaveLength(1);
  });

  it("two calls on one session each speak their own reply", async () => {
    const { door, prompts } = harness({
      sessionQueue: true,
      replyFor: (prompt) => (prompt.includes("primeira") ? "🔊 Resposta um." : "🔊 Resposta dois."),
    });
    const first = makeCall("push");
    const second = makeCall("push", { speaker: { kind: "device", id: "vd_two" } });
    await Promise.all([
      door.handleControl({
        op: "utterance",
        callId: first.id,
        turnId: "vt_one",
        text: "primeira pergunta",
        speaker: { ...first.speaker },
      }),
      door.handleControl({
        op: "utterance",
        callId: second.id,
        turnId: "vt_two",
        text: "segunda pergunta",
        speaker: { ...second.speaker },
      }),
    ]);
    const spoken = (callId: string) =>
      listVoiceEvents(callId)
        .filter((event) => event.type === "agent.transcript")
        .map((event) => String(event.data.text));
    await until(() => spoken(first.id).length > 0 && spoken(second.id).length > 0, "both replies");
    expect(spoken(first.id)).toEqual(["Resposta um."]);
    expect(spoken(second.id)).toEqual(["Resposta dois."]);
    // The second prompt reached the session only after the first turn ended.
    expect(prompts).toHaveLength(2);
  });

  it("publishes an approval the store committed after the tap stopped waiting, approved or denied", async () => {
    const { hub, door } = harness();
    await door.start();
    try {
      for (const [approvalId, decision] of [
        ["req_late_ok", "approved"],
        ["req_late_no", "rejected"],
      ] as const) {
        const call = makeCall();
        const now = Date.now();
        createApprovalRequest({
          id: approvalId,
          type: "permission",
          channel: "voice",
          accountId: "voice",
          chatId: call.id,
          createdAt: now,
          expiresAt: now + 60_000,
        });
        appendVoiceEvent(call.id, "turn.approval_requested", { approvalId, version: 1, digest: "d", text: "x" });
        // `calls approve` already returned `pending`; the service commits later.
        claimApprovalDecision({ id: approvalId, decision, decidedBy: "contact_owner", now });
        const response = { approved: decision === "approved", messageId: voiceApprovalMessageId(call.id, approvalId) };
        await hub.emit("ravi.approval.response", response);
        await hub.emit("ravi.approval.response", response);
        await until(
          () => listVoiceEvents(call.id).some((event) => event.type === "turn.approval_resolved"),
          `${decision} resolved`,
        );
        await tick();
        const resolved = hub.published.filter(
          (message) => message.topic === voiceSubjects.event(call.id) && message.data.type === "turn.approval_resolved",
        );
        expect(resolved).toHaveLength(1);
        expect(resolved[0]?.data.data).toMatchObject({ approvalId, decision, by: "contact_owner" });
        // No turn of this call is running: a late outcome leaves the state alone.
        expect(getVoiceCall(call.id)?.agentState).toBe("listening");
      }
    } finally {
      await door.stop();
    }
  });

  it("an expired approval leaves the call as expired, and a pending one stays open", async () => {
    const { door } = harness();
    const call = makeCall();
    const now = Date.now();
    for (const id of ["req_exp", "req_wait"]) {
      createApprovalRequest({
        id,
        type: "permission",
        channel: "voice",
        accountId: "voice",
        chatId: call.id,
        createdAt: now,
        expiresAt: now + 60_000,
      });
      appendVoiceEvent(call.id, "turn.approval_requested", { approvalId: id, version: 1, digest: "d", text: "x" });
    }
    expireApprovalRequest("req_exp", now);
    await door.reconcileApproval(call.id, "req_exp");
    await door.reconcileApproval(call.id, "req_wait");
    const resolved = listVoiceEvents(call.id).filter((event) => event.type === "turn.approval_resolved");
    expect(resolved.map((event) => event.data)).toEqual([{ approvalId: "req_exp", decision: "expired" }]);
  });

  it("a connect that lands after end cannot reopen the call", () => {
    const call = makeCall("live", { state: "starting", agentState: "idle" });
    // `end` wins first; the late connect's compare-and-set is refused.
    updateVoiceCall(call.id, { state: "ending" });
    expect(updateOpenVoiceCall(call.id, { state: "active", agentState: "listening", providerRef: "sess_late" })).toBe(
      null,
    );
    expect(getVoiceCall(call.id)).toMatchObject({ state: "ending", agentState: "idle" });
    expect(getVoiceCall(call.id)?.providerRef).toBeUndefined();
    // On an open call the same write applies, only to the patched columns.
    const open = makeCall("live", { state: "starting", agentState: "idle" });
    expect(updateOpenVoiceCall(open.id, { state: "active", providerRef: "sess_ok" })).toMatchObject({
      state: "active",
      agentState: "idle",
      providerRef: "sess_ok",
    });
  });

  it("a failed start never overwrites an end the daemon already wrote", () => {
    const call = makeCall("live", { state: "active", agentState: "listening" });
    updateVoiceCall(call.id, { state: "ended", endedReason: "hangup", endedAt: 1 });
    expect(endOpenVoiceCall(call.id, "connect_failed")).toBe(false);
    expect(getVoiceCall(call.id)).toMatchObject({ state: "ended", endedReason: "hangup", endedAt: 1 });
    const ending = makeCall("live", { state: "ending", agentState: "idle" });
    expect(endOpenVoiceCall(ending.id, "connect_failed")).toBe(false);
    expect(getVoiceCall(ending.id)?.state).toBe("ending");
    // An open call is ended with the start's reason.
    const open = makeCall("live", { state: "starting", agentState: "idle" });
    expect(endOpenVoiceCall(open.id, "connect_failed", 42)).toBe(true);
    expect(getVoiceCall(open.id)).toMatchObject({ state: "ended", endedReason: "connect_failed", endedAt: 42 });
  });
});
