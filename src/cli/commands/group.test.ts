/**
 * Agent-first contract tests for the `whatsapp.group` and `whatsapp.dm` CLI
 * domains (Manual v2): risk-based write brakes (exit 3), immediate containment,
 * not-found envelopes (GROUP_NOT_FOUND / CONTACT_NOT_FOUND, exit 1) and
 * compact `--fields` mode. Follows the tasks.test.ts pattern: no-op decorator
 * mocks + service/provider mocks with spies + `hasContext: () => true` so the
 * contract helpers throw ContractError instead of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { hashForAudit } from "../provenance.js";

const previousActorType = process.env.RAVI_ACTOR_TYPE;
// Keep inferActorAdminPhones deterministic: agent actors contribute no phones.
process.env.RAVI_ACTOR_TYPE = "agent";

afterAll(() => {
  if (previousActorType === undefined) delete process.env.RAVI_ACTOR_TYPE;
  else process.env.RAVI_ACTOR_TYPE = previousActorType;
  mock.restore();
});

// ---------------------------------------------------------------------------
// Spies and mutable fixtures
// ---------------------------------------------------------------------------

const senderSendCalls: Array<Record<string, unknown>> = [];
const natsEmits: Array<{ topic: string; payload: Record<string, unknown> }> = [];
const metadataCalls: Array<Record<string, unknown>> = [];
const createGroupCalls: Array<Record<string, unknown>> = [];
const addParticipantCalls: Array<Record<string, unknown>> = [];
const updateParticipantCalls: Array<Record<string, unknown>> = [];
const revokeInviteCalls: Array<Record<string, unknown>> = [];
const joinCalls: Array<Record<string, unknown>> = [];
const leaveCalls: Array<Record<string, unknown>> = [];
const renameCalls: Array<Record<string, unknown>> = [];
const setDescriptionCalls: Array<Record<string, unknown>> = [];
const setSettingsCalls: Array<Record<string, unknown>> = [];
const createAgentCalls: Array<Record<string, unknown>> = [];
const upsertChatCalls: Array<Record<string, unknown>> = [];
const upsertChatParticipantCalls: Array<Record<string, unknown>> = [];

let listGroupsResult: Array<Record<string, unknown>> = [];
let metadataResult: Record<string, unknown> | null = null;
let historyMock: Array<{ role: string; content: string; created_at: string }> = [];

interface MockContact {
  id: string;
  name: string | null;
  phone: string;
  identities: Array<{ platform: string; value: string }>;
}

const contactsMock: MockContact[] = [
  {
    id: "c1",
    name: "Joao Silva",
    phone: "5511999999999",
    identities: [
      { platform: "phone", value: "5511999999999" },
      { platform: "whatsapp", value: "5511999999999" },
    ],
  },
  {
    id: "c2",
    name: "Maria Souza",
    phone: "5511888888888",
    identities: [{ platform: "phone", value: "5511888888888" }],
  },
  {
    id: "c3",
    name: "SENTINEL_PRIVATE_DISPLAY_NAME",
    phone: "5511777666555",
    identities: [{ platform: "whatsapp", value: "5511777666555" }],
  },
];

function findMockContact(ref: string): MockContact | null {
  const digits = ref.replace(/\D/g, "");
  return contactsMock.find((c) => c.id === ref || c.name === ref || (digits.length > 0 && c.phone === digits)) ?? null;
}

// ---------------------------------------------------------------------------
// Module mocks (must be installed before importing the modules under test)
// ---------------------------------------------------------------------------

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
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("./operational-return-schemas.js", () => ({
  commandEnvelopeReturnSchema: {},
  declareCommandReturns: () => {},
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: async (topic: string, payload: Record<string, unknown>) => {
      natsEmits.push({ topic, payload });
    },
  },
}));

mock.module("../../contacts.js", () => ({
  getContact: (ref: string) => findMockContact(ref),
  getContactById: (id: string) => contactsMock.find((c) => c.id === id) ?? null,
  getContactIdentities: (id: string) => contactsMock.find((c) => c.id === id)?.identities ?? [],
  normalizePhone: (value: string) => (value ?? "").replace(/\D/g, ""),
  formatPhone: (value: string) => `+${(value ?? "").replace(/\D/g, "")}`,
  findContactsByTag: () => [],
  searchContacts: (query: string) => {
    const needle = query.toLowerCase();
    const digits = query.replace(/\D/g, "");
    return contactsMock.filter(
      (c) =>
        (needle.length > 0 && (c.name ?? "").toLowerCase().includes(needle)) ||
        (digits.length > 0 && c.phone.includes(digits)),
    );
  },
}));

mock.module("../../router/router-db.js", () => ({
  dbGetInstance: () => ({ instanceId: "inst-1" }),
  getFirstAccountName: () => "main",
  dbListChats: () => ({ items: [], total: 0 }),
  dbFindChat: () => null,
  dbUpsertChat: (input: Record<string, unknown>) => {
    upsertChatCalls.push(input);
    return { id: "chat-1" };
  },
  dbUpsertChatParticipant: (input: Record<string, unknown>) => {
    upsertChatParticipantCalls.push(input);
  },
  dbCreateRoute: (input: Record<string, unknown>) => ({ id: "route-1", ...input }),
  dbBindSessionToChat: () => {},
}));

mock.module("../../channels/session-prompt.js", () => ({
  publishChannelSessionPrompt: async () => {},
}));

mock.module("../../omni/group-metadata-cache.js", () => ({
  resolveOmniGroupMetadata: async (input: Record<string, unknown>) => {
    metadataCalls.push(input);
    return metadataResult;
  },
}));

mock.module("../../omni/mentions.js", () => ({
  prepareOmniMentionMessage: (input: { text: string }) => ({
    text: input.text,
    mentions: [],
    resolved: [],
  }),
}));

mock.module("../../omni/sender.js", () => ({
  OmniSender: class OmniSender {
    async send(instanceId: string, to: string, text: string, extra?: Record<string, unknown>) {
      senderSendCalls.push({ instanceId, to, text, ...(extra ?? {}) });
      return { messageId: "wamid-1" };
    }
  },
}));

mock.module("../../omni/client.js", () => ({
  createOmniClient: () => ({
    instances: {
      createGroup: async (instanceId: string, input: Record<string, unknown>) => {
        createGroupCalls.push({ instanceId, ...input });
        return { id: "999@g.us", subject: input.subject, participants: input.participants };
      },
      listGroups: async () => ({ items: listGroupsResult, meta: {} }),
      addGroupParticipants: async (instanceId: string, groupJid: string, input: Record<string, unknown>) => {
        addParticipantCalls.push({ instanceId, groupJid, ...input });
        return { ok: true };
      },
      updateGroupParticipants: async (instanceId: string, groupJid: string, input: Record<string, unknown>) => {
        updateParticipantCalls.push({ instanceId, groupJid, ...input });
        return { ok: true };
      },
      getGroupInvite: async () => ({ code: "CODE" }),
      revokeGroupInvite: async (instanceId: string, groupJid: string) => {
        revokeInviteCalls.push({ instanceId, groupJid });
        return { code: "NEWCODE" };
      },
      joinGroup: async (instanceId: string, input: Record<string, unknown>) => {
        joinCalls.push({ instanceId, ...input });
        return { groupJid: "999@g.us" };
      },
      leaveGroup: async (instanceId: string, groupJid: string) => {
        leaveCalls.push({ instanceId, groupJid });
        return { ok: true };
      },
      renameGroup: async (instanceId: string, groupJid: string, input: Record<string, unknown>) => {
        renameCalls.push({ instanceId, groupJid, ...input });
        return { ok: true };
      },
      setGroupDescription: async (instanceId: string, groupJid: string, input: Record<string, unknown>) => {
        setDescriptionCalls.push({ instanceId, groupJid, ...input });
        return { ok: true };
      },
      setGroupSettings: async (instanceId: string, groupJid: string, input: Record<string, unknown>) => {
        setSettingsCalls.push({ instanceId, groupJid, ...input });
        return { ok: true };
      },
    },
  }),
}));

mock.module("../../omni-config.js", () => ({
  resolveOmniConnection: () => ({ apiUrl: "http://omni.test", apiKey: "key" }),
}));

mock.module("../../router/session-key.js", () => ({
  buildSessionKey: () => "agent:main:whatsapp:group:999",
}));

mock.module("../../router/sessions.js", () => ({
  attachChatToSession: () => ({ status: "attached" }),
  getOrCreateSession: () => ({ name: "sess-1" }),
  updateSessionSource: () => {},
  updateSessionName: () => {},
}));

mock.module("../../router/session-name.js", () => ({
  generateSessionName: () => "sess-1",
  ensureUniqueName: (name: string) => name,
}));

mock.module("../../router/config.js", () => ({
  createAgent: (input: Record<string, unknown>) => {
    createAgentCalls.push(input);
    return { id: input.id, cwd: input.cwd };
  },
  getAgent: () => undefined,
}));

mock.module("../../router/resolver.js", () => ({
  expandHome: (value: string) => value,
}));

mock.module("../../runtime/agent-instructions.js", () => ({
  ensureAgentInstructionFiles: () => {},
}));

mock.module("../../runtime/model-validation.js", () => ({
  validateRuntimeModelSelector: () => ({ ok: true }),
}));

mock.module("../../runtime/provider-registry.js", () => ({
  DEFAULT_RUNTIME_PROVIDER_ID: "claude",
}));

mock.module("../../permissions/agent-default-capabilities-provider.js", () => ({
  ensureAgentCanViewAgent: () => {},
}));

mock.module("../../runtime/turn-origin.js", () => ({
  buildRuntimeCallerPrincipal: () => ({}),
}));

mock.module("../../utils/phone.js", () => ({
  phoneToJid: (value: string) => {
    const digits = (value ?? "").replace(/\D/g, "");
    return digits.length > 0 ? `${digits}@s.whatsapp.net` : null;
  },
  jidToSessionId: (jid: string) => `wa:${jid}`,
}));

mock.module("../../db.js", () => ({
  getRecentHistory: (_sessionId: string, limit: number) => historyMock.slice(-limit),
}));

const { GroupCommands } = await import("./group.js");
const { WhatsAppDmCommands } = await import("./whatsapp-dm.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function silenced<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await silenced(async () => {
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
  senderSendCalls.length = 0;
  natsEmits.length = 0;
  metadataCalls.length = 0;
  createGroupCalls.length = 0;
  addParticipantCalls.length = 0;
  updateParticipantCalls.length = 0;
  revokeInviteCalls.length = 0;
  joinCalls.length = 0;
  leaveCalls.length = 0;
  renameCalls.length = 0;
  setDescriptionCalls.length = 0;
  setSettingsCalls.length = 0;
  createAgentCalls.length = 0;
  upsertChatCalls.length = 0;
  upsertChatParticipantCalls.length = 0;
  listGroupsResult = [];
  metadataResult = null;
  historyMock = [];
});

// ---------------------------------------------------------------------------
// whatsapp.group — write brake
// ---------------------------------------------------------------------------

describe("whatsapp group write brake", () => {
  it("send without --execute is a dry-run: exit 3 and NO provider call (not even the metadata read)", async () => {
    const commands = new GroupCommands();
    const sensitiveMessage = "SENTINEL_GROUP_MESSAGE_DO_NOT_LEAK";
    const sensitiveMentionTarget = "SENTINEL_MENTION_TARGET_DO_NOT_LEAK";
    const error = await expectContractError(
      () =>
        commands.send("120363000000000001@g.us", sensitiveMessage, undefined, sensitiveMentionTarget, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      channel: "whatsapp",
      accountId: "main",
      instanceId: "inst-1",
      targetType: "group",
      targetRef: `sha256:${hashForAudit("120363000000000001@g.us")}`,
      effect: "send-message",
      messageChars: sensitiveMessage.length,
      mentionTargetCount: 1,
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(sensitiveMessage);
    expect(serializedPlan).not.toContain(sensitiveMentionTarget);
    expect(serializedPlan).not.toContain("120363000000000001@g.us");
    expect((error.details.plan as Record<string, unknown>).text).toBeUndefined();
    expect((error.details.plan as Record<string, unknown>).to).toBeUndefined();
    expect((error.details.plan as Record<string, unknown>).mentionTargets).toBeUndefined();
    expect(senderSendCalls).toHaveLength(0);
    expect(metadataCalls).toHaveLength(0);
  });

  it("send with --execute delivers through the omni sender and strips bash escapes", async () => {
    const commands = new GroupCommands();
    const payload = await silenced(() =>
      commands.send("120363000000000001", "oi\\!", undefined, undefined, true, true),
    );

    expect(senderSendCalls).toHaveLength(1);
    expect(senderSendCalls[0]).toMatchObject({
      instanceId: "inst-1",
      to: "120363000000000001@g.us",
      text: "oi!",
    });
    expect(payload).toMatchObject({ status: "sent", to: "120363000000000001@g.us" });
  });

  it("add validates contacts BEFORE the brake: unknown participant exits 1 with CONTACT_NOT_FOUND and no provider call", async () => {
    const commands = new GroupCommands();
    const originalError = console.error;
    const errorLines: string[] = [];
    let caught: unknown;
    console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(" "));
    try {
      await commands.add("120363000000000001", "5511000000000", undefined, undefined, undefined);
    } catch (error) {
      caught = error;
    } finally {
      console.error = originalError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    const error = caught as ContractErrorInstance;
    expect(error.code).toBe("CONTACT_NOT_FOUND");
    expect(error.exitCode).toBe(1);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("Unknown participant(s): 5511000000000");

    expect(error.details.suggestedAction).toContain("ravi contacts list");
    expect(addParticipantCalls).toHaveLength(0);
  });

  it("add without --execute is a dry-run: exit 3 and no provider call", async () => {
    const commands = new GroupCommands();
    const error = await expectContractError(
      () => commands.add("120363000000000001", "5511999999999", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      targetType: "group",
      targetRef: `sha256:${hashForAudit("120363000000000001@g.us")}`,
      participantCount: 1,
      accountId: "main",
    });
    expect(JSON.stringify(error.details.plan)).not.toContain("5511999999999");
    expect(addParticipantCalls).toHaveLength(0);
  });

  it("add with --execute calls the omni participants contract", async () => {
    const commands = new GroupCommands();
    await silenced(() => commands.add("120363000000000001", "5511999999999", undefined, true, true));

    expect(addParticipantCalls).toHaveLength(1);
    expect(addParticipantCalls[0]).toMatchObject({
      groupJid: "120363000000000001@g.us",
      participants: ["5511999999999"],
    });
  });

  it("remove without --execute is a dry-run: exit 3 and no provider call", async () => {
    const commands = new GroupCommands();
    const error = await expectContractError(
      () => commands.remove("120363000000000001", "5511999999999", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      targetType: "group",
      targetRef: `sha256:${hashForAudit("120363000000000001@g.us")}`,
      participantCount: 1,
      accountId: "main",
    });
    expect(updateParticipantCalls).toHaveLength(0);
  });

  it("remove with --execute performs the remove action", async () => {
    const commands = new GroupCommands();
    await silenced(() => commands.remove("120363000000000001", "5511999999999", undefined, true, true));

    expect(updateParticipantCalls).toHaveLength(1);
    expect(updateParticipantCalls[0]).toMatchObject({
      action: "remove",
      groupJid: "120363000000000001@g.us",
      participants: ["5511999999999"],
    });
  });

  it("promote with --execute performs the promote action", async () => {
    const commands = new GroupCommands();
    await silenced(() => commands.promote("120363000000000001", "5511999999999", undefined, true, true));

    expect(updateParticipantCalls).toHaveLength(1);
    expect(updateParticipantCalls[0]).toMatchObject({ action: "promote" });
  });

  it("promote without --execute exposes only target type and participant count", async () => {
    const commands = new GroupCommands();
    const error = await expectContractError(
      () => commands.promote("120363000000000001", "5511999999999", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      targetType: "group",
      targetRef: `sha256:${hashForAudit("120363000000000001@g.us")}`,
      participantCount: 1,
      accountId: "main",
    });
    expect(JSON.stringify(error.details.plan)).not.toContain("120363000000000001");
    expect(JSON.stringify(error.details.plan)).not.toContain("5511999999999");
    expect(updateParticipantCalls).toHaveLength(0);
  });

  it("demote reduces authority immediately", async () => {
    const commands = new GroupCommands();
    const payload = await silenced(() =>
      commands.demote("120363000000000001", "5511999999999", undefined, true),
    );

    expect(updateParticipantCalls).toHaveLength(1);
    expect(updateParticipantCalls[0]).toMatchObject({
      action: "demote",
      groupJid: "120363000000000001@g.us",
      participants: ["5511999999999"],
    });
    expect(payload).toMatchObject({ status: "demoted", changedCount: 1 });
  });

  it("create without --execute is a dry-run: exit 3, no group created, no agent created", async () => {
    const commands = new GroupCommands();
    const sensitiveSubject = "SENTINEL_GROUP_SUBJECT_8K2R";
    const error = await expectContractError(
      () =>
        commands.create(
          sensitiveSubject,
          "5511999999999",
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
          undefined,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      subjectChars: sensitiveSubject.length,
      accountId: "main",
      participantCount: 1,
      requestedAdminCount: 0,
      actorAdminCount: 0,
      agentId: null,
      createAgent: false,
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(sensitiveSubject);
    expect(serializedPlan).not.toContain("5511999999999");
    expect(createGroupCalls).toHaveLength(0);
    expect(createAgentCalls).toHaveLength(0);
    expect(upsertChatCalls).toHaveLength(0);
  });

  it("create with --execute creates the group via omni and registers the local chat", async () => {
    const commands = new GroupCommands();
    await silenced(() =>
      commands.create(
        "Equipe Teste",
        "5511999999999",
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

    expect(createGroupCalls).toHaveLength(1);
    expect(createGroupCalls[0]).toMatchObject({
      instanceId: "inst-1",
      subject: "Equipe Teste",
      participants: ["5511999999999"],
    });
    expect(upsertChatCalls).toHaveLength(1);
  });

  it("create fails BEFORE the brake when the routed agent does not exist", async () => {
    const commands = new GroupCommands();
    await silenced(async () => {
      await expect(
        commands.create(
          "Equipe Teste",
          "5511999999999",
          undefined,
          "ghost",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      ).rejects.toThrow("Agent not found: ghost");
    });

    expect(createGroupCalls).toHaveLength(0);
  });

  it("rename, revoke-invite, join, leave, description and settings are all braked before any provider call", async () => {
    const commands = new GroupCommands();
    const cases: Array<{ run: () => Promise<unknown>; spy: Array<Record<string, unknown>> }> = [
      { run: () => commands.rename("123", "Novo Nome", undefined, true, undefined), spy: renameCalls },
      { run: () => commands.revokeInvite("123", undefined, true, undefined), spy: revokeInviteCalls },
      { run: () => commands.join("https://chat.whatsapp.com/ABC123", undefined, true, undefined), spy: joinCalls },
      { run: () => commands.leave("123", undefined, true, undefined), spy: leaveCalls },
      {
        run: () => commands.description("123", "Nova descrição", undefined, true, undefined),
        spy: setDescriptionCalls,
      },
      { run: () => commands.settings("123", "announcement", undefined, true, undefined), spy: setSettingsCalls },
    ];

    for (const testCase of cases) {
      await expectContractError(testCase.run, "WRITE_REQUIRES_EXECUTE", 3);
      expect(testCase.spy).toHaveLength(0);
    }
  });

  it("group mutation plans expose only target type, material effect and bounded metadata", async () => {
    const commands = new GroupCommands();
    const sensitiveGroupId = "120363000000000001";
    const sensitiveSubject = "SENTINEL_RENAME_SUBJECT_8K2R";
    const cases: Array<{ run: () => Promise<unknown>; effect: Record<string, unknown> }> = [
      {
        run: () => commands.revokeInvite(sensitiveGroupId, undefined, true, undefined),
        effect: { effect: "revoke-invite" },
      },
      {
        run: () => commands.leave(sensitiveGroupId, undefined, true, undefined),
        effect: { effect: "leave-group" },
      },
      {
        run: () => commands.rename(sensitiveGroupId, sensitiveSubject, undefined, true, undefined),
        effect: { effect: "rename-group", subjectChars: sensitiveSubject.length },
      },
      {
        run: () => commands.settings(sensitiveGroupId, "announcement", undefined, true, undefined),
        effect: { effect: "update-settings", setting: "announcement" },
      },
    ];

    for (const testCase of cases) {
      const error = await expectContractError(testCase.run, "WRITE_REQUIRES_EXECUTE", 3);
      expect(error.details.plan).toEqual({
        targetType: "group",
        targetRef: `sha256:${hashForAudit(`${sensitiveGroupId}@g.us`)}`,
        ...testCase.effect,
        accountId: "main",
      });
      const serializedPlan = JSON.stringify(error.details.plan);
      expect(serializedPlan).not.toContain(sensitiveGroupId);
      expect(serializedPlan).not.toContain(sensitiveSubject);
    }
  });

  it("join dry-run never exposes an invite link or code", async () => {
    const commands = new GroupCommands();
    const invite = "https://chat.whatsapp.com/SENTINEL_INVITE_CODE_DO_NOT_LEAK";
    const error = await expectContractError(
      () => commands.join(invite, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    const plan = error.details.plan as Record<string, unknown>;
    expect(plan).toMatchObject({ inviteProvided: true, accountId: "main" });
    expect(JSON.stringify(plan)).not.toContain("SENTINEL_INVITE_CODE_DO_NOT_LEAK");
    expect(JSON.stringify(plan)).not.toContain(invite);
    expect(joinCalls).toHaveLength(0);
  });

  it("description dry-run exposes only the target type, effect and description length", async () => {
    const commands = new GroupCommands();
    const sensitiveDescription = "SENTINEL_GROUP_DESCRIPTION_DO_NOT_LEAK";
    const error = await expectContractError(
      () => commands.description("123", sensitiveDescription, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      targetType: "group",
      targetRef: `sha256:${hashForAudit("123@g.us")}`,
      accountId: "main",
      effect: "update-description",
      descriptionChars: sensitiveDescription.length,
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(sensitiveDescription);
    expect(serializedPlan).not.toContain("123@g.us");
    expect((error.details.plan as Record<string, unknown>).description).toBeUndefined();
    expect((error.details.plan as Record<string, unknown>).groupId).toBeUndefined();
    expect(setDescriptionCalls).toHaveLength(0);
  });

  it("rename with --execute performs the provider call", async () => {
    const commands = new GroupCommands();
    await silenced(() => commands.rename("123", "Novo Nome", undefined, true, true));

    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]).toMatchObject({ groupJid: "123@g.us", subject: "Novo Nome" });
  });

  it("settings still validates the setting value before the brake", async () => {
    const commands = new GroupCommands();
    await silenced(async () => {
      await expect(commands.settings("123", "bogus", undefined, true, undefined)).rejects.toThrow("Invalid setting");
    });
    expect(setSettingsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// whatsapp.group — not-found envelope and compact mode
// ---------------------------------------------------------------------------

describe("whatsapp group envelopes and compact mode", () => {
  it("info on an unknown group exits 1 with GROUP_NOT_FOUND and suggestions from the already-fetched list", async () => {
    listGroupsResult = [
      { id: "111@g.us", subject: "Equipe Vendas", size: 3 },
      { id: "222@g.us", subject: "Suporte", size: 8 },
    ];
    metadataResult = null;

    const commands = new GroupCommands();
    const error = await expectContractError(() => commands.info("vendas", undefined, true), "GROUP_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain("Equipe Vendas");
    expect(error.details.suggestedAction).toContain("ravi whatsapp group list");
  });

  it("list --fields narrows each item to the requested fields", async () => {
    listGroupsResult = [
      { id: "111@g.us", subject: "Equipe Vendas", size: 3 },
      { id: "222@g.us", subject: "Suporte", size: 8 },
    ];

    const commands = new GroupCommands();
    const payload = await silenced(() => commands.list(undefined, true, undefined, undefined, "id,subject"));

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "subject"]);
    }
  });
});

// ---------------------------------------------------------------------------
// whatsapp.dm
// ---------------------------------------------------------------------------

describe("whatsapp dm contract", () => {
  it("send without --execute is a dry-run: exit 3 and NO NATS delivery", async () => {
    const commands = new WhatsAppDmCommands();
    const sensitiveMessage = "SENTINEL_DM_MESSAGE_DO_NOT_LEAK";
    const sensitivePhone = "5511777666555";
    const sensitiveJid = `${sensitivePhone}@s.whatsapp.net`;
    const sensitiveDisplayName = "SENTINEL_PRIVATE_DISPLAY_NAME";
    const error = await expectContractError(
      () => commands.send(sensitivePhone, sensitiveMessage, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      channel: "whatsapp",
      accountId: "main",
      targetType: "contact",
      targetRef: `sha256:${hashForAudit(sensitiveJid)}`,
      effect: "send-message",
      messageChars: sensitiveMessage.length,
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(sensitiveMessage);
    expect(serializedPlan).not.toContain(sensitivePhone);
    expect(serializedPlan).not.toContain(sensitiveJid);
    expect(serializedPlan).not.toContain(sensitiveDisplayName);
    expect((error.details.plan as Record<string, unknown>).text).toBeUndefined();
    expect((error.details.plan as Record<string, unknown>).to).toBeUndefined();
    expect((error.details.plan as Record<string, unknown>).displayName).toBeUndefined();
    expect(natsEmits).toHaveLength(0);
  });

  it("send with --execute emits ravi.outbound.deliver", async () => {
    const commands = new WhatsAppDmCommands();
    const payload = await silenced(() => commands.send("5511999999999", "oi\\!", undefined, true, true));

    expect(natsEmits).toHaveLength(1);
    expect(natsEmits[0]?.topic).toBe("ravi.outbound.deliver");
    expect(natsEmits[0]?.payload).toMatchObject({
      channel: "whatsapp",
      to: "5511999999999@s.whatsapp.net",
      text: "oi!",
    });
    expect(payload).toMatchObject({ status: "sent" });
  });

  it("send to an unresolvable contact exits 1 with CONTACT_NOT_FOUND and local suggestions", async () => {
    const commands = new WhatsAppDmCommands();
    const error = await expectContractError(
      () => commands.send("Joao", "oi", undefined, true, undefined),
      "CONTACT_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("Joao Silva");
    expect(natsEmits).toHaveLength(0);
  });

  it("ack without --execute is a dry-run before the receipt is emitted", async () => {
    const commands = new WhatsAppDmCommands();
    const sensitivePhone = "5511777666555";
    const sensitiveJid = `${sensitivePhone}@s.whatsapp.net`;
    const sensitiveDisplayName = "SENTINEL_PRIVATE_DISPLAY_NAME";
    const sensitiveMessageId = "SENTINEL_PRIVATE_MID";
    const error = await expectContractError(
      () => commands.ack(sensitivePhone, sensitiveMessageId, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      channel: "whatsapp",
      accountId: "main",
      targetType: "contact",
      targetRef: `sha256:${hashForAudit(sensitiveJid)}`,
      effect: "send-read-receipt",
      receiptCount: 1,
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(sensitivePhone);
    expect(serializedPlan).not.toContain(sensitiveJid);
    expect(serializedPlan).not.toContain(sensitiveDisplayName);
    expect(serializedPlan).not.toContain(sensitiveMessageId);
    expect((error.details.plan as Record<string, unknown>).messageId).toBeUndefined();
    expect(natsEmits).toHaveLength(0);
  });

  it("ack with --execute emits the read receipt", async () => {
    const commands = new WhatsAppDmCommands();
    const payload = await silenced(() => commands.ack("5511999999999", "MID1", undefined, true, true));

    expect(natsEmits).toHaveLength(1);
    expect(natsEmits[0]?.topic).toBe("ravi.outbound.receipt");
    expect(natsEmits[0]?.payload).toMatchObject({ messageIds: ["MID1"] });
    expect(payload).toMatchObject({ status: "acknowledged" });
  });

  it("read --no-ack remains a local compatibility no-op", async () => {
    const sensitiveMessageId = "SENTINEL_READ_MID";
    historyMock = [
      { role: "user", content: `[mid:${sensitiveMessageId}] oi`, created_at: "2026-01-01T10:00:00" },
      { role: "assistant", content: "olÃ¡!", created_at: "2026-01-01T10:01:00" },
    ];

    const commands = new WhatsAppDmCommands();
    const payload = await silenced(() => commands.read("5511999999999", undefined, undefined, true, undefined, true));

    expect(payload.total).toBe(2);
    expect(payload).not.toHaveProperty("ackedMessageId");
    expect(natsEmits).toHaveLength(0);
  });

  it("read --fields narrows each message to the requested fields", async () => {
    historyMock = [
      { role: "user", content: "[mid:ABC] oi", created_at: "2026-01-01T10:00:00" },
      { role: "assistant", content: "olá!", created_at: "2026-01-01T10:01:00" },
    ];

    const commands = new WhatsAppDmCommands();
    const payload = await silenced(() => commands.read("5511999999999", undefined, undefined, true, "role,content"));

    expect(payload.total).toBe(2);
    for (const message of payload.messages as unknown as Array<Record<string, unknown>>) {
      expect(Object.keys(message).sort()).toEqual(["content", "role"]);
    }
    expect(natsEmits).toHaveLength(0);
  });
});
