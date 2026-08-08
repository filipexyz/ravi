import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];
const mediaSendCalls: Array<Record<string, unknown>> = [];
const publishedOutboundJobs: Array<Record<string, unknown>> = [];
const generateAudioCalls: Array<Record<string, unknown>> = [];

const runtimeContext: {
  agentId: string;
  sessionName: string;
  source: {
    channel: string;
    accountId: string;
    instanceId?: string;
    chatId: string;
    canonicalChatId?: string;
  };
} = {
  agentId: "dev",
  sessionName: "dev",
  source: {
    channel: "whatsapp",
    accountId: "main",
    chatId: "5511999999999",
  },
};

let sourceAvailable = true;

// Chat-ledger fixtures for the react MESSAGE_NOT_FOUND contract.
let ledgerChat: { id: string } | null = null;
let ledgerMessageFound = false;
let ledgerRecentMessages: Array<{ providerMessageId: string }> = [];

// TTS playback fixtures for the audio pending --fields contract.
let ttsPlaybackItems: Array<Record<string, unknown>> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => (sourceAvailable ? runtimeContext : { agentId: "dev", sessionName: "dev" }),
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  nats: {
    emit: mock(async (topic: string, payload: Record<string, unknown>) => {
      emittedEvents.push({ topic, payload });
    }),
  },
}));

mock.module("../../channels/outbound-publish-outbox.js", () => ({
  publishChannelOutboundJobDurably: mock(async (job: Record<string, unknown>) => {
    publishedOutboundJobs.push(job);
    return {
      ok: true,
      publishedNow: true,
      record: { status: "published" },
    };
  }),
}));

mock.module("../../audio/generator.js", () => ({
  generateAudio: mock(async (text: string, options: Record<string, unknown>) => {
    generateAudioCalls.push({ text, ...options });
    return {
      filePath: "/tmp/ravi-audio.mp3",
      mimeType: "audio/mpeg",
    };
  }),
  listElevenLabsVoices: mock(async () => ({
    voices: [
      { voiceId: "v1", name: "Aria", category: "premade", labels: { accent: "us" } },
      { voiceId: "v2", name: "Bruno", category: "cloned", labels: { accent: "br" } },
    ],
    hasMore: false,
  })),
}));

mock.module("../../audio/tts.js", () => ({
  RAVI_TTS_TOPIC: "ravi.tts",
  resolveTtsVoiceConfig: (input: { voice?: Record<string, unknown> }) => input.voice ?? {},
  listTtsPlaybackItems: () => ttsPlaybackItems,
  getTtsPlaybackItem: () => null,
  readTtsPlaybackAudio: () => null,
}));

mock.module("../../router/config.js", () => ({
  getAgent: () => ({
    defaults: {
      tts_lang: "en",
    },
  }),
}));

mock.module("../../router/router-db.js", () => ({
  dbFindChat: () => ledgerChat,
  dbFindChatMessage: () => (ledgerMessageFound ? { id: "cm_1", providerMessageId: "mid-1" } : null),
  dbGetChatMessage: () => null,
  dbListChatMessages: () => ledgerRecentMessages,
}));

mock.module("../media-send.js", () => ({
  inferMediaMimeType: (filePath: string) => (filePath.endsWith(".png") ? "image/png" : "application/octet-stream"),
  inferMediaType: (mime: string) => (mime.startsWith("image/") ? "image" : "document"),
  resolveMediaSendTarget: () => ({
    channel: "whatsapp",
    accountId: "main",
    instanceId: "inst-1",
    chatId: "chat-1",
  }),
  sendMediaWithOmniCli: mock(async (input: Record<string, unknown>) => {
    mediaSendCalls.push(input);
    const filePath = String(input.filePath ?? "/tmp/unknown.bin");
    const type = String(input.type ?? (filePath.endsWith(".png") ? "image" : "audio"));
    return {
      filePath,
      filename: String(input.filename ?? basename(filePath)),
      mimeType: type === "image" ? "image/png" : "audio/mpeg",
      type,
      target: {
        channel: "whatsapp",
        accountId: "main",
        instanceId: "inst-1",
        chatId: "chat-1",
      },
      delivery: {
        transport: "omni-send",
        args: ["send"],
        success: true,
        message: "Media sent",
        messageId: "msg-1",
        status: "sent",
        raw: { messageId: "msg-1", status: "sent" },
      },
    };
  }),
}));

