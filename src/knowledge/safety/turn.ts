// Who may use Knowledge (contract §11.1). Only the operator's own turns: the
// terminal, the operator's own direct chat (and the operator's relay), and
// routines the operator owns. The owner speaking in a group, heartbeats,
// triggers, other agents and contacts are refused, and a turn that cannot be
// classified fails closed.

import { readActiveCloudAuthUserId, readCloudCredentials } from "../../cloud-auth/storage.js";
import { LEGACY_CLOUD_AUTH_USER_ID } from "../../cloud-auth/types.js";
import type { LibraryTurnDeps } from "../../library/turn.js";
import {
  buildExecContext,
  type ConnectorTurn,
  type ConnectorTurnDeps,
  type ConnectorTurnResult,
  currentConnectorRuntimeContext,
  type ExecContextV1,
  isOwnersDirectChat,
  resolveConnectorTurn,
} from "../../link/connector-turn.js";
import { dbListRoutesBySessionName, dbListSessionChatSubscriptions } from "../../router/router-db.js";
import { parseSessionKey } from "../../router/session-key.js";
import { resolveSession } from "../../router/sessions.js";
import { dbListTriggers } from "../../triggers/triggers-db.js";
import type { KnowledgeTurn } from "../types.js";

export type KnowledgeTurnVerdict =
  | { ok: true; turn: KnowledgeTurn }
  | {
      ok: false;
      code: "KNOWLEDGE_TURN_NOT_OPERATOR";
      reason: "group" | "contact" | "shared_session" | "routine" | "agent" | "unknown";
      actorPrincipal: string;
    };

type RefusalReason = Extract<KnowledgeTurnVerdict, { ok: false }>["reason"];

const TERMINAL_TURN: KnowledgeTurn = {
  audience: "operator",
  turnKey: null,
  sessionKey: null,
  sessionName: null,
  agentId: null,
  execContext: { v: 1, speaker: { kind: "terminal" }, conversation: "terminal" },
};

export function classifyKnowledgeTurn(deps: LibraryTurnDeps = {}): KnowledgeTurnVerdict {
  if (deps.operatorOwnTurn === true) return { ok: true, turn: { ...TERMINAL_TURN } };
  if (deps.operatorOwnTurn === false) return refuse("unknown", "unknown");
  try {
    return verdictFor(resolveKnowledgeConnectorTurn(deps), deps);
  } catch {
    return refuse("unknown", "unknown");
  }
}

export function isKnowledgeOperatorTurn(deps: LibraryTurnDeps = {}): boolean {
  return classifyKnowledgeTurn(deps).ok;
}

/**
 * The connector classification with the active `ravi login` user and org, as
 * `isOperatorOwnTurn` resolves them. Throws when the turn cannot be read.
 */
export function resolveKnowledgeConnectorTurn(deps: LibraryTurnDeps = {}): ConnectorTurnResult {
  const env = deps.turn?.env ?? process.env;
  let active: ReturnType<typeof readCloudCredentials> = null;
  try {
    active = (deps.readCredentials ?? readCloudCredentials)(env);
  } catch {
    active = null;
  }
  return resolveConnectorTurn({
    ...deps.turn,
    env,
    activeUserId:
      deps.turn?.activeUserId !== undefined ? deps.turn.activeUserId : activeCloudUserId(env, active?.user?.id),
    activeOrgId: deps.turn?.activeOrgId !== undefined ? deps.turn.activeOrgId : (active?.organization?.id ?? null),
  });
}

function verdictFor(result: ConnectorTurnResult, deps: LibraryTurnDeps): KnowledgeTurnVerdict {
  if (!result.ok) return refuse(blockedReason(result), result.actorPrincipal);
  const turn = result.turn;
  // A heartbeat has no owner check (connector-turn.ts:617-628): never the operator here.
  if (turn.routine?.kind === "heartbeat") return refuse("routine", turn.actorPrincipal);
  if (turn.speaker.kind === "terminal") return allow(turn, null);
  const sessionKey = currentKnowledgeSessionKey(deps);
  if (turn.speaker.kind === "owner") {
    if (turn.conversation !== "dm" && turn.conversation !== "terminal") {
      return refuse(turn.conversation === "group" ? "group" : "unknown", turn.actorPrincipal);
    }
    // The owner's own direct chat was checked for a private session upstream;
    // the relay (no contact) answers in whatever session it was sent to.
    if (turn.speaker.contactId) return allow(turn, sessionKey);
    return privateSessionOrRefuse(turn, sessionKey, deps);
  }
  if (turn.routine?.kind === "cron") return privateSessionOrRefuse(turn, sessionKey, deps);
  return refuse(reasonForSpeaker(turn), turn.actorPrincipal);
}

/**
 * The relay and owner crons read Knowledge into a session transcript, so the
 * session must be the operator's alone: a session made from the terminal, an
 * `--isolated` cron session, or the owner's private direct session.
 */
