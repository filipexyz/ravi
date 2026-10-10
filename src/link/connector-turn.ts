/**
 * Who is asking, for connector calls.
 *
 * A personal connection serves only its owner's own requests ("Only when I
 * ask"): the terminal, the owner's own direct chat (linked by `ravi link`) and
 * routines the owner owns. Every connector call classifies the current turn
 * first and fails closed on anything else, so another person's message never
 * reaches the operator's Console session. The "dono" permission tag is not
 * identity: only the Console user bound to the speaking contact is.
 *
 * The same classification builds the `X-Ravi-Exec-Context` header sent on
 * exec. The Worker cannot verify that header; it trusts the daemon holding
 * the operator session, which is why this side must never send an allowed
 * header for a turn it would block.
 */

import { createHash } from "node:crypto";

import { getContext } from "../cli/context.js";
import { consoleIdentityFromBinding, readCachedActorBinding } from "../cloud-auth/actor-bindings.js";
import { CloudAuthError, type CloudAuthErrorCode } from "../cloud-auth/errors.js";
import { readActiveCloudAuthUserId, readCloudCredentials } from "../cloud-auth/storage.js";
import { dbGetCronJob } from "../cron/cron-db.js";
import { dbGetContext, dbListChatParticipants, dbListChatsByRef, type ContextRecord } from "../router/router-db.js";
import {
  ADMIN_BOOTSTRAP_AGENT_ID,
  ADMIN_BOOTSTRAP_KIND,
  RAVI_CONTEXT_KEY_ENV,
  resolveRuntimeContext,
} from "../runtime/context-registry.js";
import { RAVI_AUTOMATION_PRINCIPAL_ENV, readSpawnedAutomationPrincipal } from "../runtime/turn-origin.js";

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
}

export type ConnectorTurnResult =
  | { ok: true; turn: ConnectorTurn }
  | {
      ok: false;
      error: CloudAuthError;
      actorPrincipal: string;
      /** The speaker is the owner, blocked only by where the answer would go (a group). */
      speakerIsOwner?: boolean;
    };

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
  /** Service named in chat lines. */
  service?: string;
  now?: number;
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
    const isOwner =
      stringField(metadata, "actorResolution") === "resolved" &&
      isOwnerUser(owner, consoleUserId, stringField(metadata, "consoleOrgId"));
    if (surface?.type === "chat") {
      return isOwner
        ? groupBlockedForOwner(actorPrincipal, owner)
        : notOwnerContact(actorPrincipal, owner, false, "CONNECTOR_GROUP_BLOCKED");
    }
    if (!isOwner) {
      return notOwnerContact(actorPrincipal, owner, !consoleUserId);
    }
    if (surface?.type !== "dm") {
      return { ...notOwner(actorPrincipal, unknownTurnMessage(owner)), speakerIsOwner: true };
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
  if (!verdict.ok || (surface?.type !== "chat" && surface?.type !== "dm")) return verdict;
  // A routine or an operator relay answering into a chat: only the owner's
  // own direct chat may receive what the operator's accounts return.
  if (!surfaceIsOwnersDirectChat(surface.id, readActorChannel(metadata), owner, deps)) {
    return groupBlockedForAutomation(actorPrincipal, owner);
  }
  return { ok: true, turn: { ...verdict.turn, conversation: "dm" } };
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

/** Base64url JSON, at most 2 KB: optional labels are dropped before anything that drives policy. */
export function encodeExecContextHeader(context: ExecContextV1): string {
  const candidate: ExecContextV1 = { ...context };
  for (const key of ["agentDisplayName", "sessionName", "agentId"] as const) {
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

function notOwner(actorPrincipal: string, message: string): Extract<ConnectorTurnResult, { ok: false }> {
  return blocked("CONNECTOR_SPEAKER_NOT_OWNER", actorPrincipal, message, {});
}

function terminalTurn(): ConnectorTurnResult {
  return { ok: true, turn: { speaker: { kind: "terminal" }, conversation: "terminal", actorPrincipal: "terminal" } };
}

function groupBlockedForOwner(actorPrincipal: string, owner: OwnerIdentity): ConnectorTurnResult {
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

function groupBlockedForAutomation(actorPrincipal: string, owner: OwnerIdentity): ConnectorTurnResult {
  return blocked(
    "CONNECTOR_GROUP_BLOCKED",
    actorPrincipal,
    `This turn answers into a chat that is not known to be ${owner.label}'s direct chat, and personal connections are never used where other people may read the answer.`,
    {},
  );
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
  details: { chatLine?: string; chatLinePt?: string; replyTo?: "same_chat" | "owner_privately" },
): Extract<ConnectorTurnResult, { ok: false }> {
  return {
    ok: false,
    actorPrincipal,
    error: new CloudAuthError(code, message, { exitCode: 3, details: { source: "connector-turn", ...details } }),
  };
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
