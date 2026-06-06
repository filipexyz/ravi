/**
 * Group Commands - WhatsApp group management
 */

import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { Group, Command, Arg, Option, Scope } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { requestReply } from "../../utils/request-reply.js";
import { findContactsByTag, getContact, getContactById, normalizePhone, searchContacts } from "../../contacts.js";
import {
  dbBindSessionToChat,
  dbCreateRoute,
  dbGetInstance,
  dbUpsertChat,
  dbUpsertChatParticipant,
  getFirstAccountName,
} from "../../router/router-db.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import { resolveOmniGroupMetadata } from "../../omni/group-metadata-cache.js";
import { prepareOmniMentionMessage } from "../../omni/mentions.js";
import { OmniSender } from "../../omni/sender.js";
import { createOmniClient } from "../../omni/client.js";
import { resolveOmniConnection } from "../../omni-config.js";
import { buildSessionKey } from "../../router/session-key.js";
import {
  attachChatToSession,
  getOrCreateSession,
  updateSessionSource,
  updateSessionName,
} from "../../router/sessions.js";
import { generateSessionName, ensureUniqueName } from "../../router/session-name.js";
import { createAgent, getAgent } from "../../router/config.js";
import { expandHome } from "../../router/resolver.js";
import { ensureAgentInstructionFiles } from "../../runtime/agent-instructions.js";
import { nats } from "../../nats.js";

const TOPIC_PREFIX = "ravi.whatsapp.group";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operations that may take longer (write operations on WhatsApp) */
const SLOW_OPS = new Set(["create", "leave", "add", "remove", "join"]);

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

function resolveGroupAccount(account?: string): string {
  return account ?? getFirstAccountName() ?? "";
}

function resolveGroupSendAccount(account?: string): string {
  return account ?? getContext()?.source?.accountId ?? getFirstAccountName() ?? "";
}

function normalizeGroupJid(groupId: string): string {
  const trimmed = groupId.trim();
  if (trimmed.startsWith("group:")) return `${trimmed.slice("group:".length)}@g.us`;
  if (trimmed.includes("@")) return trimmed;
  return `${trimmed}@g.us`;
}

function resolveGroupSendChatId(groupId: string): string {
  const trimmed = groupId.trim();
  if (trimmed === "." || trimmed === "here" || trimmed === "current") {
    const chatId = getContext()?.source?.chatId;
    if (!chatId) fail("No current chat context available. Pass a group ID or JID.");
    return chatId;
  }
  return trimmed;
}

function resolveGroupSendInstanceId(accountId: string): string | null {
  const instance = dbGetInstance(accountId);
  return instance?.instanceId ?? (UUID_RE.test(accountId) ? accountId : null);
}

function parseMentionTargets(value: string | string[] | undefined): string[] {
  return parseCsvValues(value);
}