const { AudioCommands } = await import("./audio.js");
const { MediaCommands } = await import("./media.js");
const { ReactCommands } = await import("./react.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await captureConsole(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

beforeEach(() => {
  emittedEvents.length = 0;
  mediaSendCalls.length = 0;
  publishedOutboundJobs.length = 0;
  generateAudioCalls.length = 0;
  sourceAvailable = true;
  runtimeContext.source.channel = "whatsapp";
  runtimeContext.source.accountId = "main";
  runtimeContext.source.chatId = "5511999999999";
  delete runtimeContext.source.instanceId;
  delete runtimeContext.source.canonicalChatId;
  ledgerChat = null;
  ledgerMessageFound = false;
  ledgerRecentMessages = [];
  ttsPlaybackItems = [];
});

describe("media/audio/react JSON output", () => {
  it("prints generated audio artifacts as typed JSON without human progress text", async () => {
    const { output, result } = await captureConsole(() =>
      new AudioCommands().generate(
        "hello",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
        undefined,
      ),
    );
    const payload = JSON.parse(output);

    expect(output).not.toContain("Generating audio");
    expect(payload.success).toBe(true);
    expect(payload.audio).toMatchObject({
      filePath: "/tmp/ravi-audio.mp3",
      mimeType: "audio/mpeg",
      text: "hello",
    });
    expect(payload.options).toMatchObject({ lang: "en", voiceNote: false });
    expect(result).toEqual(payload);
    expect(emittedEvents).toHaveLength(0);
  });

  it("generates audio from a relative markdown text file", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".ravi-audio-text-file-"));
    const filePath = join(dir, "prompt.md");
    const textFile = relative(process.cwd(), filePath);
    writeFileSync(filePath, "bonjour depuis un fichier\n");
    try {
      const { output, result } = await captureConsole(() =>
        new AudioCommands().generate(
          undefined,
          undefined,
          undefined,
          undefined,
          "fr",
          undefined,
          undefined,
          false,
          undefined,
          true,
          textFile,
        ),
      );
      const payload = JSON.parse(output);

      expect(payload.audio).toMatchObject({
        text: "bonjour depuis un fichier",
      });
      expect(payload.options).toMatchObject({ lang: "fr", voiceNote: false });
      expect(result).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe audio text file paths", async () => {
    const commands = new AudioCommands();
    await expect(
      commands.generate(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
        "../x.txt",
      ),
    ).rejects.toThrow("--text-file must not contain '..' path segments.");
    await expect(
      commands.generate(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
        "/tmp/x.txt",
      ),
    ).rejects.toThrow("--text-file must be a relative path inside the current working directory.");
    await expect(
      commands.generate(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
        "x.pdf",
      ),
    ).rejects.toThrow("--text-file must point to a .md or .txt file.");
  });

  it("prints delivered media send results as typed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-json-"));
    const filePath = join(dir, "sample.png");
    writeFileSync(filePath, "png");
    try {
      const { output, result } = await captureConsole(() =>
        new MediaCommands().send(filePath, "caption", "whatsapp", "chat-1", "main", undefined, false, true, true),
      );
      const payload = JSON.parse(output);

      expect(payload).toMatchObject({
        success: true,
        media: {
          filePath,
          filename: "sample.png",
          mimeType: "image/png",
          type: "image",
          caption: "caption",
          voiceNote: false,
        },
        target: {
          channel: "whatsapp",
          accountId: "main",
          instanceId: "inst-1",
          chatId: "chat-1",
        },
        delivery: {
          transport: "omni-send",
          messageId: "msg-1",
          status: "sent",
        },
      });
      expect(result).toEqual(payload);
      expect(emittedEvents).toHaveLength(0);
      expect(mediaSendCalls).toEqual([
        expect.objectContaining({
          filePath,
          caption: "caption",
          voiceNote: false,
          target: {
            channel: "whatsapp",
            accountId: "main",
            chatId: "chat-1",
          },
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the direct media sender when audio generate runs with --send", async () => {
    const { output, result } = await captureConsole(() =>
      new AudioCommands().generate(
        "hello",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        true,
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(payload.sent).toMatchObject({
      transport: "omni-send",
      channel: "whatsapp",
      accountId: "main",
      instanceId: "inst-1",
      chatId: "chat-1",
      filename: "ravi-audio.mp3",
      voiceNote: true,
      messageId: "msg-1",
      status: "sent",
    });
    expect(result).toEqual(payload);
    expect(mediaSendCalls).toEqual([
      expect.objectContaining({
        filePath: "/tmp/ravi-audio.mp3",
        caption: "hello",
        type: "audio",
        filename: "ravi-audio.mp3",
        voiceNote: true,
      }),
    ]);
  });

  it("prints reaction send results as typed JSON", async () => {
    const { output, result } = await captureConsole(() => new ReactCommands().send("mid-1", "+1", true));
    const payload = JSON.parse(output);

    expect(payload).toMatchObject({
      status: "accepted",
      queued: false,
      executionMode: "legacy",
      topic: "ravi.outbound.reaction",
      reaction: {
        messageId: "mid-1",
        emoji: "+1",
      },
      target: runtimeContext.source,
    });
    expect(result).toEqual(payload);
    expect(emittedEvents).toEqual([
      {
        topic: "ravi.outbound.reaction",
        payload: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "5511999999999",
          messageId: "mid-1",
          emoji: "+1",
        },
      },
    ]);
  });

  it("queues Slack reactions through the durable native outbound stream", async () => {
    runtimeContext.source.channel = "slack";
    runtimeContext.source.accountId = "ravi-slack";
    runtimeContext.source.instanceId = "slack-instance-1";
    runtimeContext.source.chatId = "C123";
    runtimeContext.source.canonicalChatId = "chat-slack-C123";

    const { output, result } = await captureConsole(() => new ReactCommands().send("1711111111.000100", ":+1:", true));
    const payload = JSON.parse(output);

    expect(payload).toMatchObject({
      status: "queued",
      queued: true,
      executionMode: "durable",
      topic: "ravi.channel.outbound.slack",
      publishedNow: true,
      publishPending: false,
    });
    expect(result).toEqual(payload);
    expect(emittedEvents).toEqual([]);
    expect(publishedOutboundJobs).toHaveLength(1);
    expect((publishedOutboundJobs[0] as any).request.content).toEqual({
      type: "chat_action",
      actionId: "message.react",
      providerMessageId: "1711111111.000100",
      emoji: ":+1:",
      operation: "add",
    });
    expect((publishedOutboundJobs[0] as any).request.target).toMatchObject({
      channel: "slack",
      accountId: "ravi-slack",
      instanceId: "slack-instance-1",
      chatId: "C123",
      canonicalChatId: "chat-slack-C123",
    });
  });
});

// ---------------------------------------------------------------------------
// media send — agent-first contract (write brake + not-found envelope)
// ---------------------------------------------------------------------------

describe("media send contract", () => {
  it("send without --execute is a dry-run: exit 3 and NO delivery call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-brake-"));
    const filePath = join(dir, "sample.png");
    writeFileSync(filePath, "png");
    try {
      const error = await expectContractError(
        () =>
          new MediaCommands().send(
            filePath,
            "PRIVATE_MESSAGE_8K2R",
            "whatsapp",
            "5511999999999",
            "main",
            "PRIVATE_THREAD_2J7N",
            false,
            true,
          ),
        "WRITE_REQUIRES_EXECUTE",
        3,
      );

      expect(error.details.dryRun).toBe(true);
      expect(error.details.plan).toEqual({
        fileName: "sample.png",
        mimeType: "image/png",
        mediaType: "image",
        captionPresent: true,
        voiceNote: false,
        target: {
          channel: "whatsapp",
          accountId: "main",
          chatIdPresent: true,
          threadIdPresent: true,
        },
      });
      expect(JSON.stringify(error.details.plan)).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(JSON.stringify(error.details.plan)).not.toContain("PRIVATE_THREAD_2J7N");
      expect(JSON.stringify(error.details.plan)).not.toContain(dir);
      expect(mediaSendCalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("send on a missing file exits 1 with FILE_NOT_FOUND before the brake", async () => {
    const error = await expectContractError(
      () =>
        new MediaCommands().send(
          "/tmp/nope-does-not-exist.png",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          true,
        ),
      "FILE_NOT_FOUND",
      1,
    );

    expect(error.details.suggestedAction).toContain("file path");
    expect(mediaSendCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// audio generate / tts — risk-based confirmation contract
// ---------------------------------------------------------------------------

describe("audio contract", () => {
  it("generate without --send runs immediately without --execute", async () => {
    const { result } = await captureConsole(() =>
      new AudioCommands().generate(
        "hello world",
        "voice-1",
        "eleven_turbo_v2_5",
        "1.5",
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
      ),
    );

    expect(generateAudioCalls).toHaveLength(1);
    expect(generateAudioCalls[0]).toMatchObject({
      text: "hello world",
      voice: "voice-1",
      model: "eleven_turbo_v2_5",
      speed: 1.5,
    });
    expect((result as { success: boolean }).success).toBe(true);
    expect(mediaSendCalls).toHaveLength(0);
  });

  it("generate with --send but without --execute is a dry-run before provider and delivery", async () => {
    const text = "SECRET_AT_START hello world SECRET_AT_END";
    const caption = "CAPTION_SECRET_AT_START caption CAPTION_SECRET_AT_END";
    const error = await expectContractError(
      () =>
        new AudioCommands().generate(
          text,
          "voice-1",
          "eleven_turbo_v2_5",
          "1.5",
          undefined,
          undefined,
          undefined,
          true,
          caption,
          true,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      textChars: text.length,
      voice: "voice-1",
      model: "eleven_turbo_v2_5",
      speed: 1.5,
      lang: "en",
      send: true,
      captionPresent: true,
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain("SECRET_AT_START");
    expect(serializedPlan).not.toContain("SECRET_AT_END");
    expect(serializedPlan).not.toContain("CAPTION_SECRET_AT_START");
    expect(serializedPlan).not.toContain("CAPTION_SECRET_AT_END");
    expect(generateAudioCalls).toHaveLength(0);
    expect(mediaSendCalls).toHaveLength(0);
  });

  it("generate validates text BEFORE the brake", async () => {
    await expect(
      new AudioCommands().generate(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
      ),
    ).rejects.toThrow("Provide text or --text-file.");
    expect(generateAudioCalls).toHaveLength(0);
  });

  it("tts without --execute is a dry-run: exit 3 and NO ravi.tts emit", async () => {
    const text = "TTS_SECRET_AT_START fala comigo TTS_SECRET_AT_END";
    const error = await expectContractError(
      () =>
        new AudioCommands().tts(
          text,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      textChars: text.length,
      topic: "ravi.tts",
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain("TTS_SECRET_AT_START");
    expect(serializedPlan).not.toContain("TTS_SECRET_AT_END");
    expect(emittedEvents).toHaveLength(0);
  });

  it("tts with --execute publishes the ravi.tts request", async () => {
    const { result } = await captureConsole(() =>
      new AudioCommands().tts(
        "fala comigo",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]?.topic).toBe("ravi.tts");
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it("voices --fields narrows each voice to the requested fields", async () => {
    const { result } = await captureConsole(() =>
      new AudioCommands().voices(undefined, undefined, undefined, undefined, true, "voiceId,name"),
    );

    const voices = (result as unknown as { voices: Array<Record<string, unknown>> }).voices;
    expect(voices).toHaveLength(2);
    for (const voice of voices) {
      expect(Object.keys(voice).sort()).toEqual(["name", "voiceId"]);
    }
  });

  it("pending --fields narrows each playback item to the requested fields", async () => {
    ttsPlaybackItems = [
      { id: "tts-1", status: "ready", filePath: "/tmp/a.mp3", createdAt: 1 },
      { id: "tts-2", status: "ready", filePath: "/tmp/b.mp3", createdAt: 2 },
    ];

    const { result } = await captureConsole(() =>
      new AudioCommands().pending(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        "id,status",
      ),
    );

    const items = (result as unknown as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["id", "status"]);
    }
  });
});

// ---------------------------------------------------------------------------
// react send — agent-first contract (declared UNBRAKED + MESSAGE_NOT_FOUND)
// ---------------------------------------------------------------------------

describe("react send contract", () => {
  it("is declared UNBRAKED: reacting is trivially reversible, so no --execute is required", async () => {
    // Rationale: WhatsApp replaces/removes reactions and the Slack chat_action
    // contract has a remove operation — the emit above happened without any
    // brake flag in the signature.
    const { result } = await captureConsole(() => new ReactCommands().send("mid-1", "+1", true));
    expect((result as { status: string }).status).toBe("accepted");
    expect(emittedEvents).toHaveLength(1);
  });

  it("fails with NO_CHANNEL_CONTEXT (exit 1) when there is no channel source", async () => {
    sourceAvailable = false;
    const error = await expectContractError(
      () => new ReactCommands().send("mid-1", "+1", true),
      "NO_CHANNEL_CONTEXT",
      1,
    );

    expect(error.details.suggestedAction).toContain("routed channel session");
    expect(emittedEvents).toHaveLength(0);
  });

  it("exits 1 with MESSAGE_NOT_FOUND and ledger suggestions when the chat is known and the mid is not", async () => {
    ledgerChat = { id: "chat-1" };
    ledgerMessageFound = false;
    ledgerRecentMessages = [{ providerMessageId: "mid-100" }, { providerMessageId: "mid-200" }];

    const error = await expectContractError(
      () => new ReactCommands().send("mid-999", "+1", true),
      "MESSAGE_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("mid-100");
    expect(emittedEvents).toHaveLength(0);
  });

  it("emits normally when the ledger knows both the chat and the message", async () => {
    ledgerChat = { id: "chat-1" };
    ledgerMessageFound = true;

    const { result } = await captureConsole(() => new ReactCommands().send("mid-1", "+1", true));

    expect((result as { status: string }).status).toBe("accepted");
    expect(emittedEvents).toHaveLength(1);
  });

  it("fails open when the current chat is not in the local ledger", async () => {
    ledgerChat = null;

    const { result } = await captureConsole(() => new ReactCommands().send("mid-unknown", "+1", true));

    expect((result as { status: string }).status).toBe("accepted");
    expect(emittedEvents).toHaveLength(1);
  });
});
