/**
 * Who is asking, for connector calls.
 *
 * A personal connection serves only its owner's own requests ("Only when I
 * ask"): the terminal, the owner's own direct chat (linked by `ravi link`, in
 * a session of its own) and routines the owner owns, and only where no one
 * else reads the answer. Every connector call classifies the current turn
 * first and fails closed on anything else, so another person's message never
 * reaches the operator's Console session. The "dono" permission tag is not
 * identity: only the Console user bound to the speaking contact is.
 *
 * The same classification builds the `X-Ravi-Exec-Context` header sent on
 * exec. The Worker cannot verify that header; it trusts the daemon holding
 * the operator session, which is why this side must never send an allowed
 * header for a turn it would block.
 *
 * An agent whose mode is not `owner` (`connector-mode.ts`) answers some of
 * those turns with an account that is not the operator's, through
 * `POST /cli/agent-exec` (`resolveConnectorExecRoute`): the Worker then
 * decides from its own records (the `ravi link` binding, the person's
 * consent, the shared grant), never from what this side says about who the
 * person is.
 */

import { createHash } from "node:crypto";

import { getContext } from "../cli/context.js";
import { consoleIdentityFromBinding, readCachedActorBinding } from "../cloud-auth/actor-bindings.js";
import { CloudAuthError, type CloudAuthErrorCode } from "../cloud-auth/errors.js";
import { readActiveCloudAuthUserId, readCloudCredentials } from "../cloud-auth/storage.js";
import { dbGetCronJob } from "../cron/cron-db.js";
import {
  dbGetAgent,
  dbGetContext,
  dbGetSessionOutputAttachment,
  dbListChatParticipants,
  dbListChatsByRef,
  dbListRoutesBySessionName,
  dbListSessionChatSubscriptions,
  type ContextRecord,
} from "../router/router-db.js";
import { parseSessionKey } from "../router/session-key.js";
import {
  ADMIN_BOOTSTRAP_AGENT_ID,
  ADMIN_BOOTSTRAP_KIND,
  RAVI_CONTEXT_KEY_ENV,
  resolveRuntimeContext,
} from "../runtime/context-registry.js";
import { RAVI_AUTOMATION_PRINCIPAL_ENV, readSpawnedAutomationPrincipal } from "../runtime/turn-origin.js";
import { readTurnReplyTarget } from "../runtime/turn-reply-target.js";
import { connectorModeArg, readAgentConnectorMode, type ConnectorUseMode } from "./connector-mode.js";

export type ConnectorSpeakerKind = "terminal" | "owner" | "contact" | "agent" | "automation";
export type ConnectorConversation = "terminal" | "dm" | "group" | "automation";

export interface ConnectorRoutine {
  kind: "cron" | "heartbeat" | "trigger";
  id?: string;
}

export interface ConnectorTurn {
  speaker: { kind: ConnectorSpeakerKind; contactId?: string; consoleUserId?: string };
  conversation: ConnectorConversation;
  routine?: ConnectorRoutine;
  agentId?: string;
  sessionName?: string;
  /** sha256 hex of the turn context id that carries the actor. */
  turnKey?: string;
  /** `terminal` outside any runtime, else the turn's `actorPrincipal`. */
  actorPrincipal: string;
  /** The agent's display name, shown on the consent page (agent exec only). */
  agentDisplayName?: string;
  /**
   * A resolved contact's direct chat (candidates only): where the turn runs,
   * so `person_asking` can check that the session is this person's alone.
   * Never sent to Link.
   */
  directChat?: { chatId: string; sessionKey: string | null };
}

export type ConnectorTurnResult =
  | { ok: true; turn: ConnectorTurn }
  | {
      ok: false;
      error: CloudAuthError;
      actorPrincipal: string;
      /** The speaker is the owner, blocked only by where the answer would go (a group). */
      speakerIsOwner?: boolean;
      /**
       * The owner in their own direct chat, refused only because other
       * people's chats share its session (and so its transcript).
       */
      sharedSession?: boolean;
      /**
       * The operator's own relay (`ravi sessions send|ask`), refused only for
       * where the session posts its answer (a chat that is not the owner's
       * direct chat, or one Ravi could not read): the relay turn, with that
       * conversation when the chat is known.
       */
      relay?: ConnectorTurn;
      /**
       * The turn as it is, when only the owner's own accounts are refused
       * here: a resolved contact (or the owner) in a direct chat or a group,
       * or an allowed routine answering into a chat other than the owner's.
       * An agent in `person_asking` or `shared` mode may still answer it
       * through agent exec.
       */
      candidate?: ConnectorTurn;
    };

type BlockedTurn = Extract<ConnectorTurnResult, { ok: false }>;

/** The runtime context of the call: absent (terminal), or present and resolved or not. */
export interface ConnectorRuntimeContext {
  present: boolean;
  record: ContextRecord | null;
  /**
   * `automation:<kind>:<id>` of a process the daemon spawned for an
   * automation (shell cron, shell trigger, job), which has no runtime context.
   */
  spawnedPrincipal?: string | null;
}

/** Console identity of a contact, from the local `ravi link` binding cache. */
export interface ContactConsoleIdentity {
  consoleUserId?: string;
  consoleOrgId?: string;
}

export interface ConnectorTurnDeps {
  env?: NodeJS.ProcessEnv;
  runtimeContext?: ConnectorRuntimeContext;
  getContextById?: (contextId: string) => ContextRecord | null;
  /** Console user of the active `ravi login` session. */
  activeUserId?: string | null;
  activeOrgId?: string | null;
  /** Name used in chat lines ("I can't use <owner>'s Gmail ..."). */
  ownerName?: string | null;
  getCronJobOwner?: (jobId: string) => { found: boolean; ownerPrincipal: string | null };
  /** The contact a direct chat is with, or null when the chat is not a known direct chat. */
  getDmChatContact?: (input: { chatId: string; channel: string | null }) => string | null;
  getContactBinding?: (contactId: string) => ContactConsoleIdentity | null;
  /** An agent's mode for a provider (default: the settings table). */
  getAgentMode?: (agentId: string, provider: string) => ConnectorUseMode;
  /** An agent's display name (default: the agents table). */
  getAgentDisplayName?: (agentId: string) => string | null;
  /**
   * Whether a contact's direct-chat session holds only that person's
   * conversation (default: the router tables, `readIsPrivateDirectSession`).
   */
  isPrivateDirectSession?: (input: PrivateDirectSessionInput) => boolean;
  /** Service named in chat lines. */
  service?: string;
  now?: number;
}

