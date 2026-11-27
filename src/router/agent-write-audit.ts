/**
 * Audit of writes to the agents table.
 *
 * Before this module a write to `agents` left only "Updated agent id=<x>" in
 * the daemon log: on 27/11 a stale read-modify-write replaced
 * `agents.main.defaults` and dropped its runtimePermissions with no record of
 * who wrote it or which keys changed. Every agent write now lands one
 * audit_log row with the caller and the top-level keys that changed.
 */
import { getContext } from "../cli/context.js";
import { currentConsoleInvocation } from "../sdk/gateway/console-context.js";

export interface AgentDefaultsDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Top-level key diff between two defaults objects (null/undefined = empty). */
export function diffAgentDefaults(before: unknown, after: unknown): AgentDefaultsDiff {
  const a = isPlainRecord(before) ? before : {};
  const b = isPlainRecord(after) ? after : {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(b)) {
    if (!(key in a)) added.push(key);
    else if (stableJson(a[key]) !== stableJson(b[key])) changed.push(key);
  }
  for (const key of Object.keys(a)) {
    if (!(key in b)) removed.push(key);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

const SECRET_LIKE_KEY = /key|token|secret|password|credential/i;

/** Copy of a value with every secret-looking key, at any depth, replaced by "[redacted]". */
export function redactSecretLikeValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretLikeValues);
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_LIKE_KEY.test(key) ? "[redacted]" : redactSecretLikeValues(inner);
    }
    return out;
  }
  return value;
}

/**
 * Old values of the keys a write changed or removed, for audit_log.old_value.
 * Secret-looking key names are recorded as "[redacted]" at any depth
 * (`{ provider: { apiKey } }` included).
 */
export function previousAgentDefaultsValues(before: unknown, diff: AgentDefaultsDiff): Record<string, unknown> {
  const a = isPlainRecord(before) ? before : {};
  const out: Record<string, unknown> = {};
  for (const key of [...diff.changed, ...diff.removed]) {
    out[key] = SECRET_LIKE_KEY.test(key) ? "[redacted]" : redactSecretLikeValues(a[key]);
  }
  return out;
}

export function agentDefaultsDiffIsEmpty(diff: AgentDefaultsDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/**
 * Who is writing, from the ambient invocation. Both lookups only read
 * AsyncLocalStorage (`localOnly` skips the credential file), so neither
 * throws; with no invocation it falls back to the process identity.
 */
export function describeAgentWriteActor(): string {
  const consoleInvocation = currentConsoleInvocation();
  if (consoleInvocation) {
    const subject = consoleInvocation.grant?.sub;
    return typeof subject === "string" && subject ? `console:${subject}` : "console";
  }
  const ctx = getContext({ localOnly: true });
  if (ctx) {
    const parts: string[] = [];
    const kind = ctx.context?.kind;
    if (kind) parts.push(`kind=${kind}`);
    if (ctx.contextId) parts.push(`context=${ctx.contextId}`);
    if (ctx.agentId) parts.push(`agent=${ctx.agentId}`);
    if (ctx.sessionName) parts.push(`session=${ctx.sessionName}`);
    if (ctx.transport) parts.push(`transport=${ctx.transport}`);
    if (parts.length > 0) return parts.join(" ");
  }
  const env = process.env;
  const parts: string[] = [];
  if (env.RAVI_AGENT_ID) parts.push(`agent=${env.RAVI_AGENT_ID}`);
  if (env.RAVI_SESSION_NAME) parts.push(`session=${env.RAVI_SESSION_NAME}`);
  parts.push(`user=${env.USER ?? "daemon"}`);
  return parts.join(" ");
}