function parseCsvValues(...values: Array<string | string[] | undefined>): string[] {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanCliText(value: string): string {
  return value.replace(/\\([!#$&*?])/g, "$1");
}

function uniquePhones(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const normalized = normalizePhone(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isGroupParticipantIdentity(value: string): boolean {
  return /^\d+$/.test(value) || value.startsWith("lid:");
}

function collectContactPhoneRefs(contact: ReturnType<typeof getContact> | ReturnType<typeof getContactById>): string[] {
  if (!contact) return [];
  return [
    contact.phone,
    ...contact.identities.filter((identity) => identity.platform === "phone").map((identity) => identity.value),
  ].filter(Boolean);
}

function inferActorAdminPhones(): string[] {
  const context = getContext();
  const env = process.env;
  const refs: string[] = [];
  const contactIds: string[] = [];
  const pushRef = (value: unknown) => {
    const ref = asNonEmptyString(value);
    if (ref) refs.push(ref);
  };
  const pushContactId = (value: unknown) => {
    const contactId = asNonEmptyString(value);
    if (contactId) contactIds.push(contactId);
  };

  const metadata = asRecord(context?.context?.metadata);
  const records = [
    metadata,
    asRecord(metadata?.actor),
    asRecord(metadata?.actorMetadata),
    asRecord(metadata?.source),
    asRecord(context?.source),
  ].filter((record): record is Record<string, unknown> => Boolean(record));

  for (const record of records) {
    pushRef(record.senderPhone);
    pushRef(record.phone);
    pushRef(record.contactPhone);
    pushRef(record.senderId);
    pushRef(record.rawSenderId);
    pushRef(record.normalizedSenderId);
    pushRef(record.platformUserId);
    pushRef(record.normalizedPlatformUserId);
    pushContactId(record.contactId);
  }

  pushContactId(env.RAVI_CONTACT_ID);
  pushRef(env.RAVI_SENDER_PHONE);
  pushRef(env.RAVI_SENDER_ID);
  pushRef(env.RAVI_NORMALIZED_SENDER_ID);
  pushRef(env.RAVI_RAW_SENDER_ID);

  const resolved: string[] = [];
  for (const contactId of uniqueStrings(contactIds)) {
    resolved.push(...collectContactPhoneRefs(getContactById(contactId)));
  }

  for (const ref of refs) {
    const normalized = normalizePhone(ref);
    if (!normalized || normalized.startsWith("group:")) continue;
    const contact = getContact(normalized) ?? getContact(ref);
    const contactRefs = collectContactPhoneRefs(contact);
    resolved.push(...(contactRefs.length > 0 ? contactRefs : [normalized]));
  }

  return uniquePhones(resolved).filter(isGroupParticipantIdentity);
}

function defaultAgentCwd(agentId: string): string {
  return `${homedir()}/ravi/${agentId}`;
}

function ensureGroupAgent(input: { agentId: string; createIfMissing?: boolean; cwd?: string; provider?: string }): {
  status: "existing" | "created";
  agentId: string;
  cwd: string;
  provider?: string;
} {
  const existing = getAgent(input.agentId);
  if (existing) {
    return {
      status: "existing",
      agentId: existing.id,
      cwd: expandHome(existing.cwd),
      ...(existing.provider ? { provider: existing.provider } : {}),
    };
  }

  if (!input.createIfMissing) {
    fail(`Agent not found: ${input.agentId}. Pass --create-agent to create it before routing the group.`);
  }

  const cwd = expandHome(input.cwd?.trim() || defaultAgentCwd(input.agentId));
  mkdirSync(cwd, { recursive: true });
  const created = createAgent({
    id: input.agentId,
    cwd,
    ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
  });
  ensureAgentInstructionFiles(cwd, {
    createAgentsStub: `# ${input.agentId}\n\nInstruções do agente aqui.\n`,
  });
  return {
    status: "created",
    agentId: created.id,
    cwd,
    ...(created.provider ? { provider: created.provider } : {}),
  };
}

function upsertGroupChatParticipants(input: {
  chatId: string;
  participants: string[];
  admins: string[];
  agent?: string;
  source: string;
}): { contacts: number; admins: number; agent: boolean } {
  const adminSet = new Set(input.admins.map((phone) => normalizePhone(phone)));
  let contacts = 0;
  let admins = 0;

  for (const phone of input.participants) {
    const normalized = normalizePhone(phone);
    const contact = getContact(normalized);
    if (!contact) continue;
    const role = adminSet.has(normalized) ? "admin" : "member";
    dbUpsertChatParticipant({
      chatId: input.chatId,
      contactId: contact.id,
      rawPlatformUserId: phone,
      normalizedPlatformUserId: normalized,
      role,
      status: "active",
      source: "manual",
      metadata: { source: input.source },
    });
    contacts += 1;
    if (role === "admin") admins += 1;
  }

  if (input.agent) {
    dbUpsertChatParticipant({
      chatId: input.chatId,
      agentId: input.agent,
      role: "agent",
      status: "active",
      source: "manual",
      metadata: { source: input.source },
    });
  }

  return { contacts, admins, agent: Boolean(input.agent) };
}

/**
 * Validate that all phone numbers exist in contacts.
 * Fails with suggestions if any number is unknown.
 */
function validateParticipantsAreContacts(participants: string[]): void {
  const unknown: string[] = [];
  for (const phone of participants) {
    const contact = getContact(phone);
    if (!contact) {
      unknown.push(phone);
    }
  }

  if (unknown.length > 0) {
    console.error(`\n✗ Participant(s) not found in contacts:\n`);
    for (const phone of unknown) {
      console.error(`  - ${phone}`);
      // Try fuzzy search with last digits
      const lastDigits = phone.slice(-4);
      const suggestions = searchContacts(lastDigits)
        .filter((c) => c.identities.some((i) => i.platform === "phone"))
        .slice(0, 3);
      if (suggestions.length > 0) {
        console.error(`    Did you mean?`);
        for (const s of suggestions) {
          const phoneId = s.identities.find((i) => i.platform === "phone");
          console.error(`      ${s.name ?? "(sem nome)"} — ${phoneId?.value ?? s.phone}`);
        }
      }
    }
    console.error(`\nOnly known contacts can be added to groups.`);
    console.error(`Use 'ravi contacts list' to see all contacts.\n`);
    fail("Unknown participant(s). Verify phone numbers against contacts.");
  }
}

/** Send a group operation and wait for the result */
async function groupRequest<T = Record<string, unknown>>(
  op: string,
  data: Record<string, unknown>,
  account?: string,
): Promise<T> {
  const timeout = SLOW_OPS.has(op) ? 45000 : 15000;
  const acctName = resolveGroupAccount(account);
  return requestReply<T>(
    `${TOPIC_PREFIX}.${op}`,
    {
      ...data,
      accountId: acctName,
    },
    timeout,
  );
}

function resolveGroupInstance(account?: string): { accountId: string; instanceId: string } {
  const accountId = resolveGroupAccount(account);
  if (!accountId) fail("No WhatsApp account configured.");

  const instance = dbGetInstance(accountId);
  const instanceId = instance?.instanceId ?? (UUID_RE.test(accountId) ? accountId : "");
  if (!instanceId) fail(`No omni instance mapped for account "${accountId}".`);

  return { accountId, instanceId };
}

async function createGroupViaOmni(input: {
  subject: string;
  participants: string[];
  account?: string;
}): Promise<{ id: string; subject: string; participants: number; raw: Record<string, unknown> }> {
  const connection = resolveOmniConnection();
  if (!connection) fail("Omni API is not configured. Set OMNI_API_URL/OMNI_API_KEY or ~/.omni/config.json.");

  const { instanceId } = resolveGroupInstance(input.account);
  const client = createOmniClient({ baseUrl: connection.apiUrl, apiKey: connection.apiKey });
  const raw = await client.instances.createGroup(instanceId, {
    subject: input.subject,
    participants: input.participants,
  });
  const id = asNonEmptyString(raw.id) ?? asNonEmptyString(raw.externalId);
  if (!id) fail("Omni group create returned no group id.");

  return {
    id,
    subject: asNonEmptyString(raw.subject) ?? asNonEmptyString(raw.name) ?? input.subject,
    participants: Array.isArray(raw.participants) ? raw.participants.length : input.participants.length,
    raw: raw as Record<string, unknown>,
  };
}

@Group({
  name: "whatsapp.group",
  description: "WhatsApp group management",
  scope: "admin",
})
export class GroupCommands {
  @Command({ name: "list", description: "List all groups the bot participates in" })
  async list(
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching groups to skip (default: 0)" }) offset?: string,
  ) {
    const result = await groupRequest<{
      groups: { id: string; subject: string; size: number; isCommunity: boolean }[];
      total: number;
    }>("list", {}, account);
    const groups = result.groups.filter((group) => !group.isCommunity);
    const page = paginateCliItems(groups, { limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "whatsapp", "group", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--account", account],
    });
    const payload = {
      accountId: resolveGroupAccount(account),
      total: page.total,
      pagination,
      items: page.items,
      groups: page.items,
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (page.items.length === 0) {
      console.log("No groups found.");
      return payload;
    }

    console.log(
      `\nGroups (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):\n`,
    );
    console.log("  ID                              NAME                           SIZE");
    console.log("  ──────────────────────────────  ─────────────────────────────  ────");

    for (const g of page.items) {
      const id = g.id.padEnd(30);
      const name = (g.subject ?? "").slice(0, 29).padEnd(29);
      const size = String(g.size ?? "?").padStart(4);
      console.log(`  ${id}  ${name}  ${size}`);
    }
    if (pagination.nextCommand) {
      console.log("\nNext page:");
      console.log(`  ${pagination.nextCommand}`);
    }

    return payload;
  }

  @Command({ name: "info", description: "Show group metadata" })
  async info(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await groupRequest<Record<string, unknown>>("info", { groupId }, account);

    if (asJson) {
      printJson({
        accountId: resolveGroupAccount(account),
        groupId,
        group: result,
      });
      return result;
    }

    console.log(`\nGroup: ${result.subject}\n`);
    console.log(`  ID:           ${result.id}`);
    console.log(`  Owner:        ${result.owner ?? "-"}`);
    console.log(`  Size:         ${result.size}`);
    console.log(
      `  Created:      ${result.creation ? new Date((result.creation as number) * 1000).toLocaleString() : "-"}`,
    );
    console.log(`  Announce:     ${result.announce ? "yes (admins only)" : "no"}`);
    console.log(`  Restrict:     ${result.restrict ? "yes (locked)" : "no"}`);

    if (result.description) {
      console.log(`  Description:  ${(result.description as string).slice(0, 80)}`);
    }

    if (result.ephemeral) {
      const hours = (result.ephemeral as number) / 3600;
      console.log(`  Ephemeral:    ${hours}h`);
    }

    const participants = result.participants as { id: string; admin: string | null }[] | undefined;
    if (participants) {
      const admins = participants.filter((p) => p.admin);
      const members = participants.filter((p) => !p.admin);
      console.log(`\n  Admins (${admins.length}):`);
      for (const a of admins) {
        console.log(`    ${a.id} [${a.admin}]`);
      }
      console.log(`  Members (${members.length}):`);
      for (const m of members.slice(0, 20)) {
        console.log(`    ${m.id}`);
      }
      if (members.length > 20) {
        console.log(`    ... and ${members.length - 20} more`);
      }
    }

    return result;
  }

  @Command({ name: "send", description: "Send a message to a WhatsApp group" })
  @Scope("open")
  async send(
    @Arg("groupId", { description: "Group ID, JID, or 'here' for the current chat" }) groupId: string,
    @Arg("message", { description: "Message text" }) message: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({
      flags: "--mention <target...>",
      description: "Mention group participant by name, phone, LID, or JID. Can be repeated or comma-separated.",
    })
    mentionTargetsRaw?: string[] | string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const accountId = resolveGroupSendAccount(account);
    if (!accountId) fail("No WhatsApp account configured.");

    const instanceId = resolveGroupSendInstanceId(accountId);
    if (!instanceId) fail(`No omni instance mapped for account "${accountId}".`);

    const connection = resolveOmniConnection();
    if (!connection) fail("Omni API is not configured. Set OMNI_API_URL/OMNI_API_KEY or ~/.omni/config.json.");

    const rawGroupId = resolveGroupSendChatId(groupId);
    const groupJid = normalizeGroupJid(rawGroupId);
    const cleanMessage = cleanCliText(message);
    const mentionTargets = parseMentionTargets(mentionTargetsRaw);
    const shouldResolveParticipants = mentionTargets.length > 0 || cleanMessage.includes("@");
    const metadata = shouldResolveParticipants
      ? await resolveOmniGroupMetadata({
          omniApiUrl: connection.apiUrl,
          omniApiKey: connection.apiKey,
          accountId,
          instanceId,
          chatId: groupJid,
          channel: "whatsapp",
        })
      : null;

    const prepared = prepareOmniMentionMessage({
      text: cleanMessage,
      explicitTargets: mentionTargets,
      participants: metadata?.participants,
    });

    const sender = new OmniSender(connection.apiUrl, connection.apiKey);
    const result = await sender.send(instanceId, groupJid, prepared.text, { mentions: prepared.mentions });
    const payload = {
      status: "sent" as const,
      channel: "whatsapp" as const,
      accountId,
      instanceId,
      groupId: rawGroupId,
      to: groupJid,
      text: prepared.text,
      mentionCount: prepared.mentions.length,
      mentions: prepared.mentions,
      resolvedMentions: prepared.resolved,
      messageId: result.messageId,
      changedCount: 1,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Message sent to ${groupJid}`);
      if (prepared.resolved.length > 0) {
        console.log(
          `  Mentions:     ${prepared.resolved.map((mention) => mention.displayName ?? mention.id).join(", ")}`,
        );
      }
    }

    return payload;
  }

  @Command({ name: "create", description: "Create a new group" })
  async create(
    @Arg("name", { description: "Group name/subject" }) name: string,
    @Arg("participants", { description: "Phone numbers to add (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route this group chat to" })
    agent?: string,
    @Option({ flags: "--create-agent", description: "Create --agent first when it does not exist" })
    createAgentIfMissing?: boolean,
    @Option({ flags: "--agent-cwd <path>", description: "CWD for --create-agent (default: ~/ravi/<agent>)" })
    agentCwd?: string,
    @Option({ flags: "--agent-provider <provider>", description: "Runtime provider id for --create-agent" })
    agentProvider?: string,
    @Option({
      flags: "--admin <phones...>",
      description: "Phone numbers to add and promote as group admins. Can be repeated or comma-separated.",
    })
    adminPhonesRaw?: string[] | string,
    @Option({ flags: "--admins <phones...>", description: "Alias for --admin" })
    adminsAliasRaw?: string[] | string,
    @Option({ flags: "--skip-tagged-admins", description: "Do not auto-promote contacts tagged admin" })
    skipTaggedAdmins?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const requestedParticipants = uniquePhones(parseCsvValues(participantsStr));
    const explicitAdmins = uniquePhones(parseCsvValues(adminPhonesRaw, adminsAliasRaw));
    const actorAdmins = inferActorAdminPhones();
    const participants = uniquePhones([...requestedParticipants, ...actorAdmins, ...explicitAdmins]);

    if (participants.length === 0) {
      fail("At least one participant is required");
    }

    if (!agent && createAgentIfMissing) {
      fail("--create-agent requires --agent <id>");
    }

    // Validate all participants exist in contacts before creating group
    validateParticipantsAreContacts(participants);

    const preparedAgent = agent
      ? ensureGroupAgent({
          agentId: agent,
          createIfMissing: createAgentIfMissing,
          cwd: agentCwd,
          provider: agentProvider,
        })
      : null;

    const result = await createGroupViaOmni({ subject: name, participants, account });
    const jsonPayload: Record<string, unknown> = {
      status: "created",
      accountId: resolveGroupAccount(account),
      group: result,
      requestedParticipants,
      participants,
      requestedAdmins: explicitAdmins,
      actorAdmins,
      changedCount: 1,
    };
    if (preparedAgent) {
      jsonPayload.agent = preparedAgent;
    }

    if (!asJson) {
      console.log(`✓ Group created: ${result.subject}`);
      console.log(`  ID:           ${result.id}`);
      console.log(`  Participants: ${result.participants}`);
      if (preparedAgent?.status === "created") {
        console.log(`  Agent:        created ${preparedAgent.agentId} (${preparedAgent.cwd})`);
      } else if (preparedAgent) {
        console.log(`  Agent:        existing ${preparedAgent.agentId}`);
      }
    }

    // Promote admin-tagged contacts to group admin
    const taggedAdminPhones = skipTaggedAdmins
      ? []
      : findContactsByTag("admin")
          .flatMap((c) => c.identities.filter((i) => i.platform === "phone").map((i) => i.value))
          .filter(Boolean);
    const adminPhones = uniquePhones([...actorAdmins, ...explicitAdmins, ...taggedAdminPhones]);
    const confirmedAdminPhones: string[] = [];

    if (adminPhones.length > 0) {
      jsonPayload.adminPromotion = {
        status: "skipped",
        reason: "omni_group_admin_promotion_not_supported",
        participants: adminPhones,
        actorAdmins,
        explicitAdmins,
        taggedAdmins: uniquePhones(taggedAdminPhones),
        changedCount: 0,
      };
      if (!asJson) console.log(`  Admins:       skipped (not exposed by Omni API)`);
    }

    // Register chat and route to agent if specified.
    const groupId = result.id.replace(/@g\.us$/, "");
    const groupIdentity = `group:${groupId}`;
    const routeAcct = resolveGroupAccount(account);
    const instance = routeAcct ? dbGetInstance(routeAcct) : null;

    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: instance?.instanceId ?? routeAcct,
      platformChatId: result.id,
      chatType: "group",
      title: result.subject ?? null,
      rawProvenance: {
        source: "whatsapp.group.create",
        accountId: routeAcct,
        groupId: result.id,
      },
    });
    jsonPayload.chat = { status: "registered", identity: groupIdentity, chat };
    jsonPayload.chatParticipants = upsertGroupChatParticipants({
      chatId: chat.id,
      participants,
      admins: confirmedAdminPhones,
      agent,
      source: "whatsapp.group.create",
    });
    if (!asJson) console.log(`  Chat:         registered`);

    if (agent) {
      try {
        const route = dbCreateRoute({
          pattern: `group:${groupId}`,
          agent,
          accountId: routeAcct,
          priority: 0,
          channel: "whatsapp",
        });
        jsonPayload.route = { status: "created", route };
        if (!asJson) console.log(`  Route:        ${agent}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        jsonPayload.route = { status: "failed", agent, accountId: routeAcct, error: msg };
        if (!asJson) console.log(`  Route:        failed (${msg})`);
      }

      // Natively create the session so it's ready before the first message
      const sessionKey = buildSessionKey({
        agentId: agent,
        channel: "whatsapp",
        accountId: routeAcct,
        peerKind: "group",
        peerId: `group:${groupId}`,
      });

      const agentConfig = getAgent(agent);
      if (agentConfig) {
        const agentCwd = expandHome(agentConfig.cwd);
        const acctId = routeAcct;

        // Generate a human-readable session name
        const baseName = generateSessionName(agent, { groupName: name });
        const sessionName = ensureUniqueName(baseName);

        const session = getOrCreateSession(sessionKey, agent, agentCwd, {
          name: sessionName,
          chatType: "group",
          channel: "whatsapp",
          accountId: acctId,
          groupId: `group:${groupId}`,
          subject: name,
        });
        if (!session.name) {
          updateSessionName(sessionKey, sessionName);
        }
        updateSessionSource(sessionKey, {
          channel: "whatsapp",
          accountId: acctId,
          chatId: `group:${groupId}`,
        });
        dbBindSessionToChat({
          sessionKey,
          chatId: chat.id,
          agentId: agent,
          bindingReason: "whatsapp.group.create",
        });
        const attachment = attachChatToSession({
          sessionKey,
          chatId: chat.id,
          role: "primary",
          attachedByType: "system",
          attachedReason: "whatsapp.group.create",
          setOutputTarget: true,
          speechMode: "speak",
        });
        jsonPayload.session = {
          status: "created",
          sessionKey,
          name: session.name ?? sessionName,
          agent,
          accountId: acctId,
          chatBinding: { chatId: chat.id },
          attachment,
        };
        if (!asJson) console.log(`  Session:      ${session.name ?? sessionName}`);

        // Send an inform so the agent introduces itself
        const memberList = participants.join(", ");
        const inform = `[System] Inform: Você foi adicionado ao grupo WhatsApp "${name}" com os membros: ${memberList}. Se apresente brevemente.`;

        await publishSessionPrompt(session.name ?? sessionName, {
          prompt: inform,
          source: {
            channel: "whatsapp",
            accountId: acctId,
            chatId: `group:${groupId}`,
          },
        });
        jsonPayload.inform = { status: "sent", sessionName: session.name ?? sessionName };
        if (!asJson) console.log(`  Inform:       sent`);
      } else {
        jsonPayload.session = { status: "skipped", reason: `agent "${agent}" not found`, agent };
        if (!asJson) console.log(`  Session:      skipped (agent "${agent}" not found)`);
      }

      emitConfigChanged();
    }

    if (asJson) {
      printJson(jsonPayload);
    }

    return result;
  }

  @Command({ name: "add", description: "Add participants to a group" })
  async add(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("participants", { description: "Phone numbers to add (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const participants = participantsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    // Validate all participants exist in contacts before adding
    validateParticipantsAreContacts(participants);

    const result = await groupRequest("add", { groupId, participants }, account);
    if (asJson) {
      printJson({
        status: "added",
        accountId: resolveGroupAccount(account),
        groupId,
        participants,
        result,
        changedCount: participants.length,
      });
      return result;
    }
    console.log(`✓ Added ${participants.length} participant(s)`);
    return result;
  }

  @Command({ name: "remove", description: "Remove participants from a group" })
  async remove(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("participants", { description: "Phone numbers to remove (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const participants = participantsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const result = await groupRequest("remove", { groupId, participants }, account);
    if (asJson) {
      printJson({
        status: "removed",
        accountId: resolveGroupAccount(account),
        groupId,
        participants,
        result,
        changedCount: participants.length,
      });
      return result;
    }
    console.log(`✓ Removed ${participants.length} participant(s)`);
    return result;
  }

  @Command({ name: "promote", description: "Promote participants to admin" })
  async promote(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("participants", { description: "Phone numbers to promote (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const participants = participantsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const result = await groupRequest("promote", { groupId, participants }, account);
    if (asJson) {
      printJson({
        status: "promoted",
        accountId: resolveGroupAccount(account),
        groupId,
        participants,
        result,
        changedCount: participants.length,
      });
      return result;
    }
    console.log(`✓ Promoted ${participants.length} participant(s) to admin`);
    return result;
  }

  @Command({ name: "demote", description: "Demote participants from admin" })
  async demote(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("participants", { description: "Phone numbers to demote (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const participants = participantsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const result = await groupRequest("demote", { groupId, participants }, account);
    if (asJson) {
      printJson({
        status: "demoted",
        accountId: resolveGroupAccount(account),
        groupId,
        participants,
        result,
        changedCount: participants.length,
      });
      return result;
    }
    console.log(`✓ Demoted ${participants.length} participant(s) from admin`);
    return result;
  }

  @Command({ name: "invite", description: "Get group invite link" })
  async invite(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await groupRequest<{ code: string; link: string }>("invite", { groupId }, account);
    if (asJson) {
      printJson({
        status: "invite_link",
        accountId: resolveGroupAccount(account),
        groupId,
        invite: result,
      });
      return result;
    }
    console.log(`✓ Invite link: ${result.link}`);
    return result;
  }

  @Command({ name: "revoke-invite", description: "Revoke current invite link" })
  async revokeInvite(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await groupRequest<{ code: string; link: string }>("revoke-invite", { groupId }, account);
    if (asJson) {
      printJson({
        status: "invite_revoked",
        accountId: resolveGroupAccount(account),
        groupId,
        invite: result,
        changedCount: 1,
      });
      return result;
    }
    console.log(`✓ Invite revoked. New link: ${result.link}`);
    return result;
  }

  @Command({ name: "join", description: "Join a group via invite link/code" })
  async join(
    @Arg("code", { description: "Invite code or full link" }) code: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await groupRequest<{ groupId: string }>("join", { code }, account);
    if (asJson) {
      printJson({
        status: "joined",
        accountId: resolveGroupAccount(account),
        code,
        groupId: result.groupId,
        result,
        changedCount: 1,
      });
      return result;
    }
    console.log(`✓ Joined group: ${result.groupId}`);
    return result;
  }

  @Command({ name: "leave", description: "Leave a group" })
  async leave(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await groupRequest("leave", { groupId }, account);
    const payload = {
      status: "left",
      accountId: resolveGroupAccount(account),
      groupId,
      result,
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`✓ Left group: ${groupId}`);
    return payload;
  }

  @Command({ name: "rename", description: "Rename a group" })
  async rename(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("name", { description: "New group name" }) name: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await groupRequest("rename", { groupId, subject: name }, account);
    const payload = {
      status: "renamed",
      accountId: resolveGroupAccount(account),
      groupId,
      subject: name,
      result,
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`✓ Group renamed to: ${name}`);
    return payload;
  }

  @Command({ name: "description", description: "Update group description" })
  async description(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("text", { description: "New description" }) text: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await groupRequest("description", { groupId, description: text }, account);
    const payload = {
      status: "description_updated",
      accountId: resolveGroupAccount(account),
      groupId,
      description: text,
      result,
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`✓ Description updated`);
    return payload;
  }

  @Command({
    name: "settings",
    description: "Update group settings (announcement, not_announcement, locked, unlocked)",
  })
  async settings(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("setting", { description: "Setting: announcement, not_announcement, locked, unlocked" }) setting: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const valid = ["announcement", "not_announcement", "locked", "unlocked"];
    if (!valid.includes(setting)) {
      fail(`Invalid setting: ${setting}. Valid: ${valid.join(", ")}`);
    }

    const result = await groupRequest("settings", { groupId, setting }, account);
    const payload = {
      status: "setting_applied",
      accountId: resolveGroupAccount(account),
      groupId,
      setting,
      result,
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`✓ Setting applied: ${setting}`);
    return payload;
  }
}