export interface PrivateDirectSessionInput {
  /** The session of the turn; null when unknown or when the turn's contexts disagree. */
  sessionKey: string | null;
  sessionName: string | null;
  contactId: string;
  /** The direct chat the message came from (its compartment id). */
  chatId: string;
}

/** Cron owner value meaning "the operator" (also what a legacy NULL means). */
export const CRON_OPERATOR_OWNER = "operator";

const MAX_LINEAGE_DEPTH = 32;
/** Env that only runtimes and daemon-spawned processes carry: never the terminal. */
const RUNTIME_ENV_MARKERS = [
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_TRIGGER_ID",
  RAVI_AUTOMATION_PRINCIPAL_ENV,
] as const;
/** Session-relay actions that mean the operator asked something directly. */
const OPERATOR_RELAY_ACTIONS = new Set(["send", "ask"]);

/**
 * Classify the current turn for a connector call. Throws a CloudAuthError
 * (exit 3) when the turn may not use the operator's personal connections.
 */
export function classifyConnectorTurn(deps: ConnectorTurnDeps = {}): ConnectorTurn {
  const result = resolveConnectorTurn(deps);
  if (!result.ok) throw result.error;
  return result.turn;
}

export function resolveConnectorTurn(deps: ConnectorTurnDeps = {}): ConnectorTurnResult {
  const env = deps.env ?? process.env;
  const runtime = deps.runtimeContext ?? currentConnectorRuntimeContext(env);

  if (!runtime.present) return terminalTurn();
  const owner = resolveOwner(deps, env);
  if (runtime.spawnedPrincipal) {
    return classifyNonContactPrincipal(runtime.spawnedPrincipal, {}, owner, deps, null);
  }
  if (!runtime.record) {
    return notOwner("unknown", unknownTurnMessage(owner));
  }

  const getById = deps.getContextById ?? dbGetContext;
  const now = deps.now ?? Date.now();
  const lineage = findActorContext(runtime.record, getById, now);
  if (lineage.kind === "operator") return terminalTurn();
  if (lineage.kind === "ended") return notOwner("unknown", endedTurnMessage(owner));
  if (lineage.kind === "none") return notOwner("unknown", unknownTurnMessage(owner));
  const actorContext = lineage.context;

  const metadata = actorContext.metadata ?? {};
  const actorPrincipal = stringField(metadata, "actorPrincipal") ?? "unknown";
  const projectionSourceId = readProjectionSourceId(metadata);
  const projectionSource = projectionSourceId ? getById(projectionSourceId) : null;
  if (projectionSourceId && (!projectionSource || !isContextLive(projectionSource, now))) {
    return notOwner(actorPrincipal, endedTurnMessage(owner));
  }
  const compartment =
    stringField(metadata, "agentIdentityCompartment") ??
    stringField(projectionSource?.metadata, "agentIdentityCompartment");
  const separatorIndex = compartment ? compartment.indexOf(":") : -1;
  const surface =
    compartment && separatorIndex > 0
      ? { type: compartment.slice(0, separatorIndex), id: compartment.slice(separatorIndex + 1) }
      : null;
  const base = {
    agentId:
      stringField(metadata, "executorAgentId") ??
      actorContext.agentId ??
      runtime.record.agentId ??
      stringField(projectionSource?.metadata, "executorAgentId") ??
      undefined,
    sessionName: actorContext.sessionName ?? runtime.record.sessionName ?? undefined,
    turnKey: sha256Hex(projectionSourceId ?? actorContext.contextId),
  };

  const separator = actorPrincipal.indexOf(":");
  const principalType = separator > 0 ? actorPrincipal.slice(0, separator) : actorPrincipal;
  const principalId = separator > 0 ? actorPrincipal.slice(separator + 1) : "";

  if (principalType === "contact" && principalId) {
    const consoleUserId = stringField(metadata, "consoleUserId");
    const resolved = stringField(metadata, "actorResolution") === "resolved";
    const isOwner = resolved && isOwnerUser(owner, consoleUserId, stringField(metadata, "consoleOrgId"));
    const conversation = surface?.type === "chat" ? "group" : surface?.type === "dm" ? "dm" : null;
    // Who this person is to the Console is never part of it: the Worker
    // reads it from its own `ravi link` binding.
    const candidate: ConnectorTurn | undefined =
      resolved && conversation
        ? {
            ...base,
            actorPrincipal,
            speaker: { kind: isOwner ? "owner" : "contact", contactId: principalId },
            conversation,
            ...(conversation === "dm" && surface?.id
              ? {
                  directChat: {
                    chatId: surface.id,
                    sessionKey: sameSessionKey(actorContext.sessionKey, runtime.record.sessionKey),
                  },
                }
              : {}),
          }
        : undefined;
    if (surface?.type === "chat") {
      return withCandidate(
        isOwner
          ? groupBlockedForOwner(actorPrincipal, owner)
          : notOwnerContact(actorPrincipal, owner, false, "CONNECTOR_GROUP_BLOCKED"),
        candidate,
      );
    }
    if (!isOwner) {
      return withCandidate(notOwnerContact(actorPrincipal, owner, !consoleUserId), candidate);
    }
    if (surface?.type !== "dm") {
      return { ...notOwner(actorPrincipal, unknownTurnMessage(owner)), speakerIsOwner: true };
    }
    // The owner's own chat, but in a session other people's chats share,
    // what the account returns stays in a transcript they can ask about.
    if (!candidate || !isPrivateDirectChat(candidate, deps)) {
      return withCandidate(ownerSharedSessionBlocked(actorPrincipal, owner), candidate);
    }
    return {
      ok: true,
      turn: {
        ...base,
        actorPrincipal,
        speaker: { kind: "owner", contactId: principalId, ...(consoleUserId ? { consoleUserId } : {}) },
        conversation: "dm",
      },
    };
  }

  const verdict = classifyNonContactPrincipal(actorPrincipal, base, owner, deps, metadata);
  if (!verdict.ok) return verdict;
  const answer = resolveAnswerChat(surface, metadata, verdict.turn, {
    sessionKey: sameSessionKey(actorContext.sessionKey, runtime.record.sessionKey),
  });
  // The operator relay is the owner's own request: only where the answer
  // goes can block it.
  const relay = verdict.turn.speaker.kind === "owner";
  if (answer.kind === "unknown") return relayAnswerUnknown(actorPrincipal, owner, verdict.turn);
  if (answer.kind === "none") return verdict;
  // A routine or an operator relay answering into a chat: only the owner's
  // own direct chat may receive what the operator's accounts return.
  if (!surfaceIsOwnersDirectChat(answer.chatId, answer.channel, owner, deps)) {
    const group =
      answer.group ?? !(deps.getDmChatContact ?? readDmChatContact)({ chatId: answer.chatId, channel: answer.channel });
    const candidate: ConnectorTurn = { ...verdict.turn, conversation: group ? "group" : "dm" };
    return withCandidate(groupBlockedForAutomation(actorPrincipal, owner, relay ? candidate : undefined), candidate);
  }
  return { ok: true, turn: { ...verdict.turn, conversation: "dm" } };
}

