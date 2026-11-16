/** Trusted runner snapshot of a trigger's owner, carried with the prompt it fires. */
export interface TriggerRunAuthority {
  triggerId: string;
  /** `unknown` when the trigger has no recorded owner. */
  ownerPrincipal: string;
  /** Admission ceiling: a later identity link cannot promote this turn. */
  ownerIsOperator: boolean;
  /**
   * The key of the trigger's own session when the fire was sent there: the
   * one session only an owned trigger's `isolated` fires run in. Null for a
   * fire sent anywhere else (the agent's main session, a chat's session, a
   * named or templated session). The owner's authority is lent in that very
   * session only, never inside another conversation.
   */
  ownSessionKey: string | null;
}

/**
 * Whether the snapshot lends someone's authority to the turn: the owner is
 * the operator or a contact, and the fire runs in the trigger's own session.
 * Such a fire is delivered as a turn of its own. Anything else, a malformed
 * snapshot included, lends nothing.
 */
export function triggerAuthorityLendsOwner(authority: unknown): boolean {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) return false;
  const record = authority as Record<string, unknown>;
  if (typeof record.ownSessionKey !== "string" || !record.ownSessionKey) return false;
  if (typeof record.ownerPrincipal !== "string") return false;
  return record.ownerIsOperator === true || record.ownerPrincipal.startsWith("contact:");
}

/** Whether a principal is a person a routine can act for: the operator or a contact. */
export function isPersonPrincipal(principal: string | null | undefined): boolean {
  const value = principal?.trim();
  return value === "operator" || (value?.startsWith("contact:") === true && value.length > "contact:".length);
}

/**
 * A session a trigger's runner created, from its key:
 * - `isolated`: `agent:<agent>:trigger:<id>`, the one session of a trigger
 *   with no owner (every trigger written before owners existed);
 * - `own`: `agent:<agent>:trigger:<id>:own`, the one session of a trigger a
 *   person owns, which only that trigger's fires enter and the only place its
 *   owner's authority is lent;
 * - `named`: `agent:<agent>:trigger:<id>:key:<hash>`, a named session the
 *   trigger created.
 */
export interface TriggerSessionKey {
  agentId: string;
  triggerId: string;
  kind: "isolated" | "own" | "named";
}

/**
 * Reads a trigger's session key, exactly as the runner writes it. Null for
 * any other session, one derived from a trigger's session included (a thread
 * opened from it has its own key and its own participants).
 *
 * The session store creates a session under such a key for the trigger runner
 * only (`getOrCreateSession`), so the key says who made the session.
 */
export function parseTriggerSessionKey(sessionKey: string | null | undefined): TriggerSessionKey | null {
  const match = /^agent:([^:]+):trigger:([^:]+)(?::(own)|:(key):[0-9a-f]{24})?$/.exec(sessionKey ?? "");
  if (!match) return null;
  const [, agentId, triggerId, own, named] = match;
  if (!agentId || !triggerId) return null;
  return { agentId, triggerId, kind: own ? "own" : named ? "named" : "isolated" };
}

const SESSION_NAME_UNSAFE_CHARS = /[~.\s*>]/g;

/**
 * The one name a trigger's own session goes by: its key. A session name is
 * one subject token on the bus, so a character it cannot hold (a dot,
 * whitespace, `*`, `>`, which only an unusual agent id brings) is written as
 * `~<code>~`; for every other key the name is the key itself. Different keys
 * give different names, and the name is still spelled like an own session's
 * key, so the session store gives it to no other session.
 */
export function triggerOwnSessionName(sessionKey: string): string {
  return sessionKey.replace(
    SESSION_NAME_UNSAFE_CHARS,
    (char) => `~${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}~`,
  );
}

/**
 * Whether a name is spelled like a trigger's session key, in any letter case.
 * Names and keys share one namespace, so the session store lets no session go
 * by such a name unless it is that session's own key.
 */
export function looksLikeTriggerSessionKey(name: string | null | undefined): boolean {
  return /^agent:[^:]+:trigger:[^:]+(?::own|:key:[0-9a-f]{24})?$/i.test(name?.trim() ?? "");
}

/** The trigger whose runner created a session, or null for any other session. */
export function triggerOfSessionKey(sessionKey: string | null | undefined): string | null {
  return parseTriggerSessionKey(sessionKey)?.triggerId ?? null;
}

/** Whether a session is some owned trigger's own session, which only that trigger's fires enter. */
export function isTriggerOwnSessionKey(sessionKey: string | null | undefined): boolean {
  return parseTriggerSessionKey(sessionKey)?.kind === "own";
}

/**
 * Whether a prompt may run in this session. A trigger's own session runs that
 * trigger's fires and nothing else: no relay, task report, cron run, hook
 * action or chat message is admitted, whoever sent it, so what its owner's
 * turns read is neither answered to nor continued by anyone else. The notice
 * a failed shell command sends about itself is not a fire, even when it names
 * the same trigger. The runtime's restart notice is the one exception, and
 * only the one written for that very session. Every other session admits
 * prompts as before.
 */
export function triggerOwnSessionAdmitsPrompt(
  sessionKey: string | null | undefined,
  prompt: { _trigger?: unknown; _triggerId?: unknown; _triggerOnError?: unknown; _daemonRestartResume?: unknown },
): boolean {
  const key = parseTriggerSessionKey(sessionKey);
  if (key?.kind !== "own") return true;
  if (prompt._triggerOnError) return false;
  if (prompt._trigger === true && prompt._triggerId === key.triggerId) return true;
  const restart = prompt._daemonRestartResume;
  if (!restart || typeof restart !== "object" || Array.isArray(restart)) return false;
  return (restart as { sessionKey?: unknown }).sessionKey === sessionKey;
}

/**
 * The key of the one session only this trigger runs in (`--session isolated`).
 * A trigger a person owns gets a session of a different key than one nobody
 * owns: when a trigger loses its owner it moves to the other session, and the
 * one that held its owner's turns is never entered again.
 */
export function triggerIsolatedSessionKey(agentId: string, triggerId: string, owned: boolean): string {
  return owned ? `agent:${agentId}:trigger:${triggerId}:own` : `agent:${agentId}:trigger:${triggerId}`;
}

/** Missing/malformed snapshots fail closed; never reconstruct from the live trigger. */
export function readTriggerRunAuthority(value: unknown, triggerId: string): TriggerRunAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.triggerId !== triggerId ||
    typeof record.ownerPrincipal !== "string" ||
    !record.ownerPrincipal.trim() ||
    typeof record.ownerIsOperator !== "boolean" ||
    !(record.ownSessionKey === null || (typeof record.ownSessionKey === "string" && record.ownSessionKey.length > 0))
  )
    return null;
  return {
    triggerId,
    ownerPrincipal: record.ownerPrincipal,
    ownerIsOperator: record.ownerIsOperator,
    ownSessionKey: record.ownSessionKey,
  };
}