function privateSessionOrRefuse(turn: ConnectorTurn, sessionKey: string | null, deps: LibraryTurnDeps) {
  if (!isOperatorPrivateSession(sessionKey, turn.sessionName ?? null, deps.turn ?? {})) {
    return refuse("shared_session", turn.actorPrincipal);
  }
  return allow(turn, sessionKey);
}

/**
 * Whether a session is the operator's alone. Its key is a plain name (made by
 * \`ravi sessions send\`), an isolated cron key, or a per-peer direct-chat
 * key; no route sends chats into it by name, no enabled trigger targets it,
 * and every chat attached to it is the owner's own direct chat. Anything
 * unknown is not private.
 */
export function isOperatorPrivateSession(
  sessionKey: string | null,
  sessionName: string | null,
  deps: ConnectorTurnDeps = {},
): boolean {
  if (!sessionKey) return false;
  try {
    const parts = sessionKey.split(":");
    if (parts[0] === "agent") {
      if (parts.length < 4) return false;
      if (parts[2] !== "cron") {
        const parsed = parseSessionKey(sessionKey);
        if (!parsed || parsed.peerKind !== "dm" || parsed.dmScope === "main" || parsed.threadId) return false;
      }
    }
    const name = sessionName ?? resolveSession(sessionKey)?.name ?? null;
    if (name && dbListRoutesBySessionName(name).length > 0) return false;
    for (const subscription of dbListSessionChatSubscriptions(sessionKey)) {
      if (!isOwnersDirectChat(subscription.chatId, null, deps)) return false;
    }
    const targets = new Set([sessionKey, name].filter((value): value is string => Boolean(value)));
    return !dbListTriggers({ enabledOnly: true }).some((trigger) => targets.has(trigger.session));
  } catch {
    return false;
  }
}

/** The session the current turn runs in; null on the terminal or when unknown. */
export function currentKnowledgeSessionKey(deps: LibraryTurnDeps = {}): string | null {
  const env = deps.turn?.env ?? process.env;
  try {
    const record = (deps.turn?.runtimeContext ?? currentConnectorRuntimeContext(env)).record;
    const key = record?.sessionKey?.trim() || env.RAVI_SESSION_KEY?.trim();
    if (key) return key;
    const name = record?.sessionName?.trim() || env.RAVI_SESSION_NAME?.trim();
    return name ? (resolveSession(name)?.sessionKey ?? null) : null;
  } catch {
    return null;
  }
}

function blockedReason(result: Extract<ConnectorTurnResult, { ok: false }>): RefusalReason {
  if (result.sharedSession) return "shared_session";
  const shaped = result.candidate ?? result.relay;
  if (shaped?.conversation === "group") return "group";
  if (shaped) return reasonForSpeaker(shaped);
  const type = principalType(result.actorPrincipal);
  if (type === "contact") return result.speakerIsOwner ? "unknown" : "contact";
  if (type === "agent") return "agent";
  if (type === "automation") return "routine";
  return "unknown";
}

function reasonForSpeaker(turn: ConnectorTurn): RefusalReason {
  switch (turn.speaker.kind) {
    case "contact":
      return "contact";
    case "agent":
      return "agent";
    case "automation":
      return "routine";
    default:
      return turn.conversation === "group" ? "group" : "unknown";
  }
}

function allow(turn: ConnectorTurn, sessionKey: string | null): KnowledgeTurnVerdict {
  return {
    ok: true,
    turn: {
      audience: "operator",
      turnKey: turn.turnKey ?? null,
      sessionKey,
      sessionName: turn.sessionName ?? null,
      agentId: turn.agentId ?? null,
      execContext: knowledgeExecContext(turn),
    },
  };
}

/** `buildExecContext` without `speaker.consoleUserId` (contract §4.1). */
function knowledgeExecContext(turn: ConnectorTurn): ExecContextV1 {
  const context = buildExecContext(turn);
  const { consoleUserId: _ignored, ...speaker } = context.speaker;
  return { ...context, speaker };
}

function refuse(reason: RefusalReason, actorPrincipal: string): KnowledgeTurnVerdict {
  return { ok: false, code: "KNOWLEDGE_TURN_NOT_OPERATOR", reason, actorPrincipal };
}

function principalType(actorPrincipal: string): string {
  const separator = actorPrincipal.indexOf(":");
  return separator > 0 ? actorPrincipal.slice(0, separator) : actorPrincipal;
}

function activeCloudUserId(env: NodeJS.ProcessEnv, fallback: unknown): string | null {
  try {
    const pointer = readActiveCloudAuthUserId(env);
    if (pointer && pointer !== LEGACY_CLOUD_AUTH_USER_ID) return pointer;
  } catch {
    // An unreadable pointer falls back to the stored session's own user.
  }
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
}
