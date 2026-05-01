/**
 * Group Commands - WhatsApp group management
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { requestReply } from "../../utils/request-reply.js";
import { findContactsByTag, getContact, searchContacts } from "../../contacts.js";
import { dbCreateRoute, dbGetInstance, dbUpsertChat, getFirstAccountName } from "../../router/router-db.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import { buildSessionKey } from "../../router/session-key.js";
import { getOrCreateSession, updateSessionSource, updateSessionName } from "../../router/sessions.js";
import { generateSessionName, ensureUniqueName } from "../../router/session-name.js";
import { getAgent } from "../../router/config.js";
import { expandHome } from "../../router/resolver.js";

const TOPIC_PREFIX = "ravi.whatsapp.group";

/** Operations that may take longer (write operations on WhatsApp) */
const SLOW_OPS = new Set(["create", "leave", "add", "remove", "join"]);

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function resolveGroupAccount(account?: string): string {
  return account ?? getFirstAccountName() ?? "";
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

@Group({
  name: "whatsapp.group",
  description: "WhatsApp group management",
  scope: "admin",
  skillGate: "ravi-system-whatsapp-manager",
})
export class GroupCommands {
  @Command({ name: "list", description: "List all groups the bot participates in" })
  async list(
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await groupRequest<{
      groups: { id: string; subject: string; size: number; isCommunity: boolean }[];
      total: number;
    }>("list", {}, account);

    if (asJson) {
      printJson({
        accountId: resolveGroupAccount(account),
        total: result.total,
        groups: result.groups,
      });
      return result;
    }

    if (result.total === 0) {
      console.log("No groups found.");
      return result;
    }

    console.log(`\nGroups (${result.total}):\n`);
    console.log("  ID                              NAME                           SIZE");
    console.log("  ──────────────────────────────  ─────────────────────────────  ────");

    for (const g of result.groups) {
      if (g.isCommunity) continue; // Skip communities in main list
      const id = g.id.padEnd(30);
      const name = (g.subject ?? "").slice(0, 29).padEnd(29);
      const size = String(g.size ?? "?").padStart(4);
      console.log(`  ${id}  ${name}  ${size}`);
    }

    return result;
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

  @Command({ name: "create", description: "Create a new group" })
  async create(
    @Arg("name", { description: "Group name/subject" }) name: string,
    @Arg("participants", { description: "Phone numbers to add (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route this group chat to" })
    agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const participants = participantsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    if (participants.length === 0) {
      fail("At least one participant is required");
    }

    // Validate all participants exist in contacts before creating group
    validateParticipantsAreContacts(participants);

    const result = await groupRequest<{ id: string; subject: string; participants: number }>(
      "create",
      { subject: name, participants },
      account,
    );
    const jsonPayload: Record<string, unknown> = {
      status: "created",
      accountId: resolveGroupAccount(account),
      group: result,
      requestedParticipants: participants,
      changedCount: 1,
    };

    if (!asJson) {
      console.log(`✓ Group created: ${result.subject}`);
      console.log(`  ID:           ${result.id}`);
      console.log(`  Participants: ${result.participants}`);
    }

    // Promote admin-tagged contacts to group admin
    const adminContacts = findContactsByTag("admin");
    const adminPhones = adminContacts
      .flatMap((c) => c.identities.filter((i) => i.platform === "phone").map((i) => i.value))
      .filter(Boolean);

    if (adminPhones.length > 0) {
      try {
        const promotion = await groupRequest(
          "promote",
          {
            groupId: result.id,
            participants: adminPhones,
          },
          account,
        );
        jsonPayload.adminPromotion = {
          status: "promoted",
          participants: adminPhones,
          result: promotion,
          changedCount: adminPhones.length,
        };
        if (!asJson) console.log(`  Admins:       promoted ${adminPhones.length} contact(s)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        jsonPayload.adminPromotion = {
          status: "failed",
          participants: adminPhones,
          error: msg,
          changedCount: 0,
        };
        if (!asJson) console.log(`  Admins:       promote failed (${msg})`);
      }
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
    if (!asJson) console.log(`  Chat:         registered`);

    if (agent) {
      try {
        const route = dbCreateRoute({ pattern: `group:${groupId}`, agent, accountId: routeAcct, priority: 0 });
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
        jsonPayload.session = {
          status: "created",
          sessionKey,
          name: session.name ?? sessionName,
          agent,
          accountId: acctId,
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
