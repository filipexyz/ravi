import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const actorEnvKeys = [
  "RAVI_CONTACT_ID",
  "RAVI_SENDER_PHONE",
  "RAVI_SENDER_ID",
  "RAVI_NORMALIZED_SENDER_ID",
  "RAVI_RAW_SENDER_ID",
];
const originalActorEnv = new Map(actorEnvKeys.map((key) => [key, process.env[key]]));

afterAll(() => {
  for (const key of actorEnvKeys) {
    const value = originalActorEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  mock.restore();
});

type RequestCall = {
  topic: string;
  data: Record<string, unknown>;
};

let requestCalls: RequestCall[] = [];
let emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
let knownAgents = new Map<string, { id: string; cwd: string; provider?: string }>();
let createdAgents: Array<{ id: string; cwd: string; provider?: string }> = [];
let routeCreates: Array<Record<string, unknown>> = [];
let chatParticipants: Array<Record<string, unknown>> = [];
let sessionAttachments: Array<Record<string, unknown>> = [];
let toolContext: Record<string, unknown> | undefined;

mock.module("../context.js", () => ({
  getContext: () => toolContext,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../utils/request-reply.js", () => ({
  requestReply: mock(async (topic: string, data: Record<string, unknown>) => {
    requestCalls.push({ topic, data });
    if (topic.endsWith(".list")) {
      return {
        total: 1,
        groups: [{ id: "120363@g.us", subject: "Launch", size: 3, isCommunity: false }],
      };
    }
    if (topic.endsWith(".create")) {
      return { id: "120363@g.us", subject: data.subject, participants: (data.participants as unknown[]).length };
    }
    if (topic.endsWith(".add")) {
      return { ok: true, participants: data.participants };
    }
    if (topic.endsWith(".promote")) {
      return { ok: true, participants: data.participants };
    }
    return { ok: true };
  }),
}));

mock.module("../../contacts.js", () => ({
  getContact: (ref: string) => ({
    id: `contact-${ref}`,
    phone: ref,
    name: "Alice",
    identities: [{ platform: "phone", value: ref, isPrimary: true }],
  }),
  getContactById: (id: string) => ({
    id,
    phone: "5511888888888",
    name: "Luis",
    identities: [{ platform: "phone", value: "5511888888888", isPrimary: true }],
  }),
  getContactIdentities: () => [{ platform: "phone", value: "5511999999999", isPrimary: true }],
  normalizePhone: (value: string) => value.replace(/\D/g, ""),
  formatPhone: (value: string) => value,
  upsertContact: () => {},
  findContactsByTag: () => [],
  searchContacts: () => [],
}));

mock.module("../../router/router-db.js", () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [],
      get: () => null,
      run: () => undefined,
    }),
  }),
  getFirstAccountName: () => "main",
  dbGetInstance: () => ({ instanceId: "instance-main" }),
  dbUpsertChat: () => ({
    id: "chat-whatsapp-instance-main-group-120363",
    channel: "whatsapp",
    instanceId: "instance-main",
    platformChatId: "120363@g.us",
    normalizedChatId: "group:120363",
    chatType: "group",
    title: "Launch",
  }),
  dbUpsertChatParticipant: (input: Record<string, unknown>) => {
    chatParticipants.push(input);
    return input;
  },
  dbBindSessionToChat: (input: Record<string, unknown>) => input,
  dbCreateRoute: (input: Record<string, unknown>) => {
    routeCreates.push(input);
    return {
      id: 1,
      accountId: input.accountId,
      pattern: input.pattern,
      agent: input.agent,
      priority: input.priority ?? 0,
      channel: input.channel,
    };
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async () => {}),
}));

mock.module("../../router/session-key.js", () => ({
  buildSessionKey: () => "agent:main:whatsapp:main:group:120363",
}));

mock.module("../../router/sessions.js", () => ({
  getOrCreateSession: () => ({ name: "main-launch" }),
  updateSessionSource: () => {},
  updateSessionName: () => {},
  attachChatToSession: (input: Record<string, unknown>) => {
    sessionAttachments.push(input);
    return {
      subscription: { sessionKey: input.sessionKey, chatId: input.chatId, outputAttachedAt: 1 },
      created: true,
      outputAttached: true,
    };
  },
}));

mock.module("../../router/session-name.js", () => ({
  generateSessionName: () => "main-launch",
  ensureUniqueName: (name: string) => name,
}));

mock.module("../../router/config.js", () => ({
  getAgent: (id: string) => knownAgents.get(id) ?? null,
  createAgent: (input: { id: string; cwd: string; provider?: string }) => {
    knownAgents.set(input.id, input);
    createdAgents.push(input);
    return input;
  },
}));

mock.module("../../router/resolver.js", () => ({
  expandHome: (value: string) => value,
}));

mock.module("../../runtime/agent-instructions.js", () => ({
  ensureAgentInstructionFiles: () => ({ createdAgents: true }),
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: mock(async (topic: string, data: Record<string, unknown>) => {
      emitted.push({ topic, data });
    }),
    subscribe: mock(() => (async function* () {})()),
    close: mock(async () => {}),
  },
}));

