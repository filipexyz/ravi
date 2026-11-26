import { describe, expect, it } from "bun:test";
import { decodeJwt } from "jose";
import { checkVoiceEngines } from "./index.js";
import { mintLiveKitRoomToken } from "./handsfree.js";
import {
  APPEND_CHUNK_CHARS,
  buildLiveInstructions,
  chunkText,
  createLiveSession,
  LiveProviderError,
  LiveSideband,
  type LiveSocket,
} from "./live.js";
import { createPushEngine } from "./push.js";

describe("voice engines", () => {
  it("reports missing configuration without calling vendors", () => {
    const checks = checkVoiceEngines({});
    const byId = Object.fromEntries(checks.map((check) => [check.engine, check]));
    expect(byId.mock?.ready).toBe(true);
    expect(byId.push?.missing).toEqual(["ELEVENLABS_API_KEY", "GROQ_API_KEY or OPENAI_API_KEY"]);
    expect(byId.live?.missing).toEqual(["RAVI_VOICE_OPENAI_API_KEY"]);
    expect(byId.handsfree?.missing).toEqual(["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]);
  });

  it("live never accepts OPENAI_API_KEY in place of its own key", () => {
    const check = checkVoiceEngines({ OPENAI_API_KEY: "sk-test" }).find((item) => item.engine === "live");
    expect(check?.ready).toBe(false);
  });

  it("push transcribes with the existing STT and meters synthesized speech", async () => {
    const engine = createPushEngine({
      env: { GROQ_API_KEY: "x", ELEVENLABS_API_KEY: "y" },
      transcribe: async () => ({ text: " olá ", provider: "groq", duration: 2 }),
      synthesize: async (text) => {
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const filePath = join(tmpdir(), `voice-test-${process.pid}.mp3`);
        writeFileSync(filePath, Buffer.from("mp3"));
        return {
          filePath,
          mimeType: "audio/mpeg",
          text,
          sizeBytes: 3,
          provider: "elevenlabs",
          voiceId: "v",
          modelId: "m",
          outputFormat: "mp3_44100_128",
        };
      },
    });
    const heard = await engine.transcribe({ bytes: new Uint8Array([1]), mime: "audio/webm", language: "pt-BR" });
    expect(heard).toEqual({ text: "olá", durationSec: 2, provider: "groq" });
    const clip = await engine.synthesize({
      text: "Feito.",
      profile: {
        id: "default",
        label: "x",
        mode: "push",
        language: "pt",
        delivery: "speak",
        allowGuests: false,
        maxCallMinutes: 1,
        maxCallCostUsd: 1,
        maxDailyCostUsd: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    });
    expect(clip?.mime).toBe("audio/mpeg");
    expect(clip?.characters).toBe(6);
    expect(clip?.costUsd).toBeGreaterThan(0);
  });

  it("mints a LiveKit room token that dispatches the voice worker", async () => {
    const token = await mintLiveKitRoomToken({
      room: "vc_1",
      identity: "vd_1",
      dispatchAgent: { agentName: "ravi-voice", metadata: '{"callId":"vc_1"}' },
      env: { LIVEKIT_URL: "wss://x.livekit.cloud", LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "secret" },
      now: 1_000_000,
    });
    const claims = decodeJwt(token.token) as Record<string, any>;
    expect(claims.iss).toBe("APIkey");
    expect(claims.sub).toBe("vd_1");
    expect(claims.video).toMatchObject({ room: "vc_1", roomJoin: true });
    expect(claims.roomConfig.agents[0].agentName).toBe("ravi-voice");
    expect(token.roomUrl).toBe("wss://x.livekit.cloud");
  });

  it("creates GPT-Live sessions with store off and a locked data channel", async () => {
    let sent: any = null;
    const created = await createLiveSession({
      apiKey: "k",
      sdpOffer: "v=0 offer",
      instructions: "be short",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ session: { id: "ls_1" }, transport: { sdp: "v=0 answer" } }), {
          status: 201,
        });
      }) as unknown as typeof fetch,
    });
    expect(created).toEqual({ sessionId: "ls_1", sdpAnswer: "v=0 answer" });
    expect(sent.session.store).toBe(false);
    expect(sent.session.delegation).toEqual({ type: "client" });
    expect(sent.session.client.data_channel).toEqual({ allowed_client_events: [], allowed_server_events: [] });
    expect(sent.transport).toEqual({ type: "webrtc", sdp: "v=0 offer" });
  });

  it("sideband drops reflected audio, settles delegations once and appends results", () => {
    const sentFrames: any[] = [];
    const listeners: Record<string, (value?: any) => void> = {};
    const socket: LiveSocket = {
      send: (data) => sentFrames.push(JSON.parse(data)),
      close: () => {},
      on: ((event: string, listener: (value?: any) => void) => {
        listeners[event] = listener;
      }) as LiveSocket["on"],
    };
    const timers: Array<() => void> = [];
    const delegations: Array<{ delegationId: string; text: string }> = [];
    const users: string[] = [];
    const sideband = new LiveSideband({
      apiKey: "k",
      sessionId: "ls_1",
      socketFactory: () => socket,
      setTimer: (fn) => timers.push(fn),
      handlers: {
        onDelegation: (input) => delegations.push({ delegationId: input.delegationId, text: input.text }),
        onUserTranscript: (text) => users.push(text),
        onAgentTranscript: () => {},
        onUsage: () => {},
        onClosed: () => {},
        onError: () => {},
      },
    });
    sideband.connect();
    const audio = JSON.stringify({ type: "session.input_audio.append", audio: "A".repeat(2000) });
    listeners.message?.(audio);
    listeners.message?.(JSON.stringify({ type: "session.input_transcript.delta", delta: "manda o resumo " }));
    listeners.message?.(JSON.stringify({ type: "session.input_transcript.delta", delta: "pra Ana" }));
    listeners.message?.(JSON.stringify({ type: "session.delegation.created", delegation: { id: "d1" } }));
    listeners.message?.(JSON.stringify({ type: "session.delegation.created", delegation: { id: "d1" } }));
    expect(timers).toHaveLength(1);
    timers[0]?.();
    expect(delegations).toEqual([{ delegationId: "d1", text: "manda o resumo pra Ana" }]);
    // The door records the delegated text as the turn's transcript; the sideband does not repeat it.
    expect(users).toEqual([]);
    // The delegation cancelled the provider's own acknowledgement with an empty thinking append.
    expect(sentFrames).toContainEqual({ type: "session.thinking.append", delegation_id: "d1", content: "" });
    sideband.commentary("Feito.", "d1");
    expect(sentFrames.at(-1)).toEqual({ type: "session.commentary.append", delegation_id: "d1", content: "Feito." });
    expect(sentFrames.some((frame) => "text" in frame)).toBe(false);
    expect(JSON.stringify(sentFrames)).not.toContain("AAAA");
  });

  it("a delegation keeps the utterance whose transcript completed before the timer fired", () => {
    const listeners: Record<string, (value?: any) => void> = {};
    const socket: LiveSocket = {
      send: () => {},
      close: () => {},
      on: ((event: string, listener: (value?: any) => void) => {
        listeners[event] = listener;
      }) as LiveSocket["on"],
    };
    const timers: Array<() => void> = [];
    const delegations: Array<{ delegationId: string; text: string }> = [];
    const users: string[] = [];
    const sideband = new LiveSideband({
      apiKey: "k",
      sessionId: "ls_2",
      socketFactory: () => socket,
      setTimer: (fn) => timers.push(fn),
      handlers: {
        onDelegation: (input) => delegations.push({ delegationId: input.delegationId, text: input.text }),
        onUserTranscript: (text) => users.push(text),
        onAgentTranscript: () => {},
        onUsage: () => {},
        onClosed: () => {},
        onError: () => {},
      },
    });
    sideband.connect();
    const send = (event: Record<string, unknown>) => listeners.message?.(JSON.stringify(event));
    send({ type: "session.input_transcript.delta", delta: "agenda amanhã" });
    send({ type: "session.delegation.created", delegation: { id: "d1" } });
    send({ type: "session.input_transcript.completed" });
    timers[0]?.();
    // Transcript completed before the delegation was created, too.
    send({ type: "session.input_transcript.delta", delta: "e o tempo" });
    send({ type: "session.input_transcript.completed" });
    send({ type: "session.delegation.created", delegation: { id: "d2" } });
    timers[1]?.();
    expect(delegations).toEqual([
      { delegationId: "d1", text: "agenda amanhã" },
      { delegationId: "d2", text: "e o tempo" },
    ]);
    expect(users).toEqual([]);
  });

  function harness() {
    const listeners: Record<string, (value?: any) => void> = {};
    const socket: LiveSocket = {
      send: () => {},
      close: () => {},
      on: ((event: string, listener: (value?: any) => void) => {
        listeners[event] = listener;
      }) as LiveSocket["on"],
    };
    const timers: Array<() => void> = [];
    const delegations: Array<{ delegationId: string; text: string }> = [];
    const users: string[] = [];
    const errors: LiveProviderError[] = [];
    const displays: string[] = [];
    const sideband = new LiveSideband({
      apiKey: "k",
      sessionId: "ls_h",
      socketFactory: () => socket,
      setTimer: (fn) => timers.push(fn),
      handlers: {
        onDelegation: (input) => {
          delegations.push({ delegationId: input.delegationId, text: input.text });
          displays.push(input.displayText);
        },
        onUserTranscript: (text) => users.push(text),
        onAgentTranscript: () => {},
        onUsage: () => {},
        onClosed: () => {},
        onError: (error) => errors.push(error),
      },
    });
    sideband.connect();
    const send = (event: Record<string, unknown>) => listeners.message?.(JSON.stringify(event));
    return { sideband, send, timers, delegations, users, errors, displays };
  }

  const inp = (delta: string, start_ms: number, end_ms: number) => ({
    type: "session.input_transcript.delta",
    delta,
    start_ms,
    end_ms,
  });
  const out = (delta: string, start_ms: number, end_ms: number) => ({
    type: "session.output_transcript.delta",
    delta,
    start_ms,
    end_ms,
  });
  const del = (id: string, offset_ms?: number) => ({
    type: "session.delegation.created",
    delegation: offset_ms === undefined ? { id } : { id, offset_ms },
  });

  it("nothing said before a delegation is dropped: every utterance goes, in order", () => {
    const h = harness();
    h.send(inp("olha a #1020", 0, 900));
    h.send(inp("e me diz se mergeou", 4000, 5200));
    h.send(del("d1"));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "olha a #1020 e me diz se mergeou" }]);
    // Nothing was on screen yet: the door shows all of it with the turn id.
    expect(h.displays).toEqual(["olha a #1020 e me diz se mergeou"]);
    expect(h.users).toEqual([]);
  });

  it("deltas close together stay one utterance", () => {
    const h = harness();
    h.send(inp("manda o resumo ", 0, 900));
    h.send(inp("pra Ana", 1300, 1900));
    h.send(del("d1"));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "manda o resumo pra Ana" }]);
  });

  it("speech the model answers on its own is shown at once, once", () => {
    const h = harness();
    h.send(inp("e aí", 0, 500));
    h.send(out("Oi! ", 700, 900));
    h.send(out("Tudo certo.", 950, 1300));
    expect(h.users).toEqual(["e aí"]);
    h.sideband.close();
    expect(h.users).toEqual(["e aí"]);
  });

  it("a barge-in over a reply stays one request (later reply deltas are not boundaries)", () => {
    const h = harness();
    h.send(out("Vou mandar o ", 0, 600));
    h.send(inp("não ", 650, 900));
    h.send(out("relatório", 700, 1100));
    h.send(inp("manda o relatório", 1000, 1800));
    h.send(del("d1"));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "não manda o relatório" }]);
    expect(h.users).toEqual([]);
  });

  it("without timestamps, only the first delta of a reply is a boundary", () => {
    const h = harness();
    h.send({ type: "session.output_transcript.delta", delta: "Vou mandar o " });
    h.send({ type: "session.input_transcript.delta", delta: "não " });
    h.send({ type: "session.output_transcript.delta", delta: "relatório" });
    h.send({ type: "session.input_transcript.delta", delta: "manda o relatório" });
    h.send(del("d1"));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "não manda o relatório" }]);
  });

  it("drain publishes speech nobody took yet, once", () => {
    const h = harness();
    h.send(inp("até amanhã", 0, 700));
    h.sideband.drain();
    h.sideband.close();
    expect(h.users).toEqual(["até amanhã"]);
  });

  it("speech that started after the delegation offset stays for the next request", () => {
    const h = harness();
    h.send(inp("olha a #1020", 0, 900));
    h.send(del("d1", 1000));
    h.send(inp("outra coisa", 3000, 3800));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "olha a #1020" }]);
    h.send(del("d2", 4000));
    h.timers[1]?.();
    expect(h.delegations.at(-1)).toEqual({ delegationId: "d2", text: "outra coisa" });
  });

  it("the delegation offset splits one utterance without a pause", () => {
    const h = harness();
    h.send(inp("olha a #1020", 0, 900));
    h.send(del("d1", 1000));
    h.send(inp(" e outra coisa", 1200, 2000));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "olha a #1020" }]);
    h.send(del("d2", 2500));
    h.timers[1]?.();
    expect(h.delegations.at(-1)).toEqual({ delegationId: "d2", text: "e outra coisa" });
  });

  it("append chunks never pass APPEND_CHUNK_CHARS, even when a sentence ends at the limit", () => {
    expect(APPEND_CHUNK_CHARS).toBeLessThanOrEqual(900);
    const boundary = `${"a".repeat(APPEND_CHUNK_CHARS)}. ${"b".repeat(200)}`;
    const chunks = [
      ...chunkText(boundary, APPEND_CHUNK_CHARS),
      ...chunkText("Pedido 1234-ABCD confirmado. ".repeat(200), APPEND_CHUNK_CHARS),
      ...chunkText("x".repeat(3000), APPEND_CHUNK_CHARS),
    ];
    expect(chunks.every((chunk) => chunk.length <= APPEND_CHUNK_CHARS)).toBe(true);
  });

  // Repro from the review of #1023 (reviews/repro-live-1023.ts), S1-S3, at any delay.
  it("S1: a greeting the model answered is shown once and still reaches the session with the request", () => {
    const h = harness();
    h.send(inp("oi", 0, 400));
    h.send(out("Oi!", 600, 900));
    h.send(inp("manda o resumo", 2000, 3000));
    h.send(del("d1", 3200));
    h.timers[0]?.();
    expect(h.users).toEqual(["oi"]);
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "oi manda o resumo" }]);
    // The door shows only what was not on screen: no line the person did not say.
    expect(h.displays).toEqual(["manda o resumo"]);
  });

  it("S2/S3: the model talking first never loses the request, however late the delegation comes", () => {
    const h = harness();
    h.send(inp("quais ferramentas tu tem", 0, 1500));
    h.send(out("Deixa eu ver", 1700, 2400));
    // No timer decides anything: the delegation can come at any time.
    h.send(del("d1", 1500));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "quais ferramentas tu tem" }]);
    expect(h.users).toEqual(["quais ferramentas tu tem"]);
    expect(h.displays).toEqual([""]);
  });

  it("Devin #1026: a paused request acknowledged by the model is delivered whole", () => {
    const h = harness();
    h.send(inp("manda o relatório", 0, 1000));
    h.send(inp("pra Ana", 3000, 3800));
    h.send(out("Certo,", 4000, 4400));
    h.send(del("d1", 4500));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "manda o relatório pra Ana" }]);
  });

  it("Devin #1026: a late delegation never takes speech said after its offset", () => {
    const h = harness();
    h.send(inp("cancela", 0, 600));
    h.send(inp(" isso e faz outra", 700, 1800));
    h.send(out("Ok.", 2000, 2300));
    h.send(del("d1", 650));
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "cancela" }]);
  });

  it("Devin #1026: a closed sideband starts no work when a delegation settles", () => {
    const h = harness();
    h.send(inp("oi", 0, 400));
    h.send(del("d1"));
    h.sideband.close();
    h.timers[0]?.();
    expect(h.delegations).toEqual([]);
  });

  it("reads the provider error nested under error", () => {
    const h = harness();
    h.send({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "unknown_parameter",
        message: "Unknown parameter: 'text'.",
        param: "text",
      },
    });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.message).toBe("Unknown parameter: 'text'.");
    expect(h.errors[0]?.providerCode).toBe("unknown_parameter");
    expect(h.errors[0]?.param).toBe("text");
  });

  it("names Ravi in the live instructions", () => {
    const text = buildLiveInstructions({ language: "pt-BR", sessionLabel: "voz" });
    expect(text).toContain("You are Ravi");
    expect(text).toContain("Brazilian Portuguese");
  });

  it("chunks long appends", () => {
    const chunks = chunkText("Uma frase. ".repeat(400), 1500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1500)).toBe(true);
  });
});
