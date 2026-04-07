import { beforeEach, describe, expect, it, mock } from "bun:test";

type RuntimeEventPayload = Record<string, unknown>;
type ResponseEventPayload = { response?: string; error?: string };

let runtimeEvents: RuntimeEventPayload[] = [];
let claudeEvents: RuntimeEventPayload[] = [];
let responseEvents: ResponseEventPayload[] = [];
const publishedPrompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

function makeSubscription<T extends Record<string, unknown>>(events: T[]) {
  return (async function* () {
    for (const data of events) {
      yield { data };
    }
  })();
}

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: {
    subscribe: (topic: string) => {
      if (topic.endsWith(".runtime")) return makeSubscription(runtimeEvents);
      if (topic.endsWith(".claude")) return makeSubscription(claudeEvents);
      if (topic.endsWith(".response")) return makeSubscription(responseEvents);
      return makeSubscription([]);
    },
    emit: mock(async () => {}),
    close: mock(async () => {}),
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishedPrompts.push({ sessionName, payload });
  }),
}));

mock.module("../../router/sessions.js", () => ({
  listSessions: () => [],
  getSessionsByAgent: () => [],
  deleteSession: () => {},
  resetSession: () => {},
  resolveSession: () => null,
  getOrCreateSession: () => null,
  findSessionByChatId: () => null,
  updateSessionDisplayName: () => {},
  updateSessionModelOverride: () => {},
  updateSessionThinkingLevel: () => {},
  setSessionEphemeral: () => {},
  extendSession: () => {},
  makeSessionPermanent: () => {},
}));

mock.module("../../router/session-key.js", () => ({
  deriveSourceFromSessionKey: () => undefined,
}));

mock.module("../../router/index.js", () => ({
  loadRouterConfig: () => ({ agents: {} }),
  expandHome: (path: string) => path,
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessSession: () => true,
  canModifySession: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
}));

mock.module("../../transcripts.js", () => ({
  locateRuntimeTranscript: () => ({ path: null, reason: "Transcript not found" }),
}));

const { SessionCommands } = await import("./sessions.js");
const { extractNormalizedTranscriptMessages } = await import("./sessions.js");

describe("SessionCommands wait mode", () => {
  beforeEach(() => {
    runtimeEvents = [];
    claudeEvents = [];
    responseEvents = [];
    publishedPrompts.length = 0;
  });

  it("throws the runtime failure when a waited session fails without response output", async () => {
    runtimeEvents = [
      {
        type: "turn.failed",
        error:
          "Runtime provider 'codex' requires full tool and executable access because Ravi permission hooks are unsupported",
      },
    ];

    const commands = new SessionCommands();

    await expect(
      (commands as any).streamToSession("codex-cli-locked", "say hi", {
        sessionKey: "codex-cli-locked",
        name: "codex-cli-locked",
        agentId: "codex-cli-locked",
        agentCwd: "/tmp/codex-cli-locked",
      }),
    ).rejects.toThrow(
      "Runtime provider 'codex' requires full tool and executable access because Ravi permission hooks are unsupported",
    );

    expect(publishedPrompts).toHaveLength(1);
    expect(publishedPrompts[0]?.sessionName).toBe("codex-cli-locked");
  });

  it("does not print a success footer when send -w fails", async () => {
    const commands = new SessionCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      (commands as any).resolveTarget = () => ({
        sessionKey: "codex-cli-locked",
        name: "codex-cli-locked",
        agentId: "codex-cli-locked",
        agentCwd: "/tmp/codex-cli-locked",
      });
      (commands as any).streamToSession = async () => {
        throw new Error("blocked by runtime");
      };

      await expect(commands.send("codex-cli-locked", "say hi", false, true)).rejects.toThrow("blocked by runtime");
      expect(logCalls.some((line) => line.includes("✅ Done"))).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });

  it("throws on timeout instead of treating the wait as success", async () => {
    const commands = new SessionCommands();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
      if (typeof handler === "function") {
        handler();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((_: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout;

    try {
      await expect(
        (commands as any).streamToSession("slow-session", "say hi", {
          sessionKey: "slow-session",
          name: "slow-session",
          agentId: "agent-slow",
          agentCwd: "/tmp/slow-session",
        }),
      ).rejects.toThrow("Timed out waiting for response from slow-session after 120s");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

describe("extractNormalizedTranscriptMessages", () => {
  it("reads codex event_msg transcripts as user/assistant history", () => {
    const raw = [
      JSON.stringify({
        timestamp: "2026-03-22T14:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "[WhatsApp] Luís: oi" },
      }),
      JSON.stringify({
        timestamp: "2026-03-22T14:00:05.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Vou olhar isso agora.", phase: "commentary" },
      }),
      JSON.stringify({
        timestamp: "2026-03-22T14:00:10.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Feito.", phase: "final_answer" },
      }),
    ].join("\n");

    const messages = extractNormalizedTranscriptMessages(raw, "codex");

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "[WhatsApp] Luís: oi"],
      ["assistant", "Vou olhar isso agora."],
      ["assistant", "Feito."],
    ]);
  });
});
