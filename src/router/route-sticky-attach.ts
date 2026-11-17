/**
 * Route-agent migration vs sessions/attach.
 *
 * Inbound bookkeeping (`attachedByType: system`, reason `inbound-route` and
 * the other automatic binders) pins a chat to the session that first handled
 * it. The consumer then prefers that subscription over `matchRoute`. Changing
 * the route agent must release those pins so the next inbound follows the new
 * agent. Operator `sessions attach` (`user`) and agent-created attaches stay.
 */

import { getContact, getContactById, type Contact } from "../contacts.js";
import { canonicalizeRouteIdentity } from "../utils/phone.js";
import { loadRouterConfig } from "./config.js";
import { matchPattern, matchRoute } from "./resolver.js";
import {
  dbGetChat,
  dbGetInstance,
  dbListActiveSubscriptionChatIds,
  type AttachedByType,
  type ChatRecord,
} from "./router-db.js";
import {
  detachChatFromSession,
  findSessionByAttachedChat,
  getSession,
  isChatCompatibleWithSession,
  listSessionSubscriptions,
} from "./sessions.js";
import type { SessionEntry } from "./types.js";

export interface RouteStickyOverride {
  chatId: string;
  platformChatId: string;
  sessionKey: string;
  sessionName?: string;
  agentId: string;
  attachedByType: AttachedByType;
  attachedReason?: string;
  explicit: boolean;
  detachCommand: string;
}

export interface DetachRouteBookkeepingResult {
  detached: number;
  preserved: RouteStickyOverride[];
}

interface StickyCandidate {
  chat: ChatRecord;
  session: SessionEntry | null;
  sessionKey: string;
  attachedByType: AttachedByType;
  attachedReason?: string;
  explicit: boolean;
  compatible: boolean;
  /** Live route agent for an identity of this chat that matches the pattern. */
  liveAgentId: string | null;
  /** True when at least one pattern-matching identity now resolves to `targetAgent`. */
  releasesForTarget: boolean;
}

export function isExplicitSessionAttach(attachedByType: AttachedByType): boolean {
  return attachedByType === "user" || attachedByType === "agent";
}

export function sessionHasExplicitAttach(sessionKey: string): boolean {
  return listSessionSubscriptions(sessionKey).some((subscription) =>
    isExplicitSessionAttach(subscription.attachedByType),
  );
}

function normalizeChannel(channel?: string | null): string | undefined {
  const cleaned = channel
    ?.trim()
    .toLowerCase()
    .replace(/-baileys$/, "");
  return cleaned || undefined;
}

function contactForCanonicalDm(normalizedChatId: string): Contact | null {
  if (!normalizedChatId.startsWith("contact:")) return null;
  const contactId = normalizedChatId.slice("contact:".length).trim();
  if (!contactId) return null;
  return getContact(contactId) ?? getContactById(contactId);
}

function addIdentity(values: Set<string>, raw: string | null | undefined): void {
  if (!raw?.trim()) return;
  const canonical = canonicalizeRouteIdentity(raw);
  if (canonical) values.add(canonical);
}

/** Route identities a chat can be reached by (platform id, plus contact phone/LID). */
export function chatRouteIdentities(chat: ChatRecord): string[] {
  const values = new Set<string>();
  addIdentity(values, chat.platformChatId);
  if (chat.normalizedChatId.startsWith("contact:")) {
    const contact = contactForCanonicalDm(chat.normalizedChatId);
    if (contact) {
      addIdentity(values, contact.phone);
      for (const identity of contact.identities) addIdentity(values, identity.value);
    }
  } else {
    addIdentity(values, chat.normalizedChatId);
  }
  // Native channels (Slack) store the bare channel id, while their routes
  // match `group:<id>`; without this a route change never released them.
  const platformChatId = chat.platformChatId.trim();
  if (
    (chat.chatType === "group" || chat.chatType === "channel" || chat.chatType === "room") &&
    platformChatId &&
    !platformChatId.includes("@") &&
    !platformChatId.includes("#") &&
    !platformChatId.toLowerCase().startsWith("group:")
  ) {
    addIdentity(values, `group:${platformChatId}`);
  }
  return [...values];
}

function matchParams(
  identity: string,
  accountId: string,
  channel?: string,
): { phone: string; accountId: string; channel?: string; isGroup?: boolean; groupId?: string } {
  if (identity.startsWith("group:")) {
    const groupId = identity.slice("group:".length);
    return {
      phone: groupId,
      groupId,
      isGroup: true,
      accountId,
      ...(channel ? { channel } : {}),
    };
  }
  return {
    phone: identity,
    accountId,
    ...(channel ? { channel } : {}),
  };
}

