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
  type ConnectorTurnResult,
  type ExecContextV1,
  resolveConnectorTurn,
} from "../../link/connector-turn.js";
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
  sessionName: null,
  agentId: null,
  execContext: { v: 1, speaker: { kind: "terminal" }, conversation: "terminal" },
};

export function classifyKnowledgeTurn(deps: LibraryTurnDeps = {}): KnowledgeTurnVerdict {
  if (deps.operatorOwnTurn === true) return { ok: true, turn: { ...TERMINAL_TURN } };
  if (deps.operatorOwnTurn === false) return refuse("unknown", "unknown");
  try {
    return verdictFor(resolveKnowledgeConnectorTurn(deps));
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

function verdictFor(result: ConnectorTurnResult): KnowledgeTurnVerdict {
  if (!result.ok) return refuse(blockedReason(result), result.actorPrincipal);
  const turn = result.turn;
  // A heartbeat has no owner check (connector-turn.ts:617-628): never the operator here.
  if (turn.routine?.kind === "heartbeat") return refuse("routine", turn.actorPrincipal);
  if (turn.speaker.kind === "terminal") return allow(turn);
  if (turn.speaker.kind === "owner") {
    if (turn.conversation === "dm" || turn.conversation === "terminal") return allow(turn);
    return refuse(turn.conversation === "group" ? "group" : "unknown", turn.actorPrincipal);
  }
  if (turn.routine?.kind === "cron") return allow(turn);
  return refuse(reasonForSpeaker(turn), turn.actorPrincipal);
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

function allow(turn: ConnectorTurn): KnowledgeTurnVerdict {
  return {
    ok: true,
    turn: {
      audience: "operator",
      turnKey: turn.turnKey ?? null,
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
