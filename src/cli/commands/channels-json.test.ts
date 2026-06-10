import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const actorEnvKeys = [
  "RAVI_ACTOR_TYPE",
  "RAVI_CONTACT_ID",
  "RAVI_PLATFORM_IDENTITY_ID",
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
let knownAgents = new Map<string, { id: string; cwd: string; provider?: string; model?: string }>();
let createdAgents: Array<{ id: string; cwd: string; provider?: string; model?: string }> = [];
let routeCreates: Array<Record<string, unknown>> = [];
let chatParticipants: Array<Record<string, unknown>> = [];
let sessionAttachments: Array<Record<string, unknown>> = [];
let omniGroupCreates: Array<{ instanceId: string; body: { subject: string; participants: string[] } }> = [];
let omniGroupLists: Array<{ instanceId: string; params?: Record<string, unknown> }> = [];
let omniGroupParticipantAdds: Array<{ instanceId: string; groupJid: string; participants: string[] }> = [];
let omniGroupParticipantUpdates: Array<{
  instanceId: string;
  groupJid: string;
  action: string;
  participants: string[];
}> = [];
let omniGroupInvites: Array<{ op: string; instanceId: string; groupJid?: string; code?: string }> = [];
let omniGroupMutations: Array<{ op: string; instanceId: string; groupJid: string; value?: string }> = [];
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

mock.module("../../omni-config.js", () => ({
  resolveOmniConnection: () => ({
    apiUrl: "http://omni.local",
    apiKey: "test-key",
    source: "test",
  }),
}));

mock.module("../../omni/client.js", () => ({
  createOmniClient: () => ({
    instances: {
      listGroups: mock(async (instanceId: string, params?: Record<string, unknown>) => {
        omniGroupLists.push({ instanceId, params });
        return {
          items: [{ externalId: "120363@g.us", name: "Launch", memberCount: 3, isCommunity: false }],
          meta: { totalMatched: 1 },
        };
      }),
      createGroup: mock(async (instanceId: string, body: { subject: string; participants: string[] }) => {
        omniGroupCreates.push({ instanceId, body });
        return {
          id: "120363@g.us",
          subject: body.subject,
          participants: [
            { id: "owner@s.whatsapp.net", admin: "superadmin" },
            ...body.participants.map((participant) => ({
              id: `${participant}@s.whatsapp.net`,
              admin: null,
            })),
          ],
        };
      }),
      addGroupParticipants: mock(async (instanceId: string, groupJid: string, body: { participants: string[] }) => {
        omniGroupParticipantAdds.push({ instanceId, groupJid, participants: body.participants });
        return { ok: true, participants: body.participants };
      }),
      updateGroupParticipants: mock(
        async (instanceId: string, groupJid: string, body: { action: string; participants: string[] }) => {
          omniGroupParticipantUpdates.push({
            instanceId,
            groupJid,
            action: body.action,
            participants: body.participants,
          });
          return { ok: true, action: body.action, participants: body.participants };
        },
      ),
      getGroupInvite: mock(async (instanceId: string, groupJid: string) => {
        omniGroupInvites.push({ op: "invite", instanceId, groupJid });
        return { code: "invite-code", inviteLink: "https://chat.whatsapp.com/invite-code" };
      }),
      revokeGroupInvite: mock(async (instanceId: string, groupJid: string) => {
        omniGroupInvites.push({ op: "revoke", instanceId, groupJid });
        return { code: "new-invite-code", inviteLink: "https://chat.whatsapp.com/new-invite-code" };
      }),
      joinGroup: mock(async (instanceId: string, body: { code: string }) => {
        omniGroupInvites.push({ op: "join", instanceId, code: body.code });
        return { groupJid: "120363@g.us", joined: true };
      }),
      leaveGroup: mock(async (instanceId: string, groupJid: string) => {
        omniGroupMutations.push({ op: "leave", instanceId, groupJid });
        return { ok: true };
      }),
      renameGroup: mock(async (instanceId: string, groupJid: string, body: { subject: string }) => {
        omniGroupMutations.push({ op: "rename", instanceId, groupJid, value: body.subject });
        return { ok: true, subject: body.subject };
      }),
      setGroupDescription: mock(async (instanceId: string, groupJid: string, body: { description: string }) => {
        omniGroupMutations.push({ op: "description", instanceId, groupJid, value: body.description });
        return { ok: true, description: body.description };
      }),
      setGroupSettings: mock(async (instanceId: string, groupJid: string, body: { setting: string }) => {
        omniGroupMutations.push({ op: "settings", instanceId, groupJid, value: body.setting });
        return { ok: true, setting: body.setting };
      }),
    },
    chats: {
      list: mock(async () => ({
        items: [{ id: "chat-whatsapp-instance-main-group-120363", externalId: "120363@g.us", name: "Launch" }],
        meta: { total: 1 },
      })),
      listParticipants: mock(async () => ({ items: [], meta: {} })),
      addParticipant: mock(async () => ({})),
    },
    messages: {
      send: mock(async () => ({ messageId: "omni-msg-1" })),
      sendPresence: mock(async () => undefined),
      sendReaction: mock(async () => ({ messageId: "omni-reaction-1" })),
      deleteChannel: mock(async () => undefined),
      editChannel: mock(async () => undefined),
    },
  }),
}));

mock.module("../../contacts.js", () => ({
  getContact: (ref: string) => {
    if (ref === "pi_luis" || ref === "lid:178035101794451" || ref === "178035101794451" || ref === "5511888888888") {
      return {
        id: "contact-luis",
        phone: "5511888888888",
        name: "Luis",
        identities: [
          { platform: "phone", value: "5511888888888", isPrimary: true },
          { platform: "whatsapp", value: "lid:178035101794451", isPrimary: false },
        ],
      };
    }
    return {
      id: `contact-${ref}`,
      phone: ref,
      name: "Alice",
      identities: [{ platform: "phone", value: ref, isPrimary: true }],
    };
  },
  getContactById: (id: string) => ({
    id,
    phone: "5511888888888",
    name: "Luis",
    identities: [{ platform: "phone", value: "5511888888888", isPrimary: true }],
  }),
  getContactIdentities: () => [{ platform: "phone", value: "5511999999999", isPrimary: true }],
  normalizePhone: (value: string) => {
    const trimmed = value.trim();
    if (trimmed.startsWith("lid:")) return `lid:${trimmed.slice(4).replace(/\D/g, "")}`;
    return trimmed.replace(/\D/g, "");
  },
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
  dbFindChat: () => ({
    id: "chat-whatsapp-instance-main-group-120363",
    channel: "whatsapp",
    instanceId: "instance-main",
    platformChatId: "120363@g.us",
    normalizedChatId: "group:120363",
    chatType: "group",
    title: "Launch",
  }),
  dbListChats: () => ({
    total: 1,
    limit: 500,
    offset: 0,
    items: [
      {
        chat: {
          id: "chat-whatsapp-instance-main-group-120363",
          channel: "whatsapp",
          instanceId: "instance-main",
          platformChatId: "120363@g.us",
          normalizedChatId: "group:120363",
          chatType: "group",
          title: "Launch",
        },
        participantCount: 3,
        messageCount: 0,
        lastMessage: null,
      },
    ],
  }),
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
  createAgent: (input: { id: string; cwd: string; provider?: string; model?: string }) => {
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
    omniGroupCreates = [];
    omniGroupLists = [];
    omniGroupParticipantAdds = [];
    omniGroupParticipantUpdates = [];
    omniGroupInvites = [];
    omniGroupMutations = [];
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
    expect(payload.source).toBe("omni.rest");
    expect(omniGroupLists).toEqual([{ instanceId: "instance-main", params: { limit: 500 } }]);
    expect(requestCalls.find((call) => call.topic.endsWith(".list"))).toBeUndefined();
  });

  it("prints WhatsApp group member mutations as typed JSON", async () => {
    const payload = await captureJson(() => new GroupCommands().add("120363@g.us", "5511999999999", "main", true));

    expect(payload.status).toBe("added");
    expect(payload.changedCount).toBe(1);
    expect(payload.participants).toEqual(["5511999999999"]);
    expect((payload.result as Record<string, unknown>).ok).toBe(true);
    expect(payload.source).toBe("omni.rest.group_participants");
    expect(omniGroupParticipantAdds).toEqual([
      { instanceId: "instance-main", groupJid: "120363@g.us", participants: ["5511999999999"] },
    ]);
    expect(requestCalls.find((call) => call.topic.endsWith(".add"))).toBeUndefined();
  });

  it("uses Omni REST for all WhatsApp group operations instead of the legacy NATS bridge", async () => {
    const commands = new GroupCommands();

    const remove = await captureJson(() => commands.remove("120363@g.us", "5511999999999", "main", true));
    const promote = await captureJson(() => commands.promote("120363@g.us", "5511999999999", "main", true));
    const demote = await captureJson(() => commands.demote("120363@g.us", "5511999999999", "main", true));
    const invite = await captureJson(() => commands.invite("120363@g.us", "main", true));
    const revoke = await captureJson(() => commands.revokeInvite("120363@g.us", "main", true));
    const join = await captureJson(() => commands.join("https://chat.whatsapp.com/invite-code", "main", true));
    const leave = await captureJson(() => commands.leave("120363@g.us", "main", true));
    const rename = await captureJson(() => commands.rename("120363@g.us", "Renamed", "main", true));
    const description = await captureJson(() => commands.description("120363@g.us", "New description", "main", true));
    const settings = await captureJson(() => commands.settings("120363@g.us", "announcement", "main", true));

    expect(remove).toMatchObject({ status: "removed", source: "omni.rest.group_participants" });
    expect(promote).toMatchObject({ status: "promoted", source: "omni.rest.group_participants" });
    expect(promote.localParticipants).toMatchObject({ status: "updated", admins: 1 });
    expect(demote).toMatchObject({ status: "demoted", source: "omni.rest.group_participants" });
    expect(demote.localParticipants).toMatchObject({ status: "updated", admins: 0 });
    expect(invite).toMatchObject({ status: "invite_link", source: "omni.rest.group_invite" });
    expect(revoke).toMatchObject({ status: "invite_revoked", source: "omni.rest.group_invite" });
    expect(join).toMatchObject({ status: "joined", source: "omni.rest.group_join", code: "invite-code" });
    expect(leave).toMatchObject({ status: "left", source: "omni.rest.group" });
    expect(rename).toMatchObject({ status: "renamed", source: "omni.rest.group", subject: "Renamed" });
    expect(description).toMatchObject({
      status: "description_updated",
      source: "omni.rest.group",
      description: "New description",
    });
    expect(settings).toMatchObject({ status: "setting_applied", source: "omni.rest.group", setting: "announcement" });
    expect(omniGroupParticipantUpdates).toEqual([
      { instanceId: "instance-main", groupJid: "120363@g.us", action: "remove", participants: ["5511999999999"] },
      { instanceId: "instance-main", groupJid: "120363@g.us", action: "promote", participants: ["5511999999999"] },
      { instanceId: "instance-main", groupJid: "120363@g.us", action: "demote", participants: ["5511999999999"] },
    ]);
    expect(omniGroupInvites).toEqual([
      { op: "invite", instanceId: "instance-main", groupJid: "120363@g.us" },
      { op: "revoke", instanceId: "instance-main", groupJid: "120363@g.us" },
      { op: "join", instanceId: "instance-main", code: "invite-code" },
    ]);
    expect(omniGroupMutations).toEqual([
      { op: "leave", instanceId: "instance-main", groupJid: "120363@g.us" },
      { op: "rename", instanceId: "instance-main", groupJid: "120363@g.us", value: "Renamed" },
      { op: "description", instanceId: "instance-main", groupJid: "120363@g.us", value: "New description" },
      { op: "settings", instanceId: "instance-main", groupJid: "120363@g.us", value: "announcement" },
    ]);
    expect(requestCalls.filter((call) => call.topic.startsWith("ravi.whatsapp.group"))).toEqual([]);
  });

  it("creates an agent, WhatsApp group route, and chat/session binding in one command", async () => {
    toolContext = {
      context: {
        metadata: {
          senderPhone: "5511888888888",
          rawSenderId: "178035101794451",
          platformIdentityId: "pi_luis",
        },
      },
    };

    const payload = await captureJson(() =>
      new GroupCommands().create(
        "Launch",
        "5511999999999",
        "main",
        "launch-agent",
        true,
        "/tmp/launch-agent",
        "codex",
        "gpt-5.5",
        undefined,
        undefined,
        true,
        true,
      ),
    );

    expect(createdAgents).toEqual([
      { id: "launch-agent", cwd: "/tmp/launch-agent", provider: "codex", model: "gpt-5.5" },
    ]);
    expect(omniGroupCreates).toEqual([
      {
        instanceId: "instance-main",
        body: {
          subject: "Launch",
          participants: ["5511999999999", "5511888888888"],
        },
      },
    ]);
    expect(requestCalls.find((call) => call.topic.endsWith(".create"))).toBeUndefined();
    expect(requestCalls.find((call) => call.topic.endsWith(".promote"))).toBeUndefined();
    expect(omniGroupParticipantUpdates).toEqual([
      {
        instanceId: "instance-main",
        groupJid: "120363@g.us",
        action: "promote",
        participants: ["5511888888888"],
      },
    ]);
    expect(routeCreates[0]).toMatchObject({
      pattern: "group:120363",
      accountId: "main",
      agent: "launch-agent",
      channel: "whatsapp",
    });
    expect(chatParticipants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contactId: "contact-5511999999999", role: "member" }),
        expect.objectContaining({ contactId: "contact-luis", role: "admin" }),
        expect.objectContaining({ agentId: "launch-agent", role: "agent" }),
      ]),
    );
    expect(sessionAttachments[0]).toMatchObject({ role: "primary", setOutputTarget: true, speechMode: "speak" });
    expect(payload.agent).toMatchObject({ status: "created", agentId: "launch-agent" });
    expect(payload.adminPromotion).toMatchObject({
      status: "promoted",
      source: "omni.rest.group_participants",
      actorAdmins: ["5511888888888"],
      explicitAdmins: [],
      changedCount: 1,
    });
    expect(payload.session).toMatchObject({ status: "created", agent: "launch-agent" });
  });

  it("creates a WhatsApp group with the current actor when participants are omitted", async () => {
    toolContext = {
      context: {
        metadata: {
          actor: {
            actorType: "contact",
            platformIdentityId: "pi_luis",
          },
        },
      },
    };

    const payload = await captureJson(() =>
      new GroupCommands().create(
        "Actor Group",
        undefined,
        "main",
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

    expect(omniGroupCreates.at(-1)).toEqual({
      instanceId: "instance-main",
      body: {
        subject: "Actor Group",
        participants: ["5511888888888"],
      },
    });
    expect(payload.requestedParticipants).toEqual([]);
    expect(payload.actorAdmins).toEqual(["5511888888888"]);
    expect(payload.participants).toEqual(["5511888888888"]);
    expect(chatParticipants).toEqual(
      expect.arrayContaining([expect.objectContaining({ contactId: "contact-luis", role: "admin" })]),
    );
    expect(payload.adminPromotion).toMatchObject({
      status: "promoted",
      actorAdmins: ["5511888888888"],
      changedCount: 1,
    });
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
