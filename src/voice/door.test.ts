import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { claimApprovalDecision, createApprovalRequest, expireApprovalRequest } from "../approval/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { voiceApprovalMessageId } from "./approvals.js";
import { VoiceDoorService, type VoiceDoorDeps } from "./door.js";
import type { ClipSpeechEngine } from "./engines/types.js";
import {
  appendVoiceEvent,
  getVoiceCall,
  getVoiceDailyUsage,
  insertVoiceCall,
  listVoiceEvents,
  listVoiceTurns,
  saveVoiceProfile,
  defaultVoiceProfile,
  updateOpenVoiceCall,
  updateVoiceCall,
  findActiveVoiceCall,
  listVoiceCalls,
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
  } = {},
) {
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
      setTimeout(async () => {
        // A turn was running when the prompt arrived: the prompt queues, that turn
        // stores its reply and completes, then this turn starts.
        if (options.inFlightReply) {
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "dispatch.queued" });
          history.push({ id: history.length + 1, role: "assistant", content: options.inFlightReply });
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.complete" });
          await tick();
        }
        await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.started" });
        await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "tool.started", toolName: "Bash" });
        if ((options.terminal ?? "turn.complete") === "turn.complete") {
          history.push({
            id: history.length + 1,
            role: "assistant",
            content: options.reply ?? "🔊 Feito.\nTudo certo.",
          });
        }
        await hub.emit(`ravi.session.${sessionName}.runtime`, { type: options.terminal ?? "turn.complete" });
      }, 10);
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
    await until(() => listVoiceTurns(call.id)[0]?.state === "done", "turn done in the session");
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
      publishPrompt: async (sessionName) => {
        setTimeout(() => hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.started" }), 5);
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
    await hub.emit("ravi.session.main.runtime", { type: "turn.interrupted" });
    await until(() => listVoiceTurns(call.id)[0]?.state === "cancelled", "cancelled");
    expect(listVoiceTurns(call.id)).toHaveLength(1);
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
      publishPrompt: async (sessionName) => {
        setTimeout(async () => {
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.started" });
          history.push({ id: 2, role: "assistant", content: "🔊 A reunião é às três.\nDetalhes: sala 2." });
          await hub.emit(`ravi.session.${sessionName}.runtime`, { type: "turn.complete" });
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
        expect(getVoiceCall(call.id)?.agentState).toBe("thinking");
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
});
