// Who a turn's Knowledge answers serve, read from the prompt before the turn
// starts (spec knowledge, contract §12.3). Advisory only: `ravi knowledge`
// rechecks every call with the turn classifier (src/knowledge/safety/turn.ts),
// so a wrong line never leaks; it only must not invite a call that will be
// refused. The rules mirror the classifier: the terminal, the operator's own
// relay, the operator's own cron routine and the owner's own message, in any
// session or group, are the operator. A turn with no chat (heartbeat,
// trigger, any other source without one) is never the operator.

import { readActorBindingForActiveLogin } from "../../cloud-auth/actor-bindings.js";
import { findContactsByTag } from "../../contacts.js";
import { readCronRunAuthority } from "../../cron/authority.js";
import { CRON_OPERATOR_OWNER } from "../../link/connector-turn.js";
import { getSessionByName } from "../../router/index.js";
import { parseSessionKey } from "../../router/session-key.js";
import { ADMIN_BOOTSTRAP_AGENT_ID } from "../../runtime/context-registry.js";
import type { MessageTarget, RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import { resolveRuntimeTurnOrigin } from "../../runtime/turn-origin.js";
import { resolvePersonCredentialCaller } from "../../runtime/person-credential.js";
import { dmContactForChat } from "../contacts.js";
import { OWNER_CONTACT_TAG } from "../owner.js";
import { isOperatorPrivateSession } from "../safety/turn.js";
import { buildContactPacket, type ContactPacket } from "../packet/packet.js";

import type { KnowledgePromptAudience } from "./preamble-text.js";

export type { KnowledgePromptAudience };

export interface KnowledgeAudienceDeps {
  /** Contacts tagged `permission-owner`. */
  ownerContactIds?: () => string[];
  /** The session key of a session name. */
  sessionKeyFor?: (sessionName: string) => string | null;
  /** The contact of a known direct chat. */
  dmContact?: (input: { chatId: string; channel: string | null }) => string | null;
  /** `cron_jobs.owner_principal`; `found: false` when the job is gone. */
  packet?: typeof buildContactPacket;
  /** Whether the owner contact is linked (`ravi link`) to the active login, as the classifier requires. */
  isLinkedOwner?: (contactId: string) => boolean;
  /** Whether a relay or owner cron runs in a session that is the operator's alone, as the classifier requires. */
  isOperatorSession?: (sessionName: string) => boolean;
  /** The person whose credential produced the prompt (runtime/person-credential), or null. */
  personCredential?: (prompt: RuntimeLaunchPrompt) => { contactId: string; usable: boolean } | null;
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
      if (!prompt._jobId || !cronIsOperators(prompt, deps)) return none;
      if (!isOperatorSession(ctx.sessionName, deps)) return none;
      return !chat || isOwnersDirectChat(prompt, chat, deps) ? operator() : none;
    }
    // A person's credential is that person speaking, never the operator's
    // terminal or relay, whatever the producer marked: only the linked owner
    // in the operator's own session reads as the operator.
    const person = (deps.personCredential ?? resolvePersonCredentialCaller)(prompt);
    if (person) {
      const owner = person.usable && ownerIds(deps).has(person.contactId) && isLinkedOwner(person.contactId, deps);
      return owner && isOperatorSession(ctx.sessionName, deps) ? operator() : none;
    }
    if (prompt._cliDestination) return isOperatorSession(ctx.sessionName, deps) ? operator() : none;

    const origin = resolveRuntimeTurnOrigin(prompt._turnOrigin);
    if (origin) {
      if (!isOperatorRelay(origin)) return none;
      if (!isOperatorSession(ctx.sessionName, deps)) return none;
      // The operator's own relay answers wherever the session posts: only
      // their own direct chat may receive it.
      return !chat || isOwnersDirectChat(prompt, chat, deps) ? operator() : none;
    }

    if (!chat) return none;
    const group = isGroupTurn(prompt, ctx.sessionName, deps);
    const contactId = contactOf(prompt, chat, deps);
    if (contactId && ownerIds(deps).has(contactId)) {
      // The owner's own message counts wherever they write: their direct chat
      // in any session, or a group (sharing there is their choice). The
      // classifier needs the owner's `ravi link` binding: without it the turn
      // is refused, so the line says so.
      return isLinkedOwner(contactId, deps) ? operator() : none;
    }
    if (group || !contactId) return none;

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

/**
 * Whether the run was admitted as the operator's, read from the run's own
 * admission snapshot (`_cronAuthority`), the same one the runtime and the
 * connector classifier use, never the job's live owner: an owner changed
 * after admission must not make the preamble invite a call the classifier
 * refuses. `operator` is the operator; so is a contact tagged as the owner.
 */
function cronIsOperators(prompt: RuntimeLaunchPrompt, deps: KnowledgeAudienceDeps): boolean {
  const authority = readCronRunAuthority(prompt._cronAuthority, prompt._jobId ?? "");
  if (!authority?.ownerIsOperator) return false;
  if (authority.ownerPrincipal === CRON_OPERATOR_OWNER) return true;
  if (!authority.ownerPrincipal.startsWith("contact:")) return false;
  return ownerIds(deps).has(authority.ownerPrincipal.slice("contact:".length));
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

function isOperatorSession(sessionName: string, deps: KnowledgeAudienceDeps): boolean {
  try {
    if (deps.isOperatorSession) return deps.isOperatorSession(sessionName);
    return isOperatorPrivateSession(sessionKey(sessionName, deps), sessionName);
  } catch {
    return false;
  }
}

function isLinkedOwner(contactId: string, deps: KnowledgeAudienceDeps): boolean {
  try {
    if (deps.isLinkedOwner) return deps.isLinkedOwner(contactId);
    return readActorBindingForActiveLogin(contactId) !== null;
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
