/**
 * WhatsApp Group Operations
 *
 * Functions that execute Baileys group methods on the socket.
 * Called by the gateway when it receives group operation events.
 */

import type { WASocket } from "@whiskeysockets/baileys";
import { phoneToJid } from "./normalize.js";
import { sessionManager } from "./session.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("wa:group-ops");

/** Resolve socket from accountId, throw if not connected or not ready */
function getSocket(accountId: string): WASocket {
  const socket = sessionManager.getSocket(accountId);
  if (!socket) {
    throw new Error(`WhatsApp account "${accountId}" not connected`);
  }

  const state = sessionManager.getState(accountId);
  if (state !== "connected") {
    throw new Error(`WhatsApp account "${accountId}" not ready (state: ${state})`);
  }

  return socket;
}


/** Convert phone/group ID to JID, throw if invalid */
function toJid(id: string): string {
  const jid = phoneToJid(id);
  if (!jid) throw new Error(`Invalid ID: ${id}`);
  return jid;
}

/** Convert participant phones to JIDs */
function participantsToJids(participants: string[]): string[] {
  return participants.map((p) => {
    const jid = phoneToJid(p);
    if (!jid) throw new Error(`Invalid participant: ${p}`);
    return jid;
  });
}

// ============================================================================
// Group Operations
// ============================================================================

export async function groupCreate(
  accountId: string,
  subject: string,
  participants: string[]
) {
  const socket = getSocket(accountId);
  const jids = participantsToJids(participants);

  log.info("Creating group", { subject, participants: jids.length });
  const metadata = await socket.groupCreate(subject, jids);
  log.info("Group created", { id: metadata.id, subject: metadata.subject });

  sessionManager.cacheGroupMetadata(metadata.id, metadata);

  return {
    id: metadata.id,
    subject: metadata.subject,
    participants: metadata.participants?.length ?? 0,
    owner: metadata.owner,
  };
}

export async function groupMetadata(accountId: string, groupId: string) {
  const socket = getSocket(accountId);
  const jid = toJid(groupId);

  const metadata = await socket.groupMetadata(jid);
  sessionManager.cacheGroupMetadata(jid, metadata);

  return {
    id: metadata.id,
    subject: metadata.subject,
    description: metadata.desc,
    owner: metadata.owner,
    creation: metadata.creation,
    size: metadata.size ?? metadata.participants?.length,
    announce: metadata.announce,
    restrict: metadata.restrict,
    ephemeral: metadata.ephemeralDuration,
    inviteCode: metadata.inviteCode,
    isCommunity: metadata.isCommunity,
    participants: metadata.participants?.map((p) => ({
      id: p.id,
      admin: p.admin ?? null,
    })),
  };
}

export async function groupList(accountId: string) {
  const socket = getSocket(accountId);

  const groups = await socket.groupFetchAllParticipating();
  const result = Object.values(groups).map((g) => ({
    id: g.id,
    subject: g.subject,
    size: g.size ?? g.participants?.length,
    isCommunity: g.isCommunity,
  }));

  return { groups: result, total: result.length };
}

export async function groupParticipantsUpdate(
  accountId: string,
  groupId: string,
  participants: string[],
  action: "add" | "remove" | "promote" | "demote"
) {
  const socket = getSocket(accountId);
  const jid = toJid(groupId);
  const jids = participantsToJids(participants);

  log.info("Updating participants", { groupId: jid, action, count: jids.length });
  const result = await socket.groupParticipantsUpdate(jid, jids, action);
  log.info("Participants updated", { groupId: jid, action, results: result.length });

  return {
    results: result.map((r) => ({
      jid: r.jid,
      status: r.status,
    })),
  };
}

export async function groupInviteCode(accountId: string, groupId: string) {
  const socket = getSocket(accountId);
  const jid = toJid(groupId);

  const code = await socket.groupInviteCode(jid);
  return {
    code,
    link: code ? `https://chat.whatsapp.com/${code}` : null,
  };
}

export async function groupRevokeInvite(accountId: string, groupId: string) {
  const socket = getSocket(accountId);
  const jid = toJid(groupId);

  const code = await socket.groupRevokeInvite(jid);
  return {
    code,
    link: code ? `https://chat.whatsapp.com/${code}` : null,
  };
}

export async function groupAcceptInvite(accountId: string, code: string) {
  const socket = getSocket(accountId);

  // Strip URL prefix if provided
  const cleanCode = code.replace("https://chat.whatsapp.com/", "");
  const groupId = await socket.groupAcceptInvite(cleanCode);

  return { groupId };
}

export async function groupLeave(accountId: string, groupId: string) {
  const socket = getSocket(accountId);
  const jid = toJid(groupId);

  await socket.groupLeave(jid);
  log.info("Left group", { groupId: jid });
  return { left: true };
}

export async function groupUpdateSubject(
  accountId: string,
  groupId: string,
  subject: string
) {
  const socket = getSocket(accountId);
  const jid = toJid(groupId);

  await socket.groupUpdateSubject(jid, subject);
  return { subject };
}

export async function groupUpdateDescription(
  accountId: string,
  groupId: string,
  description: string
) {
  const socket = getSocket(accountId);
  const jid = toJid(groupId);

  await socket.groupUpdateDescription(jid, description);
  return { description };
}

export async function groupSettingUpdate(
  accountId: string,
  groupId: string,
  setting: "announcement" | "not_announcement" | "locked" | "unlocked"
) {
  const socket = getSocket(accountId);
  const jid = toJid(groupId);

  await socket.groupSettingUpdate(jid, setting);
  return { setting };
}

// ============================================================================
// Dispatcher — routes operation name to function
// ============================================================================

export type GroupOpName =
  | "create"
  | "info"
  | "list"
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "invite"
  | "revoke-invite"
  | "join"
  | "leave"
  | "rename"
  | "description"
  | "settings";

export async function dispatchGroupOp(
  op: GroupOpName,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const accountId = (data.accountId as string) ?? "default";

  switch (op) {
    case "create":
      return groupCreate(
        accountId,
        data.subject as string,
        data.participants as string[]
      );
    case "info":
      return groupMetadata(accountId, data.groupId as string);
    case "list":
      return groupList(accountId);
    case "add":
    case "remove":
    case "promote":
    case "demote":
      return groupParticipantsUpdate(
        accountId,
        data.groupId as string,
        data.participants as string[],
        op
      );
    case "invite":
      return groupInviteCode(accountId, data.groupId as string);
    case "revoke-invite":
      return groupRevokeInvite(accountId, data.groupId as string);
    case "join":
      return groupAcceptInvite(accountId, data.code as string);
    case "leave":
      return groupLeave(accountId, data.groupId as string);
    case "rename":
      return groupUpdateSubject(
        accountId,
        data.groupId as string,
        data.subject as string
      );
    case "description":
      return groupUpdateDescription(
        accountId,
        data.groupId as string,
        data.description as string
      );
    case "settings":
      return groupSettingUpdate(
        accountId,
        data.groupId as string,
        data.setting as "announcement" | "not_announcement" | "locked" | "unlocked"
      );
    default:
      throw new Error(`Unknown group operation: ${op}`);
  }
}
