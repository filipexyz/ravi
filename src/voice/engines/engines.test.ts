import { describe, expect, it } from "bun:test";
import { decodeJwt } from "jose";
import { checkVoiceEngines } from "./index.js";
import { mintLiveKitRoomToken } from "./handsfree.js";
import {
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
        onDelegation: (input) => delegations.push(input),
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
        onDelegation: (input) => delegations.push(input),
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
    const sideband = new LiveSideband({
      apiKey: "k",
      sessionId: "ls_h",
      socketFactory: () => socket,
      setTimer: (fn) => timers.push(fn),
      handlers: {
        onDelegation: (input) => delegations.push(input),
        onUserTranscript: (text) => users.push(text),
        onAgentTranscript: () => {},
        onUsage: () => {},
        onClosed: () => {},
        onError: (error) => errors.push(error),
      },
    });
    sideband.connect();
    const send = (event: Record<string, unknown>) => listeners.message?.(JSON.stringify(event));
    return { sideband, send, timers, delegations, users, errors };
  }

  it("a pause between transcript deltas splits utterances; only the last one is delegated", () => {
    const h = harness();
    h.send({ type: "session.input_transcript.delta", delta: "oi cara", start_ms: 0, end_ms: 800 });
    h.send({ type: "session.input_transcript.delta", delta: "quais ferramentas tu tem", start_ms: 5000, end_ms: 6500 });
    h.send({ type: "session.delegation.created", delegation: { id: "d1" } });
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "quais ferramentas tu tem" }]);
    // The earlier utterance nobody delegated shows once, as conversation.
    expect(h.users).toEqual(["oi cara"]);
  });

  it("deltas close together stay one utterance", () => {
    const h = harness();
    h.send({ type: "session.input_transcript.delta", delta: "manda o resumo ", start_ms: 0, end_ms: 900 });
    h.send({ type: "session.input_transcript.delta", delta: "pra Ana", start_ms: 1300, end_ms: 1900 });
    h.send({ type: "session.delegation.created", delegation: { id: "d1" } });
    h.timers[0]?.();
    expect(h.delegations).toEqual([{ delegationId: "d1", text: "manda o resumo pra Ana" }]);
  });

  it("speech the model answers on its own is shown once as conversation", () => {
    const h = harness();
    h.send({ type: "session.input_transcript.delta", delta: "e aí", start_ms: 0, end_ms: 500 });
    h.send({ type: "session.output_transcript.delta", delta: "Oi! " });
    h.send({ type: "session.output_transcript.delta", delta: "Tudo certo." });
    expect(h.users).toEqual(["e aí"]);
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
