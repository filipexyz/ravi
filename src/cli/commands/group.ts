/**
 * Group Commands - WhatsApp group management
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { requestReply } from "../../utils/request-reply.js";
import { upsertContact } from "../../contacts.js";
import { dbCreateRoute } from "../../router/router-db.js";
import { notif } from "../../notif.js";
import { buildSessionKey } from "../../router/session-key.js";
import { getOrCreateSession, updateSessionSource } from "../../router/sessions.js";
import { getAgent } from "../../router/config.js";
import { expandHome } from "../../router/resolver.js";

const TOPIC_PREFIX = "ravi.whatsapp.group";

/** Send a group operation and wait for the result */
async function groupRequest<T = Record<string, unknown>>(
  op: string,
  data: Record<string, unknown>,
  account?: string
): Promise<T> {
  return requestReply<T>(`${TOPIC_PREFIX}.${op}`, {
    ...data,
    accountId: account ?? "default",
  });
}

@Group({
  name: "whatsapp.group",
  description: "WhatsApp group management",
})
export class GroupCommands {
  @Command({ name: "list", description: "List all groups the bot participates in" })
  async list(
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const result = await groupRequest<{ groups: { id: string; subject: string; size: number; isCommunity: boolean }[]; total: number }>(
      "list",
      {},
      account
    );

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
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const result = await groupRequest<Record<string, unknown>>("info", { groupId }, account);

    console.log(`\nGroup: ${result.subject}\n`);
    console.log(`  ID:           ${result.id}`);
    console.log(`  Owner:        ${result.owner ?? "-"}`);
    console.log(`  Size:         ${result.size}`);
    console.log(`  Created:      ${result.creation ? new Date((result.creation as number) * 1000).toLocaleString() : "-"}`);
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
    @Option({ flags: "--agent <id>", description: "Agent to route this group to (auto-approves contact)" }) agent?: string
  ) {
    const participants = participantsStr.split(",").map((p) => p.trim()).filter(Boolean);

    if (participants.length === 0) {
      fail("At least one participant is required");
    }

    const result = await groupRequest<{ id: string; subject: string; participants: number }>(
      "create",
      { subject: name, participants },
      account
    );

    console.log(`✓ Group created: ${result.subject}`);
    console.log(`  ID:           ${result.id}`);
    console.log(`  Participants: ${result.participants}`);

    // Auto-approve contact and route to agent if specified
    const groupId = result.id.replace(/@g\.us$/, "");
    const groupIdentity = `group:${groupId}`;

    // Always auto-approve groups we create ourselves
    upsertContact(groupIdentity, result.subject, "allowed");
    console.log(`  Contact:      approved`);

    if (agent) {
      try {
        dbCreateRoute({ pattern: `group:${groupId}`, agent, priority: 0 });
        console.log(`  Route:        ${agent}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Route:        failed (${msg})`);
      }

      // Natively create the session so it's ready before the first message
      const sessionKey = buildSessionKey({
        agentId: agent,
        channel: "whatsapp",
        accountId: account ?? "default",
        peerKind: "group",
        peerId: `group:${groupId}`,
      });

      const agentConfig = getAgent(agent);
      if (agentConfig) {
        const agentCwd = expandHome(agentConfig.cwd);
        const acctId = account ?? "default";

        getOrCreateSession(sessionKey, agent, agentCwd, {
          chatType: "group",
          channel: "whatsapp",
          accountId: acctId,
          groupId: `group:${groupId}`,
          subject: name,
        });
        updateSessionSource(sessionKey, {
          channel: "whatsapp",
          accountId: acctId,
          chatId: `group:${groupId}`,
        });
        console.log(`  Session:      created`);

        // Send an inform so the agent introduces itself
        const memberList = participants.join(", ");
        const inform = `[System] Inform: Você foi adicionado ao grupo WhatsApp "${name}" com os membros: ${memberList}. Se apresente brevemente.`;

        await notif.emit(`ravi.${sessionKey}.prompt`, {
          prompt: inform,
          source: {
            channel: "whatsapp",
            accountId: acctId,
            chatId: `group:${groupId}`,
          },
        });
        console.log(`  Inform:       sent`);
      } else {
        console.log(`  Session:      skipped (agent "${agent}" not found)`);
      }
    }

    return result;
  }

