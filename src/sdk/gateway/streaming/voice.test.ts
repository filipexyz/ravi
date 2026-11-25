import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ScopeContext } from "../../../permissions/scope.js";
import type { ContextRecord } from "../../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../../test/ravi-state.js";
import { appendVoiceEvent, insertVoiceCall, insertVoiceDevice } from "../../../voice/store.js";
import { emptyVoiceUsage, type VoiceEvent } from "../../../voice/types.js";
import type { StreamEvent } from "./types.js";
import { createVoiceCallChannel } from "./voice.js";

let stateDir: string | null = null;

function call(id: string, speakerId = "operator", mode: "mock" | "handsfree" = "mock") {
  const now = Date.now();
  return insertVoiceCall({
    id,
    sessionKey: "agent:main:main",
    sessionName: "main",
    mode,
    engine: mode,
    profileId: "default",
    state: "active",
    agentState: "listening",
    speaker: speakerId === "operator" ? { kind: "operator", id: "operator" } : { kind: "device", id: speakerId },
    connectionKind: "none",
    usage: emptyVoiceUsage(),
    ...(speakerId === "operator" ? { callerContextId: "ctx_op" } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

function ctx(path: string, signal: AbortSignal, record?: Partial<ContextRecord>) {
  return {
    url: new URL(`http://test/api/v1/_stream/${path}`),
    signal,
    context: {} as ScopeContext,
    contextRecord: { contextId: "ctx_op", kind: "cli-runtime", ...record } as ContextRecord,
  };
}

/** A fake bus: pushes are delivered to the live subscriber of the call topic. */
function fakeBus() {
  const queue: VoiceEvent[] = [];
  let notify: (() => void) | null = null;
  return {
    push(event: VoiceEvent) {
      queue.push(event);
      notify?.();
    },
    subscribe: (signal: AbortSignal, _topic: string) =>
      (async function* () {
        while (!signal.aborted) {
          if (!queue.length) {
            await new Promise<void>((resolve) => {
              notify = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            notify = null;
            continue;
          }
          yield { topic: _topic, data: queue.shift() as unknown as Record<string, unknown> };
        }
      })(),
  };
}

describe("voice/{call} stream", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-voice-stream-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("matches voice/<call> with access voice-call scope", () => {
    const channel = createVoiceCallChannel();
    expect(channel.match(["voice", "vc_1"], new URL("http://t/"))).toEqual({
      channelPath: "voice/vc_1",
      scope: { permission: "access", objectType: "voice-call", objectId: "vc_1" },
    });
    expect(channel.match(["voice"], new URL("http://t/"))).toBeNull();
  });

  it("opens with a snapshot, replays after the cursor, follows live and ends on call.ended", async () => {
    call("vc_s");
    appendVoiceEvent("vc_s", "user.transcript", { text: "um" });
    appendVoiceEvent("vc_s", "agent.transcript", { text: "dois" });
    const bus = fakeBus();
    const channel = createVoiceCallChannel({ subscribe: bus.subscribe });
    const abort = new AbortController();
    const iter = channel.subscribe(ctx("voice/vc_s?after=1", abort.signal), {
      channelPath: "voice/vc_s",
      scope: { permission: "access", objectType: "voice-call", objectId: "vc_s" },
    });
    const out: StreamEvent[] = [];
    const reader = (async () => {
      for await (const event of iter) {
        out.push(event);
        if (out.length === 2) {
          // A duplicate of an already replayed event must be dropped.
          bus.push({ callId: "vc_s", seq: 2, type: "agent.transcript", data: { text: "dois" }, createdAt: 0 });
          bus.push({ callId: "vc_s", seq: 3, type: "agent.state", data: { state: "thinking" }, createdAt: 0 });
          bus.push({ callId: "vc_s", seq: 4, type: "call.ended", data: { reason: "user" }, createdAt: 0 });
        }
      }
    })();
    await reader;
    const types = out.map((e) => (e.data as VoiceEvent).type);
    expect(types).toEqual(["call.snapshot", "agent.transcript", "agent.state", "call.ended"]);
    expect(out.map((e) => (e.data as VoiceEvent).seq)).toEqual([0, 2, 3, 4]);
  });

  it("fills a gap from the store when a live event was missed", async () => {
    call("vc_g");
    appendVoiceEvent("vc_g", "user.transcript", { text: "um" });
    const bus = fakeBus();
    const channel = createVoiceCallChannel({ subscribe: bus.subscribe, gapCheckMs: 20 });
    const abort = new AbortController();
    const iter = channel.subscribe(ctx("voice/vc_g", abort.signal), {
      channelPath: "voice/vc_g",
      scope: { permission: "access", objectType: "voice-call", objectId: "vc_g" },
    });
    const out: StreamEvent[] = [];
    for await (const event of iter) {
      out.push(event);
      if (out.length === 2) {
        // Stored but never seen live (published before the subscription registered).
        appendVoiceEvent("vc_g", "agent.transcript", { text: "dois" });
        const ended = appendVoiceEvent("vc_g", "call.ended", { reason: "user" });
        bus.push(ended);
      }
    }
    expect(out.map((e) => (e.data as VoiceEvent).seq)).toEqual([0, 1, 2, 3]);

    // A quiet spell re-reads the store too.
    call("vc_q");
    const quiet = channel.subscribe(ctx("voice/vc_q", new AbortController().signal), {
      channelPath: "voice/vc_q",
      scope: { permission: "access", objectType: "voice-call", objectId: "vc_q" },
    });
    const seen: StreamEvent[] = [];
    for await (const event of quiet) {
      seen.push(event);
      if (seen.length === 1) appendVoiceEvent("vc_q", "call.ended", { reason: "user" });
    }
    expect(seen.map((e) => (e.data as VoiceEvent).type)).toEqual(["call.snapshot", "call.ended"]);
  });

  it("hides another device's call", async () => {
    const now = Date.now();
    insertVoiceDevice({
      id: "vd_a",
      label: "a",
      contactId: "c_a",
      contextId: "ctx_a",
      sessions: ["main"],
      createdAt: now,
      expiresAt: now + 60_000,
    });
    call("vc_b", "vd_other");
    const channel = createVoiceCallChannel({ subscribe: fakeBus().subscribe });
    const out: StreamEvent[] = [];
    for await (const event of channel.subscribe(
      ctx("voice/vc_b", new AbortController().signal, { contextId: "ctx_a", kind: "voice-device" }),
      { channelPath: "voice/vc_b", scope: { permission: "access", objectType: "voice-call", objectId: "vc_b" } },
    )) {
      out.push(event);
    }
    expect(out).toEqual([{ event: "end", data: { type: "stream.end", reason: "not_found", callId: "vc_b" } }]);
  });

  it("an issued context does not stream a call another caller opened", async () => {
    call("vc_other");
    const channel = createVoiceCallChannel({ subscribe: fakeBus().subscribe });
    const out: StreamEvent[] = [];
    for await (const event of channel.subscribe(
      ctx("voice/vc_other", new AbortController().signal, { contextId: "ctx_intruder", kind: "cli-runtime" }),
      {
        channelPath: "voice/vc_other",
        scope: { permission: "access", objectType: "voice-call", objectId: "vc_other" },
      },
    )) {
      out.push(event);
    }
    expect(out).toEqual([{ event: "end", data: { type: "stream.end", reason: "not_found", callId: "vc_other" } }]);
  });
});