mock.module("../../utils/phone.js", () => ({
  phoneToJid: (value: string) => `${value.replace(/^lid:/, "")}@s.whatsapp.net`,
  jidToSessionId: (jid: string) => `wa-${jid}`,
}));

mock.module("../../db.js", () => ({
  getRecentHistory: () => [
    {
      id: 1,
      session_id: "wa-5511999999999@s.whatsapp.net",
      role: "user",
      content: "[mid:msg-1] hello",
      sdk_session_id: null,
      created_at: "2026-04-20T00:00:00.000Z",
    },
    {
      id: 2,
      session_id: "wa-5511999999999@s.whatsapp.net",
      role: "assistant",
      content: "hi",
      sdk_session_id: null,
      created_at: "2026-04-20T00:00:01.000Z",
    },
  ],
}));

const { GroupCommands } = await import("./group.js");
const { WhatsAppDmCommands } = await import("./whatsapp-dm.js");

async function captureJson(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await run();
  } finally {
    console.log = originalLog;
  }

  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

describe("channel command --json output", () => {
  beforeEach(() => {
    requestCalls = [];
    emitted = [];
    knownAgents = new Map([["main", { id: "main", cwd: "/tmp/main" }]]);
    createdAgents = [];
    routeCreates = [];
    chatParticipants = [];
    sessionAttachments = [];
    toolContext = undefined;
    for (const key of actorEnvKeys) {
      delete process.env[key];
    }
  });

  it("prints WhatsApp group lists as typed JSON", async () => {
    const payload = await captureJson(() => new GroupCommands().list("main", true));

    expect(payload.accountId).toBe("main");
    expect(payload.total).toBe(1);
    const groups = payload.groups as Array<Record<string, unknown>>;
    expect(groups[0].subject).toBe("Launch");
    expect(requestCalls[0].data.accountId).toBe("main");
  });

  it("prints WhatsApp group member mutations as typed JSON", async () => {
    const payload = await captureJson(() => new GroupCommands().add("120363@g.us", "5511999999999", "main", true));

    expect(payload.status).toBe("added");
    expect(payload.changedCount).toBe(1);
    expect(payload.participants).toEqual(["5511999999999"]);
    expect((payload.result as Record<string, unknown>).ok).toBe(true);
  });

  it("creates an agent, WhatsApp group route, admin promotion, and chat/session binding in one command", async () => {
    toolContext = { context: { metadata: { senderPhone: "5511888888888" } } };

    const payload = await captureJson(() =>
      new GroupCommands().create(
        "Launch",
        "5511999999999",
        "main",
        "launch-agent",
        true,
        "/tmp/launch-agent",
        "codex",
        undefined,
        undefined,
        true,
        true,
      ),
    );

    expect(createdAgents).toEqual([{ id: "launch-agent", cwd: "/tmp/launch-agent", provider: "codex" }]);
    expect(requestCalls.find((call) => call.topic.endsWith(".create"))?.data.participants).toEqual([
      "5511999999999",
      "5511888888888",
    ]);
    expect(requestCalls.find((call) => call.topic.endsWith(".promote"))?.data.participants).toEqual(["5511888888888"]);
    expect(routeCreates[0]).toMatchObject({
      pattern: "group:120363",
      accountId: "main",
      agent: "launch-agent",
      channel: "whatsapp",
    });
    expect(chatParticipants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contactId: "contact-5511999999999", role: "member" }),
        expect.objectContaining({ contactId: "contact-5511888888888", role: "admin" }),
        expect.objectContaining({ agentId: "launch-agent", role: "agent" }),
      ]),
    );
    expect(sessionAttachments[0]).toMatchObject({ role: "primary", setOutputTarget: true, speechMode: "speak" });
    expect(payload.agent).toMatchObject({ status: "created", agentId: "launch-agent" });
    expect(payload.adminPromotion).toMatchObject({
      status: "promoted",
      actorAdmins: ["5511888888888"],
      explicitAdmins: [],
    });
    expect(payload.session).toMatchObject({ status: "created", agent: "launch-agent" });
  });

  it("prints WhatsApp DM send results as typed JSON", async () => {
    const payload = await captureJson(() => new WhatsAppDmCommands().send("5511999999999", "hello\\!", "main", true));

    expect(payload.status).toBe("sent");
    expect(payload.to).toBe("5511999999999@s.whatsapp.net");
    expect(payload.text).toBe("hello!");
    expect(emitted[0].topic).toBe("ravi.outbound.deliver");
  });

  it("prints WhatsApp DM reads and auto-ack metadata as typed JSON", async () => {
    const payload = await captureJson(() => new WhatsAppDmCommands().read("5511999999999", "5", false, "main", true));

    expect(payload.total).toBe(2);
    expect(payload.ackedMessageId).toBe("msg-1");
    expect(emitted[0].topic).toBe("ravi.outbound.receipt");
  });
});