  @Command({ name: "add", description: "Add participants to a group" })
  async add(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("participants", { description: "Phone numbers to add (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const participants = participantsStr.split(",").map((p) => p.trim()).filter(Boolean);
    const result = await groupRequest("add", { groupId, participants }, account);
    console.log(`✓ Added ${participants.length} participant(s)`);
    return result;
  }

  @Command({ name: "remove", description: "Remove participants from a group" })
  async remove(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("participants", { description: "Phone numbers to remove (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const participants = participantsStr.split(",").map((p) => p.trim()).filter(Boolean);
    const result = await groupRequest("remove", { groupId, participants }, account);
    console.log(`✓ Removed ${participants.length} participant(s)`);
    return result;
  }

  @Command({ name: "promote", description: "Promote participants to admin" })
  async promote(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("participants", { description: "Phone numbers to promote (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const participants = participantsStr.split(",").map((p) => p.trim()).filter(Boolean);
    const result = await groupRequest("promote", { groupId, participants }, account);
    console.log(`✓ Promoted ${participants.length} participant(s) to admin`);
    return result;
  }

  @Command({ name: "demote", description: "Demote participants from admin" })
  async demote(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("participants", { description: "Phone numbers to demote (comma-separated)" }) participantsStr: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const participants = participantsStr.split(",").map((p) => p.trim()).filter(Boolean);
    const result = await groupRequest("demote", { groupId, participants }, account);
    console.log(`✓ Demoted ${participants.length} participant(s) from admin`);
    return result;
  }

  @Command({ name: "invite", description: "Get group invite link" })
  async invite(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const result = await groupRequest<{ code: string; link: string }>("invite", { groupId }, account);
    console.log(`✓ Invite link: ${result.link}`);
    return result;
  }

  @Command({ name: "revoke-invite", description: "Revoke current invite link" })
  async revokeInvite(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const result = await groupRequest<{ code: string; link: string }>("revoke-invite", { groupId }, account);
    console.log(`✓ Invite revoked. New link: ${result.link}`);
    return result;
  }

  @Command({ name: "join", description: "Join a group via invite link/code" })
  async join(
    @Arg("code", { description: "Invite code or full link" }) code: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const result = await groupRequest<{ groupId: string }>("join", { code }, account);
    console.log(`✓ Joined group: ${result.groupId}`);
    return result;
  }

  @Command({ name: "leave", description: "Leave a group" })
  async leave(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    await groupRequest("leave", { groupId }, account);
    console.log(`✓ Left group: ${groupId}`);
  }

  @Command({ name: "rename", description: "Rename a group" })
  async rename(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("name", { description: "New group name" }) name: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    await groupRequest("rename", { groupId, subject: name }, account);
    console.log(`✓ Group renamed to: ${name}`);
  }

  @Command({ name: "description", description: "Update group description" })
  async description(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("text", { description: "New description" }) text: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    await groupRequest("description", { groupId, description: text }, account);
    console.log(`✓ Description updated`);
  }

  @Command({ name: "settings", description: "Update group settings (announcement, not_announcement, locked, unlocked)" })
  async settings(
    @Arg("groupId", { description: "Group ID or JID" }) groupId: string,
    @Arg("setting", { description: "Setting: announcement, not_announcement, locked, unlocked" }) setting: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const valid = ["announcement", "not_announcement", "locked", "unlocked"];
    if (!valid.includes(setting)) {
      fail(`Invalid setting: ${setting}. Valid: ${valid.join(", ")}`);
    }

    await groupRequest("settings", { groupId, setting }, account);
    console.log(`✓ Setting applied: ${setting}`);
  }
}
