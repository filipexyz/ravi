// Who a turn's Knowledge answers serve, read from the prompt before the turn
// starts (spec knowledge, contract §12.3). Advisory only: `ravi knowledge`
// rechecks every call with the turn classifier (src/knowledge/safety/turn.ts),
// so a wrong line never leaks; it only must not invite a call that will be
// refused. The rules mirror the classifier: the terminal, the operator's own
// relay, the operator's own cron routine and the owner's own direct chat in a
// session no other contact shares are the operator. A turn with no chat
// (heartbeat, trigger, any other source without one) is never the operator.

import { findContactsByTag } from "../../contacts.js";
import { dbGetCronJob } from "../../cron/cron-db.js";
import { CRON_OPERATOR_OWNER, readIsPrivateDirectSession } from "../../link/connector-turn.js";
import type { PrivateDirectSessionInput } from "../../link/connector-turn.js";
import { getSessionByName } from "../../router/index.js";
import { parseSessionKey } from "../../router/session-key.js";
import { ADMIN_BOOTSTRAP_AGENT_ID } from "../../runtime/context-registry.js";
import type { MessageTarget, RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import { resolveRuntimeTurnOrigin } from "../../runtime/turn-origin.js";
import { dmContactForChat } from "../contacts.js";
import { OWNER_CONTACT_TAG } from "../owner.js";
import { buildContactPacket, type ContactPacket } from "../packet/packet.js";

export type KnowledgePromptAudience = "operator" | "contact" | "none";

export interface KnowledgeAudienceDeps {
  /** Contacts tagged `permission-owner`. */
  ownerContactIds?: () => string[];
  /** The session key of a session name. */
  sessionKeyFor?: (sessionName: string) => string | null;
  isPrivateDirectSession?: (input: PrivateDirectSessionInput) => boolean;
  /** The contact of a known direct chat. */
  dmContact?: (input: { chatId: string; channel: string | null }) => string | null;
  /** `cron_jobs.owner_principal`; `found: false` when the job is gone. */
  cronOwner?: (jobId: string) => { found: boolean; ownerPrincipal: string | null };
  packet?: typeof buildContactPacket;
}

export interface KnowledgeAudienceResult {
  audience: KnowledgePromptAudience;
  /** Set exactly when `audience` is `contact`. */
  packet: ContactPacket | null;
}

/** Relay actions the operator issues themselves (`ravi sessions send|ask`), as in connector-turn. */
const OPERATOR_RELAY_ACTIONS: ReadonlySet<string> = new Set(["send", "ask"]);
const OPERATOR_RELAY_PRINCIPALS: ReadonlySet<string> = new Set([
  "automation:operator:local",
  `agent:${ADMIN_BOOTSTRAP_AGENT_ID}`,
]);

export function knowledgeAudienceForPrompt(
  prompt: RuntimeLaunchPrompt,
  ctx: { agentId: string; sessionName: string },
  deps: KnowledgeAudienceDeps = {},
): KnowledgePromptAudience {
  return resolveKnowledgeAudience(prompt, ctx, deps).audience;
}

/** The audience and, for a contact, the packet built for it (built once). Never throws. */
export function resolveKnowledgeAudience(
  prompt: RuntimeLaunchPrompt,
  ctx: { agentId: string; sessionName: string },
  deps: KnowledgeAudienceDeps = {},
): KnowledgeAudienceResult {
  const none: KnowledgeAudienceResult = { audience: "none", packet: null };
  try {
    // Routines and other automations: only the operator's own cron counts.
    if (
      prompt._heartbeat ||
      prompt._trigger ||
      prompt._sessionFollowup ||
      prompt._observation ||
      prompt._taskRuntime ||
      prompt._channelBackend
    ) {
      return none;
    }
    const chat = chatOf(prompt.source);
    if (prompt._cron) {
      if (!prompt._jobId || !cronIsOperators(prompt._jobId, deps)) return none;
      return !chat || isOwnersDirectChat(prompt, chat, deps) ? operator() : none;
    }
    if (prompt._cliDestination) return operator();

    const origin = resolveRuntimeTurnOrigin(prompt._turnOrigin);
    if (origin) {
      if (!isOperatorRelay(origin)) return none;
      // The operator's own relay answers wherever the session posts: only
      // their own direct chat may receive it.
      return !chat || isOwnersDirectChat(prompt, chat, deps) ? operator() : none;
    }

    if (!chat || isGroupTurn(prompt, ctx.sessionName, deps)) return none;
    const contactId = contactOf(prompt, chat, deps);
    if (!contactId) return none;

    if (ownerIds(deps).has(contactId)) {
      return isPrivateSession(ctx.sessionName, contactId, chat.chatId, deps) ? operator() : none;
    }

    const packet = (deps.packet ?? buildContactPacket)({
      agentId: ctx.agentId,
      sessionName: ctx.sessionName,
      source: prompt.source,
      messageText: prompt.prompt,
    });
    return packet ? { audience: "contact", packet } : none;
  } catch {
    return none;
  }
}

function operator(): KnowledgeAudienceResult {
  return { audience: "operator", packet: null };
}

function chatOf(source: MessageTarget | undefined): { chatId: string; channel: string } | null {
  const chatId = source?.chatId?.trim();
  const channel = source?.channel?.trim();
  return chatId && channel ? { chatId, channel } : null;
}

function isOperatorRelay(origin: NonNullable<ReturnType<typeof resolveRuntimeTurnOrigin>>): boolean {
  if (origin.producer !== "session-relay") return false;
  if (!OPERATOR_RELAY_ACTIONS.has(origin.action)) return false;
  // A relay sent from another session is that session's agent asking.
  if (origin.session) return false;
  return OPERATOR_RELAY_PRINCIPALS.has(`${origin.principal.type}:${origin.principal.id}`);
}

/** Legacy NULL and `operator` are the operator; so is a contact tagged as the owner. */
function cronIsOperators(jobId: string, deps: KnowledgeAudienceDeps): boolean {
  const job = (deps.cronOwner ?? readCronOwner)(jobId);
  if (!job.found) return false;
  if (job.ownerPrincipal === null || job.ownerPrincipal === CRON_OPERATOR_OWNER) return true;
  if (!job.ownerPrincipal.startsWith("contact:")) return false;
  return ownerIds(deps).has(job.ownerPrincipal.slice("contact:".length));
}

function readCronOwner(jobId: string): { found: boolean; ownerPrincipal: string | null } {
  const job = dbGetCronJob(jobId);
  return job ? { found: true, ownerPrincipal: job.ownerPrincipal ?? null } : { found: false, ownerPrincipal: null };
}

/** Group turns: the inbound context says so, else the session key does. Unknown counts as a group. */
function isGroupTurn(prompt: RuntimeLaunchPrompt, sessionName: string, deps: KnowledgeAudienceDeps): boolean {
  if (prompt.context?.isGroup === true) return true;
  const key = sessionKey(sessionName, deps);
  const parsed = key ? parseSessionKey(key) : null;
  if (parsed?.peerKind === "group" || parsed?.peerKind === "channel") return true;
  if (prompt.context?.isGroup === false) return false;
  return !(parsed?.peerKind === "dm" || parsed?.dmScope === "main");
}

function contactOf(
  prompt: RuntimeLaunchPrompt,
  chat: { chatId: string; channel: string },
  deps: KnowledgeAudienceDeps,
): string | null {
  const explicit = prompt.source?.contactId?.trim() || prompt.context?.contactId?.trim();
  if (explicit) return explicit;
  return (deps.dmContact ?? dmContactForChat)({ chatId: chat.chatId, channel: chat.channel });
}

function isOwnersDirectChat(
  prompt: RuntimeLaunchPrompt,
  chat: { chatId: string; channel: string },
  deps: KnowledgeAudienceDeps,
): boolean {
  if (prompt.context?.isGroup === true) return false;
  const contactId = (deps.dmContact ?? dmContactForChat)({ chatId: chat.chatId, channel: chat.channel });
  return Boolean(contactId && ownerIds(deps).has(contactId));
}

function isPrivateSession(
  sessionName: string,
  contactId: string,
  chatId: string,
  deps: KnowledgeAudienceDeps,
): boolean {
  const input: PrivateDirectSessionInput = {
    sessionKey: sessionKey(sessionName, deps),
    sessionName,
    contactId,
    chatId,
  };
  try {
    return (deps.isPrivateDirectSession ?? readIsPrivateDirectSession)(input);
  } catch {
    return false;
  }
}

function ownerIds(deps: KnowledgeAudienceDeps): Set<string> {
  return new Set((deps.ownerContactIds ?? defaultOwnerContactIds)());
}

function defaultOwnerContactIds(): string[] {
  return findContactsByTag(OWNER_CONTACT_TAG).map((contact) => contact.id);
}

function sessionKey(sessionName: string, deps: KnowledgeAudienceDeps): string | null {
  if (deps.sessionKeyFor) return deps.sessionKeyFor(sessionName);
  return getSessionByName(sessionName)?.sessionKey ?? null;
}