type AnswerChat =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "chat"; chatId: string; channel: string | null; group?: boolean };

/**
 * The chat an allowed relay or routine answers into. A `chat:`/`dm:`
 * compartment names it. A relay's prompt carries no chat, so its compartment
 * does not: the reply target the runtime recorded when the turn started
 * decides (none: back to the waiting terminal), and a target still unresolved
 * then is the session's output attachment, if any. A relay whose target
 * cannot be read fails closed. Routines take their chat from the session, so
 * their compartment already names it; a recorded chat still counts.
 */
function resolveAnswerChat(
  surface: { type: string; id: string } | null,
  metadata: Record<string, unknown>,
  turn: ConnectorTurn,
  input: { sessionKey: string | null },
): AnswerChat {
  if (surface && (surface.type === "chat" || surface.type === "dm")) {
    return { kind: "chat", chatId: surface.id, channel: readActorChannel(metadata), group: surface.type === "chat" };
  }
  const recorded = readTurnReplyTarget(metadata);
  if (recorded?.kind === "chat") {
    return { kind: "chat", chatId: recorded.canonicalChatId ?? recorded.chatId, channel: recorded.channel };
  }
  if (turn.speaker.kind !== "owner" || recorded?.kind === "none") return { kind: "none" };
  if (!recorded || !input.sessionKey) return { kind: "unknown" };
  try {
    const attached = dbGetSessionOutputAttachment(input.sessionKey);
    return attached ? { kind: "chat", chatId: attached.chatId, channel: null } : { kind: "none" };
  } catch {
    return { kind: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Per-agent mode: whose account answers the turn
// ---------------------------------------------------------------------------

/**
 * Where a connector exec goes. `owner`: the operator's own connection,
 * `POST /cli/exec/:id`. `person_asking` and `shared`: `POST /cli/agent-exec`,
 * where the Worker picks the connection.
 */
export interface ConnectorExecRoute {
  mode: ConnectorUseMode;
  turn: ConnectorTurn;
}

export type ConnectorExecRouteResult = { ok: true; route: ConnectorExecRoute } | BlockedTurn;

export interface ConnectorExecRouteDeps extends ConnectorTurnDeps {
  provider: string;
  /** The owner asks for the agent's shared account on their own turn (`--shared`). */
  useShared?: boolean;
}

/**
 * Classify the turn, then apply the executing agent's mode for the provider:
 *
 * - Every turn the owner table allows (the terminal, the owner's own relay
 *   and direct chat, routines the owner owns) is the owner's own request and
 *   keeps the owner's connection in every mode. Only `useShared` (`--shared`,
 *   in a chat) sends one of them to the shared account.
 * - `owner` (default): nothing else.
 * - `person_asking`: a resolved contact who is not the owner, in a direct
 *   chat whose session is theirs alone, uses their own account through agent
 *   exec (linked or not: the Worker answers `connector_not_linked`). Groups,
 *   and direct chats that share a session with other people, stay blocked.
 * - `shared`: a contact's turn (direct chat or group) and a routine answering
 *   into a chat that is not the owner's go to the shared account with their
 *   real conversation; the Worker decides by the grant's conversations.
 *
 * Turns blocked for any other reason (agents relaying, triggers, unknown or
 * ended turns) stay blocked in every mode.
 */
export function resolveConnectorExecRoute(deps: ConnectorExecRouteDeps): ConnectorExecRouteResult {
  const result = resolveConnectorTurn(deps);
  const turn = result.ok ? result.turn : result.candidate;
  if (!turn) return result as BlockedTurn;
  const agentId = turn.agentId;
  const mode: ConnectorUseMode = agentId
    ? (deps.getAgentMode ?? readAgentConnectorMode)(agentId, deps.provider)
    : "owner";
  const ownTurn = turn.speaker.kind === "terminal" || turn.speaker.kind === "owner";

  if (deps.useShared) {
    // The owner's own choice: never a way to unblock anyone else's turn
    // (in `shared` mode theirs goes to the shared account anyway).
    if (!result.ok && !ownTurn) return mode === "shared" ? agentRoute("shared", turn, deps) : result;
    if (mode !== "shared") return sharedNotSet(turn, mode, deps);
    // A grant only lists chats (`dm`, `group`): the terminal, a relay or a
    // routine that posts nowhere would always be refused.
    if (turn.conversation !== "dm" && turn.conversation !== "group") return sharedNeedsChat(turn, deps);
    return agentRoute("shared", turn, deps);
  }
  if (result.ok) return ownerRoute(result.turn);
  if (mode === "shared" && !ownTurn) return agentRoute("shared", turn, deps);
  if (mode === "person_asking" && turn.speaker.kind === "contact") {
    const owner = resolveOwner(deps, deps.env ?? process.env);
    if (turn.conversation !== "dm") return personAskingGroupBlocked(turn.actorPrincipal, owner);
    if (!isPrivateDirectChat(turn, deps)) return personAskingSharedSessionBlocked(turn, owner);
    return agentRoute("person_asking", turn, deps);
  }
  return result;
}

function isPrivateDirectChat(turn: ConnectorTurn, deps: ConnectorTurnDeps): boolean {
  const contactId = turn.speaker.contactId;
  if (!turn.directChat || !contactId) return false;
  const input: PrivateDirectSessionInput = {
    sessionKey: turn.directChat.sessionKey,
    sessionName: turn.sessionName ?? null,
    contactId,
    chatId: turn.directChat.chatId,
  };
  try {
    return (deps.isPrivateDirectSession ?? readIsPrivateDirectSession)(input);
  } catch {
    return false;
  }
}

/**
 * Whether a contact's direct chat runs in a session of its own, so what
 * their account returns stays in a transcript only they read: a direct-chat
 * session key per person (never `dmScope: main`), no route that sends chats
 * into it by name, and every chat attached to it (inbound routing attaches
 * each chat it sends there) is this person's own direct chat. Anything
 * unknown is not private.
 */
export function readIsPrivateDirectSession(input: PrivateDirectSessionInput): boolean {
  const { sessionKey, sessionName, contactId, chatId } = input;
  if (!sessionKey || !sessionName) return false;
  const parsed = parseSessionKey(sessionKey);
  if (!parsed || parsed.peerKind !== "dm" || parsed.dmScope === "main" || !parsed.peerId) return false;
  try {
    if (dbListRoutesBySessionName(sessionName).length > 0) return false;
    for (const subscription of dbListSessionChatSubscriptions(sessionKey)) {
      if (subscription.chatId === chatId) continue;
      if (readDmChatContact({ chatId: subscription.chatId, channel: null }) !== contactId) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ownerRoute(turn: ConnectorTurn): ConnectorExecRouteResult {
  return { ok: true, route: { mode: "owner", turn } };
}

function agentRoute(mode: "person_asking" | "shared", turn: ConnectorTurn, deps: ConnectorTurnDeps) {
  const agentDisplayName = turn.agentId ? readAgentDisplayName(turn.agentId, deps) : null;
  return {
    ok: true as const,
    route: { mode, turn: { ...turn, ...(agentDisplayName ? { agentDisplayName } : {}) } },
  };
}

function readAgentDisplayName(agentId: string, deps: ConnectorTurnDeps): string | null {
  try {
    const name = deps.getAgentDisplayName ? deps.getAgentDisplayName(agentId) : dbGetAgent(agentId)?.name;
    const clean = cleanString(name);
    return clean && clean.length <= 120 ? clean : null;
  } catch {
    return null;
  }
}

/** `--shared` on a turn whose agent has no shared account: a usage error, nothing was called. */
function sharedNotSet(turn: ConnectorTurn, mode: ConnectorUseMode, deps: ConnectorExecRouteDeps): BlockedTurn {
  // Kept short: usage copy is cut at 200 characters on its way out.
  const message = turn.agentId
    ? `--shared needs agent ${turn.agentId} in shared mode for ${deps.provider} (now: ${connectorModeArg(mode)}). Drop --shared, or run: ravi connectors mode ${turn.agentId} ${deps.provider} shared --execute`
    : "--shared works only in a chat with an agent in shared mode (it uses that agent's shared account). Drop it to use your own account.";
  return usageBlocked(turn, message);
}

/** `--shared` outside a chat (the terminal, a relay, a routine that posts nowhere): no grant lists those. */
function sharedNeedsChat(turn: ConnectorTurn, deps: ConnectorExecRouteDeps): BlockedTurn {
  return usageBlocked(
    turn,
    `--shared works only in a chat: your direct chat with agent ${turn.agentId ?? "the agent"}, or a group its shared ${deps.provider} account covers. Drop it to use your own account.`,
  );
}

function usageBlocked(turn: ConnectorTurn, message: string): BlockedTurn {
  return {
    ok: false,
    actorPrincipal: turn.actorPrincipal,
    error: new CloudAuthError("PAYLOAD_INVALID", message, { details: { source: "connector-turn" } }),
  };
}

/**
 * A direct chat whose session other people also write in (`dmScope: main`,
 * a route that sends several chats to one session, an attached chat): the
 * person's mail would stay in a transcript the others can ask about.
 */
function personAskingSharedSessionBlocked(turn: ConnectorTurn, owner: OwnerIdentity): BlockedTurn {
  const chatLine = `I can't use your ${owner.service} in this conversation.`;
  const chatLinePt = `Não posso usar o seu ${owner.service} nesta conversa.`;
  return blocked(
    "CONNECTOR_GROUP_BLOCKED",
    turn.actorPrincipal,
    `This agent uses the ${owner.service} of the person asking, but this direct chat shares its session with other people (dmScope main, a route that sends several chats to one session, or an attached chat), so they could read what it returns. Do not retry. Reply: "${chatLine}" ${owner.label} can give each person their own session (dmScope per-peer) to allow it.`,
    { chatLine, chatLinePt, replyTo: "same_chat" },
  );
}

function personAskingGroupBlocked(actorPrincipal: string, owner: OwnerIdentity): BlockedTurn {
  const chatLine = `I can only use your ${owner.service} in a direct chat with me. Ask me there.`;
  const chatLinePt = `Só posso usar o seu ${owner.service} numa conversa direta comigo. Me peça por lá.`;
  return blocked(
    "CONNECTOR_GROUP_BLOCKED",
    actorPrincipal,
    `This agent uses the ${owner.service} of the person asking, but never in a group chat, where other people would read the answer. Reply in the group: "${chatLine}"`,
    { chatLine, chatLinePt, replyTo: "same_chat" },
  );
}

/**
 * The operator's own turn (the terminal, the owner's own linked direct chat,
 * also in a shared session, or the owner's own `ravi sessions send|ask`,
 * wherever the session posts its answer), for changes to how an agent uses
 * connected accounts. Contacts, routines and agents never pass, in any mode.
 */
export function resolveOperatorTurn(deps: ConnectorTurnDeps & { action: string }): ConnectorTurnResult {
  const result = resolveConnectorTurn(deps);
  if (result.ok && (result.turn.speaker.kind === "terminal" || result.turn.speaker.kind === "owner")) return result;
  // The owner's own direct chat in a shared session: changing a mode returns
  // nothing from an account, so the transcript is no reason to refuse it.
  if (!result.ok && result.sharedSession && result.candidate?.speaker.kind === "owner") {
    return { ok: true, turn: result.candidate };
  }
  // The operator's own relay, whatever chat the session posts into: the
  // same, and the operator is the one asking, not the people in that chat.
  if (!result.ok && result.relay?.speaker.kind === "owner") return { ok: true, turn: result.relay };
  const owner = resolveOwner(deps, deps.env ?? process.env);
  if (!result.ok && (result.speakerIsOwner || result.candidate?.speaker.kind === "owner")) {
    // The owner, only in the wrong place (a group): send them to their own chat.
    const chatLine = "Ask me in our private chat and I'll change it.";
    const chatLinePt = "Me peça no nosso chat privado que eu mudo.";
    return blocked(
      result.error.code === "CONNECTOR_GROUP_BLOCKED" ? "CONNECTOR_GROUP_BLOCKED" : "CONNECTOR_SPEAKER_NOT_OWNER",
      result.actorPrincipal,
      `${owner.label} asked outside their own direct chat with you. Only ${owner.label} can ${deps.action}, and only from their terminal or that direct chat, so nothing changes from this turn. Reply: "${chatLine}"`,
      { chatLine, chatLinePt, replyTo: "same_chat" },
    );
  }
  const chatLine = `Only ${owner.label} can change that.`;
  const chatLinePt = `Só ${owner.namePt} pode mudar isso.`;
  return blocked(
    "CONNECTOR_SPEAKER_NOT_OWNER",
    result.ok ? result.turn.actorPrincipal : result.actorPrincipal,
    `Only ${owner.label} can ${deps.action}, from their terminal or their own direct chat with you. Do not retry from this turn. Reply: "${chatLine}"`,
    { chatLine, chatLinePt, replyTo: "same_chat" },
  );
}

/**
 * Turns without a contact actor: operator relays, routines, other automations
 * and agents. `metadata` is the actor context's metadata, or null for a
 * daemon-spawned automation process.
 */
function classifyNonContactPrincipal(
  actorPrincipal: string,
  base: Pick<ConnectorTurn, "agentId" | "sessionName" | "turnKey">,
  owner: OwnerIdentity,
  deps: ConnectorTurnDeps,
  metadata: Record<string, unknown> | null,
): ConnectorTurnResult {
  const separator = actorPrincipal.indexOf(":");
  const principalType = separator > 0 ? actorPrincipal.slice(0, separator) : actorPrincipal;
  const principalId = separator > 0 ? actorPrincipal.slice(separator + 1) : "";

  const operatorRelay =
    (principalType === "automation" && principalId === "operator:local") ||
    (principalType === "agent" && principalId === ADMIN_BOOTSTRAP_AGENT_ID);
  if (operatorRelay) {
    if (!isOperatorRelay(actorPrincipal, metadata)) {
      return notOwner(
        actorPrincipal,
        `This turn was not started by a direct request from ${owner.label} (it may come from a runtime goal or a session execute), so it cannot use ${owner.label}'s connected accounts.`,
      );
    }
    return { ok: true, turn: { ...base, actorPrincipal, speaker: { kind: "owner" }, conversation: "terminal" } };
  }

  if (principalType === "automation") {
    if (principalId === "heartbeat") {
      return {
        ok: true,
        turn: {
          ...base,
          actorPrincipal,
          speaker: { kind: "automation" },
          conversation: "automation",
          routine: { kind: "heartbeat" },
        },
      };
    }
    if (principalId.startsWith("cron:") && principalId.length > "cron:".length) {
      const jobId = principalId.slice("cron:".length);
      const job = (deps.getCronJobOwner ?? readCronJobOwner)(jobId);
      if (!job.found) {
        return notOwner(
          actorPrincipal,
          `Cron job ${jobId} no longer exists, so Ravi cannot tell who owns this routine and will not use ${owner.label}'s connected accounts.`,
        );
      }
      if (!cronOwnerIsOperator(job.ownerPrincipal, owner, deps)) {
        return notOwner(
          actorPrincipal,
          `Cron job ${jobId} was created by ${job.ownerPrincipal}, not by ${owner.label}, so it cannot use ${owner.label}'s connected accounts.`,
        );
      }
      return {
        ok: true,
        turn: {
          ...base,
          actorPrincipal,
          speaker: { kind: "automation" },
          conversation: "automation",
          routine: { kind: "cron", id: jobId },
        },
      };
    }
    return notOwner(
      actorPrincipal,
      `This turn was started by ${actorPrincipal}, not by ${owner.label}. Personal connections serve only ${owner.label}'s own requests: the terminal, their own direct chat, and routines they created.`,
    );
  }

  if (principalType === "agent" && principalId) {
    return notOwner(
      actorPrincipal,
      `This request was relayed by agent ${principalId}, not made by ${owner.label}. Personal connections serve only ${owner.label}'s own requests. Tell the session that asked that you cannot use ${owner.label}'s accounts for it.`,
    );
  }

  return notOwner(actorPrincipal, unknownTurnMessage(owner));
}

/**
 * The operator's own `ravi sessions send` / `ask` (from the terminal or with
 * the admin key): a session-relay turn with no calling session. Other relays
 * that carry the same principal, such as a runtime goal waking a session, are
 * not a request from the operator.
 */
function isOperatorRelay(actorPrincipal: string, metadata: Record<string, unknown> | null): boolean {
  const origin = objectField(metadata, "turnOrigin");
  if (!origin || origin.producer !== "session-relay") return false;
  if (typeof origin.action !== "string" || !OPERATOR_RELAY_ACTIONS.has(origin.action)) return false;
  if (origin.session !== undefined && origin.session !== null) return false;
  const principal = objectField(origin, "principal");
  return Boolean(principal && `${principal.type}:${principal.id}` === actorPrincipal);
}

/** Legacy NULL and `operator` are the operator; so is a contact bound to the active Console user. */
function cronOwnerIsOperator(ownerPrincipal: string | null, owner: OwnerIdentity, deps: ConnectorTurnDeps): boolean {
  if (ownerPrincipal === null || ownerPrincipal === CRON_OPERATOR_OWNER) return true;
  if (!ownerPrincipal.startsWith("contact:")) return false;
  const identity = (deps.getContactBinding ?? readContactBinding)(ownerPrincipal.slice("contact:".length));
  return isOwnerUser(owner, cleanString(identity?.consoleUserId), cleanString(identity?.consoleOrgId));
}

function surfaceIsOwnersDirectChat(
  chatId: string,
  channel: string | null,
  owner: OwnerIdentity,
  deps: ConnectorTurnDeps,
): boolean {
  if (!owner.userId || !chatId) return false;
  const contactId = (deps.getDmChatContact ?? readDmChatContact)({ chatId, channel });
  if (!contactId) return false;
  const identity = (deps.getContactBinding ?? readContactBinding)(contactId);
  return isOwnerUser(owner, cleanString(identity?.consoleUserId), cleanString(identity?.consoleOrgId));
}

/**
 * `cron_jobs.owner_principal` for a job created (or redefined) in the current
 * turn: `operator` for the terminal and the owner's own turns, else the
 * creating turn's actor principal.
 */
export function resolveCronOwnerPrincipalForCurrentTurn(deps: ConnectorTurnDeps = {}): string {
  let result: ConnectorTurnResult;
  try {
    result = resolveConnectorTurn(deps);
  } catch {
    return "unknown";
  }
  if (!result.ok) return result.speakerIsOwner ? CRON_OPERATOR_OWNER : result.actorPrincipal;
  const kind = result.turn.speaker.kind;
  return kind === "terminal" || kind === "owner" ? CRON_OPERATOR_OWNER : result.turn.actorPrincipal;
}

/**
 * The runtime context a connector call runs under. In-process tool and
 * gateway calls carry it in the CLI store; child CLIs carry
 * `RAVI_CONTEXT_KEY`; processes the daemon spawns for an automation carry
 * `RAVI_AUTOMATION_PRINCIPAL`. Session or trigger env without a context key
 * is a runtime too, so it never counts as the terminal.
 */
export function currentConnectorRuntimeContext(env: NodeJS.ProcessEnv = process.env): ConnectorRuntimeContext {
  const store = getContext({ localOnly: true });
  if (store?.transport === "tool" || store?.transport === "gateway") {
    const contextId = store.context?.contextId;
    return { present: true, record: contextId ? readLiveContext(contextId) : null };
  }
  const key = env[RAVI_CONTEXT_KEY_ENV]?.trim();
  if (key) {
    try {
      return { present: true, record: resolveRuntimeContext(key, { touch: false }) };
    } catch {
      return { present: true, record: null };
    }
  }
  const spawnedPrincipal = readSpawnedAutomationPrincipal(env);
  if (spawnedPrincipal) return { present: true, record: null, spawnedPrincipal };
  if (RUNTIME_ENV_MARKERS.some((name) => Boolean(env[name]?.trim()))) {
    return { present: true, record: null };
  }
  return { present: false, record: null };
}

// ---------------------------------------------------------------------------
// X-Ravi-Exec-Context
// ---------------------------------------------------------------------------

export const EXEC_CONTEXT_HEADER = "X-Ravi-Exec-Context";
export const EXEC_CONTEXT_MAX_BYTES = 2048;

export interface ExecContextV1 {
  v: 1;
  agentId?: string;
  sessionName?: string;
  routine?: ConnectorRoutine;
  speaker: { kind: ConnectorSpeakerKind; contactId?: string; consoleUserId?: string };
  conversation: ConnectorConversation;
  turnKey?: string;
  agentDisplayName?: string;
}

export function buildExecContext(turn: ConnectorTurn): ExecContextV1 {
  return {
    v: 1,
    ...(turn.agentId ? { agentId: turn.agentId } : {}),
    ...(turn.sessionName ? { sessionName: turn.sessionName } : {}),
    ...(turn.routine ? { routine: turn.routine } : {}),
    speaker: turn.speaker,
    conversation: turn.conversation,
    ...(turn.turnKey ? { turnKey: turn.turnKey } : {}),
  };
}

/**
 * The header of `POST /cli/agent-exec`: the executing agent and, for a
 * contact, only the contact id. A Console user id is never sent here, so the
 * Worker can only take the person from its own `ravi link` binding.
 */
export function buildAgentExecContext(turn: ConnectorTurn): ExecContextV1 {
  const { consoleUserId: _ignored, ...speaker } = turn.speaker;
  return {
    ...buildExecContext(turn),
    speaker,
    ...(turn.agentDisplayName ? { agentDisplayName: turn.agentDisplayName } : {}),
  };
}

/**
 * Base64url JSON, at most 2 KB: optional labels are dropped before anything
 * that drives policy. Agent exec needs `agentId` (`keepAgentId`): it is never
 * dropped there, and a header still too large fails closed.
 */
export function encodeExecContextHeader(context: ExecContextV1, options: { keepAgentId?: boolean } = {}): string {
  const candidate: ExecContextV1 = { ...context };
  const droppable = options.keepAgentId
    ? (["agentDisplayName", "sessionName"] as const)
    : (["agentDisplayName", "sessionName", "agentId"] as const);
  for (const key of droppable) {
    const encoded = Buffer.from(JSON.stringify(candidate), "utf8").toString("base64url");
    if (encoded.length <= EXEC_CONTEXT_MAX_BYTES) return encoded;
    delete candidate[key];
  }
  const encoded = Buffer.from(JSON.stringify(candidate), "utf8").toString("base64url");
  if (encoded.length > EXEC_CONTEXT_MAX_BYTES) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Connector exec context is too large to send.");
  }
  return encoded;
}

export function decodeExecContextHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface OwnerIdentity {
  userId: string | null;
  orgId: string | null;
  /** For agent-facing prose. */
  label: string;
  /** Possessive for the English chat line ("Luis's", "my owner's"). */
  possessiveEn: string;
  /** For the Portuguese chat line ("de Luis", "do meu dono"). */
  ofPt: string;
  /** The owner as a Portuguese subject ("Luis", "o meu dono"). */
  namePt: string;
  /** Service named in chat lines. */
  service: string;
}

function resolveOwner(deps: ConnectorTurnDeps, env: NodeJS.ProcessEnv): OwnerIdentity {
  let userId = deps.activeUserId;
  let orgId = deps.activeOrgId;
  let name = deps.ownerName;
  if (userId === undefined) {
    try {
      userId = readActiveCloudAuthUserId(env);
    } catch {
      userId = null;
    }
  }
  if (orgId === undefined || name === undefined) {
    let credentials: ReturnType<typeof readCloudCredentials> = null;
    try {
      credentials = readCloudCredentials(env);
    } catch {
      credentials = null;
    }
    if (orgId === undefined) orgId = cleanString(credentials?.organization?.id);
    if (name === undefined) name = cleanString(credentials?.user?.name) ?? cleanString(credentials?.user?.displayName);
  }
  const cleanName = cleanString(name);
  return {
    userId: cleanString(userId),
    orgId: cleanString(orgId),
    label: cleanName ?? "the account owner",
    possessiveEn: cleanName ? `${cleanName}'s` : "my owner's",
    ofPt: cleanName ? `de ${cleanName}` : "do meu dono",
    namePt: cleanName ?? "o meu dono",
    service: cleanString(deps.service) ?? "Gmail",
  };
}

function isOwnerUser(owner: OwnerIdentity, consoleUserId: string | null, consoleOrgId: string | null): boolean {
  if (!consoleUserId || !owner.userId || consoleUserId !== owner.userId) return false;
  return !consoleOrgId || !owner.orgId || consoleOrgId === owner.orgId;
}

type ActorLineage =
  | { kind: "actor"; context: ContextRecord }
  /** No actor anywhere, under a live admin bootstrap root: only the host operator holds that key. */
  | { kind: "operator" }
  /** A context on the way is revoked or expired: its turn has ended. */
  | { kind: "ended" }
  | { kind: "none" };

/**
 * Walk `parentContextId` to the nearest context that carries the actor. Every
 * context on the way, the actor context included, must still be live: a child
 * issued during one turn must not keep that turn's actor after it ends.
 */
function findActorContext(
  start: ContextRecord,
  getById: (contextId: string) => ContextRecord | null,
  now: number,
): ActorLineage {
  const seen = new Set<string>();
  let cursor: ContextRecord | null = start;
  while (cursor && !seen.has(cursor.contextId) && seen.size < MAX_LINEAGE_DEPTH) {
    seen.add(cursor.contextId);
    if (!isContextLive(cursor, now)) return { kind: "ended" };
    if (stringField(cursor.metadata, "actorPrincipal")) return { kind: "actor", context: cursor };
    const parentId = stringField(cursor.metadata, "parentContextId");
    if (!parentId) return isAdminBootstrapRoot(cursor) ? { kind: "operator" } : { kind: "none" };
    cursor = getById(parentId);
  }
  return { kind: "none" };
}

function isAdminBootstrapRoot(context: ContextRecord): boolean {
  return (
    context.kind === ADMIN_BOOTSTRAP_KIND &&
    context.capabilities.some(
      (cap) => cap.permission === "admin" && cap.objectType === "system" && cap.objectId === "*",
    )
  );
}

function isContextLive(context: ContextRecord, now: number): boolean {
  if (context.revokedAt && context.revokedAt <= now) return false;
  if (context.expiresAt && context.expiresAt <= now) return false;
  return true;
}

function readLiveContext(contextId: string): ContextRecord | null {
  try {
    const record = dbGetContext(contextId);
    return record && isContextLive(record, Date.now()) ? record : null;
  } catch {
    return null;
  }
}

/**
 * The contact of a known direct chat: every chat row matching the id must be
 * a direct chat of one and the same contact. Anything else is not known to be
 * a direct chat.
 */
function readDmChatContact(input: { chatId: string; channel: string | null }): string | null {
  try {
    const chats = dbListChatsByRef({ ref: input.chatId, channel: input.channel, limit: 10 });
    if (chats.length === 0) return null;
    const contacts = new Set<string>();
    for (const chat of chats) {
      if (chat.chatType !== "dm") return null;
      if (chat.normalizedChatId.startsWith("contact:")) {
        contacts.add(chat.normalizedChatId.slice("contact:".length));
        continue;
      }
      const members = new Set(
        dbListChatParticipants(chat.id)
          .map((participant) => participant.contactId)
          .filter((contactId): contactId is string => Boolean(contactId)),
      );
      if (members.size !== 1) return null;
      for (const contactId of members) contacts.add(contactId);
    }
    return contacts.size === 1 ? ([...contacts][0] ?? null) : null;
  } catch {
    return null;
  }
}

function readContactBinding(contactId: string): ContactConsoleIdentity | null {
  try {
    return consoleIdentityFromBinding(readCachedActorBinding(contactId));
  } catch {
    return null;
  }
}

function readActorChannel(metadata: Record<string, unknown>): string | null {
  const actor = objectField(metadata, "actorMetadata") ?? objectField(metadata, "actor");
  return stringField(actor, "channel");
}

function readProjectionSourceId(metadata: Record<string, unknown>): string | null {
  const projection = metadata.actorProjection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return null;
  return stringField(projection as Record<string, unknown>, "sourceContextId");
}

function readCronJobOwner(jobId: string): { found: boolean; ownerPrincipal: string | null } {
  try {
    const job = dbGetCronJob(jobId);
    return job ? { found: true, ownerPrincipal: job.ownerPrincipal ?? null } : { found: false, ownerPrincipal: null };
  } catch {
    return { found: false, ownerPrincipal: null };
  }
}

function notOwnerContact(
  actorPrincipal: string,
  owner: OwnerIdentity,
  unlinked: boolean,
  code: CloudAuthErrorCode = "CONNECTOR_SPEAKER_NOT_OWNER",
): Extract<ConnectorTurnResult, { ok: false }> {
  const chatLine = `I can't use ${owner.possessiveEn} ${owner.service} for your request.`;
  const chatLinePt = `Não posso usar o ${owner.service} ${owner.ofPt} para o seu pedido.`;
  const linkHint = unlinked
    ? ` If this person is ${owner.label} writing from an account Ravi does not know yet, they can link it: run \`ravi link\` in their chat.`
    : "";
  return blocked(
    code,
    actorPrincipal,
    `This message came from someone other than ${owner.label}, and personal connections serve only ${owner.label}'s own requests. Reply in this chat: "${chatLine}"${linkHint}`,
    { chatLine, chatLinePt, replyTo: "same_chat" },
  );
}

function withCandidate(result: BlockedTurn, candidate: ConnectorTurn | undefined): BlockedTurn {
  return candidate ? { ...result, candidate } : result;
}

function notOwner(actorPrincipal: string, message: string): Extract<ConnectorTurnResult, { ok: false }> {
  return blocked("CONNECTOR_SPEAKER_NOT_OWNER", actorPrincipal, message, {});
}

function terminalTurn(): ConnectorTurnResult {
  return { ok: true, turn: { speaker: { kind: "terminal" }, conversation: "terminal", actorPrincipal: "terminal" } };
}

function groupBlockedForOwner(actorPrincipal: string, owner: OwnerIdentity): BlockedTurn {
  const chatLine = "I'll send this to you privately.";
  const chatLinePt = "Vou te mandar isso no privado.";
  return {
    ...blocked(
      "CONNECTOR_GROUP_BLOCKED",
      actorPrincipal,
      `Personal connections are never used in group chats, where other people would read the answer. Reply in the group: "${chatLine}" and ask ${owner.label} to repeat the request in their direct chat with you.`,
      { chatLine, chatLinePt, replyTo: "same_chat" },
    ),
    speakerIsOwner: true,
  };
}

/**
 * A routine, or the operator's relay (`relay`: the relay turn), answering
 * into a chat that is not the owner's direct chat.
 */
function groupBlockedForAutomation(actorPrincipal: string, owner: OwnerIdentity, relay?: ConnectorTurn): BlockedTurn {
  const message = `This turn answers into a chat that is not known to be ${owner.label}'s direct chat, and personal connections are never used where other people may read the answer.`;
  if (!relay) return blocked("CONNECTOR_GROUP_BLOCKED", actorPrincipal, message, {});
  return relayBlocked(
    actorPrincipal,
    owner,
    relay,
    `${message} ${owner.label} sent this from their terminal (\`ravi sessions send|ask\`), and this session posts its answers into that chat. Do not retry: ${owner.label} can run the command in their terminal or ask in their own direct chat with you.`,
  );
}

function relayAnswerUnknown(actorPrincipal: string, owner: OwnerIdentity, relay: ConnectorTurn): BlockedTurn {
  return relayBlocked(
    actorPrincipal,
    owner,
    relay,
    `${owner.label} sent this from their terminal (\`ravi sessions send|ask\`), but Ravi could not tell where this session posts the answer, and personal connections are never used where other people may read it. Do not retry: ${owner.label} can run the command in their terminal or ask in their own direct chat with you.`,
  );
}

/**
 * The operator's own relay, refused only for where the session posts its
 * answer. Still the owner's request (`speakerIsOwner`: a cron it creates is
 * the operator's), and nothing the agent says may carry what the account
 * returns, so the next step is not the group-chat one of the code's catalog.
 */
function relayBlocked(
  actorPrincipal: string,
  owner: OwnerIdentity,
  relay: ConnectorTurn,
  message: string,
): BlockedTurn {
  return {
    ...blocked("CONNECTOR_GROUP_BLOCKED", actorPrincipal, message, {
      suggestedAction: `do not retry, and post nothing from ${owner.possessiveEn} ${owner.service} into the chat this session answers in; ${owner.label} can run the command in their terminal`,
    }),
    speakerIsOwner: true,
    relay,
  };
}

/**
 * The owner in their own direct chat, in a session other people's chats
 * share (`dmScope: main`, a route that sends several chats to one session,
 * an attached chat): what their accounts return would stay in a transcript
 * the others can ask about. The owner is also the operator, so the line tells
 * them how to allow it.
 */
function ownerSharedSessionBlocked(actorPrincipal: string, owner: OwnerIdentity): BlockedTurn {
  const chatLine = `I can't use your ${owner.service} in this conversation: other people's chats share its session. Give each person their own session (dmScope per-peer), then ask me again.`;
  const chatLinePt = `Não posso usar o seu ${owner.service} nesta conversa: as conversas de outras pessoas compartilham a sessão dela. Dê a cada pessoa a própria sessão (dmScope per-peer) e me peça de novo.`;
  return {
    ...blocked(
      "CONNECTOR_GROUP_BLOCKED",
      actorPrincipal,
      `${owner.label} asked in their own direct chat, but its session is shared with other people's chats (dmScope main, a route that sends several chats to one session, or an attached chat), so they could read what ${owner.possessiveEn} ${owner.service} returns. Do not retry. Reply: "${chatLine}"`,
      {
        chatLine,
        chatLinePt,
        replyTo: "same_chat",
        suggestedAction: `reply in this chat with the chat line, and do not retry until ${owner.label} gives each person their own session (dmScope per-peer)`,
      },
    ),
    speakerIsOwner: true,
    sharedSession: true,
  };
}

function unknownTurnMessage(owner: OwnerIdentity): string {
  return `Ravi could not tell who is asking in this turn, so it will not use ${owner.label}'s connected accounts.`;
}

function endedTurnMessage(owner: OwnerIdentity): string {
  return `This call runs under the context of a turn that has already ended, so Ravi will not use ${owner.label}'s connected accounts. Run it again from the current turn.`;
}

function blocked(
  code: CloudAuthErrorCode,
  actorPrincipal: string,
  message: string,
  details: {
    chatLine?: string;
    chatLinePt?: string;
    replyTo?: "same_chat" | "owner_privately";
    /** Only where the code's catalog next step would contradict the message. */
    suggestedAction?: string;
  },
): Extract<ConnectorTurnResult, { ok: false }> {
  return {
    ok: false,
    actorPrincipal,
    error: new CloudAuthError(code, message, { exitCode: 3, details: { source: "connector-turn", ...details } }),
  };
}

/** The session of a turn, when its contexts name one and agree on it. */
function sameSessionKey(...keys: Array<string | undefined>): string | null {
  const named = new Set(keys.map((key) => cleanString(key)).filter((key): key is string => Boolean(key)));
  return named.size === 1 ? ([...named][0] ?? null) : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stringField(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  return cleanString(metadata?.[key]);
}

function objectField(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
