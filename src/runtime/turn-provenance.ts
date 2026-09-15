import type { RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimeTurnOrigin } from "./turn-origin.js";

/** Canonical cause of a runtime turn. Kept separate from actor authority and reply surface. */
export type TurnOrigin =
  | "human"
  | "cron"
  | "trigger"
  | "session-followup"
  | "heartbeat"
  | "observer"
  | "task"
  | "routine"
  | "daemon-restart"
  | "automation"
  | "agent"
  | "system"
  | "background"
  | "unknown";

export interface TurnProvenance {
  origin: TurnOrigin;
  /** True when the turn must use background runtime capacity and silent presence semantics. */
  background: boolean;
  /** True when an automated producer, rather than a human message, caused the turn. */
  automationOriginated: boolean;
  automationId?: string;
  /** Stable, machine-readable explanation of the strongest signal used. */
  reason: string;
}

type TurnProvenanceSource = Pick<
  RuntimeMessageTarget,
  "actorType" | "automationId" | "identityProvenance" | "suppressPresence"
>;

export interface TurnProvenanceInput {
  prompt?: Partial<RuntimeLaunchPrompt> | null;
  source?: TurnProvenanceSource | null;
}

const AUTOMATION_ORIGINS = new Set<TurnOrigin>([
  "cron",
  "trigger",
  "session-followup",
  "heartbeat",
  "observer",
  "task",
  "routine",
  "daemon-restart",
  "automation",
  "agent",
  "system",
  "background",
]);

function result(origin: TurnOrigin, reason: string, automationId?: string): TurnProvenance {
  const background = origin !== "human" && origin !== "unknown";
  return {
    origin,
    background,
    automationOriginated: AUTOMATION_ORIGINS.has(origin),
    ...(automationId ? { automationId } : {}),
    reason,
  };
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function provenanceSource(source: TurnProvenanceSource | null | undefined): string | undefined {
  const provenance = source?.identityProvenance;
  if (!provenance || typeof provenance !== "object") return undefined;
  return cleanString((provenance as Record<string, unknown>).source)?.toLowerCase();
}

function originFromProvenanceSource(value: string | undefined): TurnOrigin | undefined {
  switch (value) {
    case "cron":
      return "cron";
    case "trigger":
      return "trigger";
    case "session-followup":
    case "sessionfollowup":
      return "session-followup";
    case "heartbeat":
      return "heartbeat";
    case "observer":
    case "observation":
      return "observer";
    case "task":
      return "task";
    case "routine":
      return "routine";
    case "daemon-restart":
      return "daemon-restart";
    case "automation":
      return "automation";
    case "background":
      return "background";
    default:
      return undefined;
  }
}

function originFromAutomationId(automationId: string | undefined): TurnOrigin {
  const prefix = automationId?.split(":", 1)[0]?.toLowerCase();
  return originFromProvenanceSource(prefix) ?? "automation";
}

/**
 * Resolve the cause of the effective turn. Prompt markers win over reply-surface
 * metadata: a cron replying into Slack is still a cron turn.
 */
export function classifyTurnProvenance(input: TurnProvenanceInput = {}): TurnProvenance {
  const prompt = input.prompt ?? undefined;
  const turnOrigin = resolveRuntimeTurnOrigin(prompt?._turnOrigin);
  const promptSource = prompt?.source;
  const promptContext = prompt?.context;
  const source: TurnProvenanceSource = {
    actorType: input.source?.actorType ?? promptContext?.actorType ?? promptSource?.actorType,
    automationId: input.source?.automationId ?? promptContext?.automationId ?? promptSource?.automationId,
    identityProvenance:
      input.source?.identityProvenance ?? promptContext?.identityProvenance ?? promptSource?.identityProvenance,
    suppressPresence: input.source?.suppressPresence ?? promptSource?.suppressPresence,
  };

  if (turnOrigin) {
    const reason = `prompt._turnOrigin:${turnOrigin.producer}:${turnOrigin.action}`;
    return turnOrigin.principal.type === "agent"
      ? result("agent", reason)
      : result("system", reason, turnOrigin.principal.id);
  }

  if (prompt?._observation) {
    return result("observer", "prompt._observation", `observer:${prompt._observation.bindingId}`);
  }
  if (prompt?._cron) return result("cron", "prompt._cron", prompt._jobId ? `cron:${prompt._jobId}` : undefined);
  if (prompt?._trigger) {
    return result("trigger", "prompt._trigger", prompt._triggerId ? `trigger:${prompt._triggerId}` : undefined);
  }
  if (prompt?._sessionFollowup) {
    return result(
      "session-followup",
      "prompt._sessionFollowup",
      prompt._sessionFollowupCadenceId ? `session-followup:${prompt._sessionFollowupCadenceId}` : undefined,
    );
  }
  if (prompt?._heartbeat) return result("heartbeat", "prompt._heartbeat", "heartbeat");
  const taskId = cleanString(prompt?.taskBarrierTaskId);
  if (taskId) return result("task", "prompt.taskBarrierTaskId", `task:${taskId}`);
  if (prompt?._daemonRestartResume) {
    return result("daemon-restart", "prompt._daemonRestartResume", "daemon-restart");
  }

  const automationId = cleanString(source?.automationId);
  if (source?.actorType === "automation" && automationId) {
    return result(originFromAutomationId(automationId), "source.actorType=automation", automationId);
  }

  const identitySource = provenanceSource(source);
  const identityOrigin = originFromProvenanceSource(identitySource);
  if (identityOrigin) {
    return result(identityOrigin, `identityProvenance.source=${identitySource}`, automationId);
  }

  if (source?.suppressPresence === true) return result("background", "source.suppressPresence", automationId);
  if (source?.actorType === "agent") return result("agent", "source.actorType=agent");
  if (source?.actorType === "system") return result("system", "source.actorType=system");
  if (source?.actorType === "contact") return result("human", "source.actorType=contact");

  return result("unknown", "no origin signal");
}

export function isBackgroundTurn(input: TurnProvenanceInput = {}): boolean {
  return classifyTurnProvenance(input).background;
}
