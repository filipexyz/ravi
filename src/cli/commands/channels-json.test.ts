import { afterAll, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

type RequestCall = {
  topic: string;
  data: Record<string, unknown>;
};

let requestCalls: RequestCall[] = [];
let emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

mock.module("../context.js", () => ({
  getContext: () => undefined,
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
    if (topic.endsWith(".add")) {
      return { ok: true, participants: data.participants };
    }
    return { ok: true };
  }),
}));

mock.module("../../contacts.js", () => ({
  getContact: (ref: string) => ({
    id: "contact-1",
    phone: ref,
    name: "Alice",
    identities: [{ platform: "phone", value: "5511999999999", isPrimary: true }],
  }),
  getContactIdentities: () => [{ platform: "phone", value: "5511999999999", isPrimary: true }],
  normalizePhone: (value: string) => value,
  formatPhone: (value: string) => value,
  upsertContact: () => {},
  findContactsByTag: () => [],
  searchContacts: () => [],
}));

mock.module("../../router/router-db.js", () => ({
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
  dbCreateRoute: () => ({
    id: 1,
    accountId: "main",
    pattern: "group:120363",
    agent: "main",
    priority: 0,
  }),
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
}));

mock.module("../../router/session-name.js", () => ({
  generateSessionName: () => "main-launch",
  ensureUniqueName: (name: string) => name,
}));

mock.module("../../router/config.js", () => ({
  getAgent: () => ({ id: "main", cwd: "/tmp/main" }),
}));

mock.module("../../router/resolver.js", () => ({
  expandHome: (value: string) => value,
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
  it("prints WhatsApp group lists as typed JSON", async () => {
    requestCalls = [];

    const payload = await captureJson(() => new GroupCommands().list("main", true));

    expect(payload.accountId).toBe("main");
    expect(payload.total).toBe(1);
    const groups = payload.groups as Array<Record<string, unknown>>;
    expect(groups[0].subject).toBe("Launch");
    expect(requestCalls[0].data.accountId).toBe("main");
  });

  it("prints WhatsApp group member mutations as typed JSON", async () => {
    requestCalls = [];

    const payload = await captureJson(() => new GroupCommands().add("120363@g.us", "5511999999999", "main", true));

    expect(payload.status).toBe("added");
    expect(payload.changedCount).toBe(1);
    expect(payload.participants).toEqual(["5511999999999"]);
    expect((payload.result as Record<string, unknown>).ok).toBe(true);
  });

  it("prints WhatsApp DM send results as typed JSON", async () => {
    emitted = [];

    const payload = await captureJson(() => new WhatsAppDmCommands().send("5511999999999", "hello\\!", "main", true));

    expect(payload.status).toBe("sent");
    expect(payload.to).toBe("5511999999999@s.whatsapp.net");
    expect(payload.text).toBe("hello!");
    expect(emitted[0].topic).toBe("ravi.outbound.deliver");
  });

  it("prints WhatsApp DM reads and auto-ack metadata as typed JSON", async () => {
    emitted = [];

    const payload = await captureJson(() => new WhatsAppDmCommands().read("5511999999999", "5", false, "main", true));

    expect(payload.total).toBe(2);
    expect(payload.ackedMessageId).toBe("msg-1");
    expect(emitted[0].topic).toBe("ravi.outbound.receipt");
  });
});