function liveAgentForIdentity(
  identity: string,
  accountId: string,
  channel: string | undefined,
  config: ReturnType<typeof loadRouterConfig>,
): string | null {
  try {
    return matchRoute(config, matchParams(identity, accountId, channel))?.agentId ?? null;
  } catch {
    return null;
  }
}

function toOverride(candidate: StickyCandidate): RouteStickyOverride {
  const sessionRef = candidate.session?.name ?? candidate.sessionKey;
  return {
    chatId: candidate.chat.id,
    platformChatId: candidate.chat.platformChatId,
    sessionKey: candidate.sessionKey,
    ...(candidate.session?.name ? { sessionName: candidate.session.name } : {}),
    agentId: candidate.session?.agentId ?? "",
    attachedByType: candidate.attachedByType,
    ...(candidate.attachedReason ? { attachedReason: candidate.attachedReason } : {}),
    explicit: candidate.explicit,
    detachCommand: `ravi sessions detach ${sessionRef} --chat ${candidate.chat.id}`,
  };
}

function collectStickyCandidates(input: {
  accountId: string;
  pattern: string;
  channel?: string;
  targetAgent?: string;
}): StickyCandidate[] {
  const instance = dbGetInstance(input.accountId);
  if (!instance) return [];
  const pattern = canonicalizeRouteIdentity(input.pattern);
  if (!pattern) return [];
  const channel = normalizeChannel(input.channel);
  const chatIds = dbListActiveSubscriptionChatIds([instance.instanceId ?? "", instance.name]);
  const config = loadRouterConfig();
  const candidates: StickyCandidate[] = [];
  for (const chatId of chatIds) {
    const chat = dbGetChat(chatId);
    const subscription = findSessionByAttachedChat(chatId);
    if (!chat || !subscription) continue;
    if (channel && normalizeChannel(chat.channel) !== channel) continue;
    const identities = chatRouteIdentities(chat).filter((identity) => matchPattern(identity, pattern));
    if (identities.length === 0) continue;
    const probe = identities.find((identity) => identity.toLowerCase() === pattern.toLowerCase()) ?? identities[0];
    if (!probe) continue;
    const session = getSession(subscription.sessionKey);
    const liveAgents = identities.map((identity) => liveAgentForIdentity(identity, input.accountId, channel, config));
    candidates.push({
      chat,
      session,
      sessionKey: subscription.sessionKey,
      attachedByType: subscription.attachedByType,
      attachedReason: subscription.attachedReason,
      explicit: isExplicitSessionAttach(subscription.attachedByType),
      compatible: isChatCompatibleWithSession(chat.id, subscription.sessionKey),
      liveAgentId: liveAgents[identities.indexOf(probe)] ?? null,
      releasesForTarget: input.targetAgent ? liveAgents.some((agentId) => agentId === input.targetAgent) : false,
    });
  }
  return candidates;
}

/**
 * Active subscriptions that would still send inbound to a different agent
 * than the live route for this pattern.
 */
export function listRouteStickyOverrides(input: {
  accountId: string;
  pattern: string;
  channel?: string;
}): RouteStickyOverride[] {
  return collectStickyCandidates(input)
    .filter(
      (candidate) =>
        candidate.session &&
        candidate.compatible &&
        candidate.liveAgentId &&
        candidate.session.agentId !== candidate.liveAgentId,
    )
    .map(toOverride);
}

/**
 * Detach automatic route subscriptions for chats this pattern now sends to
 * `targetAgent`. Explicit `sessions attach` rows are left in place.
 */
export function detachRouteBookkeepingSubscriptions(input: {
  accountId: string;
  pattern: string;
  targetAgent: string;
  channel?: string;
}): DetachRouteBookkeepingResult {
  let detached = 0;
  const preserved: RouteStickyOverride[] = [];
  for (const candidate of collectStickyCandidates(input)) {
    if (!candidate.releasesForTarget) continue;
    if (!candidate.compatible) continue;
    if (candidate.session && candidate.session.agentId === input.targetAgent) continue;
    if (candidate.explicit) {
      if (candidate.session && candidate.liveAgentId && candidate.session.agentId !== candidate.liveAgentId) {
        preserved.push(toOverride(candidate));
      }
      continue;
    }
    const result = detachChatFromSession(candidate.sessionKey, candidate.chat.id, candidate.session?.name);
    if (result.detached) detached += 1;
  }
  return { detached, preserved };
}
