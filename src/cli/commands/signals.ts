/**
 * Signals Commands - durable world conditions with piggyback delivery.
 * Spec: `runtime/signals`.
 */

import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  assertSignalTitle,
  normalizeSeverity,
  parseDurationMs,
  parseMetricSpec,
  normalizeScope,
  validateClearWhen,
} from "../../signals/validation.js";
import type { ClearWhen, RaiseSignalInput } from "../../signals/types.js";
import { SIGNAL_STATES } from "../../signals/types.js";
import {
  ackSignal,
  explainSignal,
  findSignal,
  getSignalBudget,
  listSignals,
  muteSignal,
  raiseSignal,
  resolveSignal,
  unmuteSignal,
  updateSignal,
} from "../../signals/service.js";
import { dbClearKeyMute, dbSetKeyMute } from "../../signals/signal-db.js";
import { readSessionSignalContext, signalIsInSessionScope } from "../../signals/subjects.js";
import { tickSignals } from "../../signals/tick.js";
import { jsonObjectSchema } from "../return-schemas.js";

const clearWhenSchema = z.union([
  z.object({
    type: z.literal("probe"),
    probe: z.string(),
    expr: z.string(),
    recheck_ms: z.number(),
    grace_ms: z.number(),
  }),
  z.object({
    type: z.literal("metric"),
    field: z.string(),
    op: z.string(),
    value: z.number(),
    recheck_ms: z.number(),
  }),
  z.object({ type: z.literal("producer_resolve"), ttl_ms: z.number() }),
  z.object({ type: z.literal("decay"), after_ms: z.number() }),
  z.object({ type: z.literal("manual"), owner: z.string().optional() }),
]);

const signalRecordSchema = z.object({
  id: z.string(),
  key: z.string(),
  schemaVersion: z.number(),
  kind: z.string(),
  producerType: z.string(),
  producerClass: z.string(),
  producerId: z.string(),
  scopeType: z.string(),
  scopeId: z.string(),
  targetSessions: z.array(z.string()).optional(),
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
  severity: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  evidence: jsonObjectSchema.optional(),
  clearWhen: clearWhenSchema,
  state: z.string(),
  previousState: z.string().optional(),
  dedupeKey: z.string().optional(),
  cooldownMs: z.number(),
  renotifyAfterMs: z.number(),
  escalateAfterMs: z.number().nullable().optional(),
  maxSurfaces: z.number(),
  ttlMs: z.number(),
  reopenAfterMs: z.number(),
  mutedUntil: z.number().nullable().optional(),
  muteReason: z.string().optional(),
  surfaceCount: z.number(),
  escalationCount: z.number(),
  openedAt: z.number(),
  lastSeenAt: z.number(),
  lastEvalAt: z.number().nullable().optional(),
  lastEvalError: z.string().nullable().optional(),
  clearSince: z.number().nullable().optional(),
  surfacedAt: z.number().nullable().optional(),
  acknowledgedAt: z.number().nullable().optional(),
  acknowledgedBy: z.string().nullable().optional(),
  closedAt: z.number().nullable().optional(),
  closeReason: z.string().nullable().optional(),
  version: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const signalEventSchema = z.object({
  id: z.number(),
  signalId: z.string(),
  type: z.string(),
  actorType: z.string().optional(),
  actorId: z.string().optional(),
  message: z.string().optional(),
  payload: jsonObjectSchema.optional(),
  createdAt: z.number(),
});

const signalMutationReturnSchema = z.object({
  status: z.string(),
  signal: signalRecordSchema,
  created: z.boolean().optional(),
  updated: z.boolean().optional(),
  suppressed: z.string().optional(),
});

const signalsListReturnSchema = z.object({
  total: z.number(),
  items: z.array(signalRecordSchema),
});

const signalBudgetSchema = z.object({
  day: z.string(),
  used: z.number(),
  limit: z.number(),
  held: z.number(),
});

const signalExplainReturnSchema = z.object({
  signal: signalRecordSchema,
  effectiveSeverity: z.string(),
  targetSessions: z.array(z.string()),
  clearRule: z.string(),
  lastEvaluation: z.object({
    at: z.number().nullable(),
    error: z.string().nullable(),
    cleared: z.boolean().nullable(),
    fields: jsonObjectSchema.optional(),
  }),
  budget: signalBudgetSchema,
  lastSurfaceAt: z.number().nullable(),
  lastOobAt: z.number().nullable(),
  keyMute: z
    .object({
      mutedUntil: z.number(),
      reason: z.string().optional(),
    })
    .nullable(),
  events: z.array(signalEventSchema),
});

const signalBudgetReturnSchema = z.object({
  budget: signalBudgetSchema,
});

const signalTickReturnSchema = z.object({
  executed: z.boolean(),
  evaluated: z.number(),
  resolved: z.number(),
  expired: z.number(),
  escalated: z.number(),
  errors: z.array(z.object({ id: z.string(), error: z.string() })),
  candidates: z.array(
    z.object({
      id: z.string(),
      route: z.string(),
      severity: z.string(),
      sessionName: z.string(),
    }),
  ),
  watchers: z.array(
    z.object({
      id: z.string(),
      raised: z.boolean(),
      resolved: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseEvidence(value: string | undefined): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--evidence must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--evidence must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseSubject(
  value: string | undefined,
): { subjectType: RaiseSignalInput["subjectType"]; subjectId: string } | undefined {
  if (!value?.trim()) return undefined;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("--subject must be <task|session|agent|contact|project>:<id>.");
  }
  const type = value.slice(0, separator);
  if (!["task", "session", "agent", "contact", "project"].includes(type)) {
    throw new Error("Invalid --subject type.");
  }
  return { subjectType: type as RaiseSignalInput["subjectType"], subjectId: value.slice(separator + 1) };
}

function parseTargetSessions(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseClearRule(options: {
  clearProbe?: string;
  clearExpr?: string;
  recheck?: string;
  grace?: string;
  clearMetric?: string;
  clearProducerResolve?: boolean;
  clearDecay?: string;
  clearManual?: boolean;
  ttl?: string;
}): ClearWhen {
  const modes = [
    Boolean(options.clearProbe) || Boolean(options.clearExpr),
    Boolean(options.clearMetric),
    Boolean(options.clearProducerResolve),
    Boolean(options.clearDecay),
    Boolean(options.clearManual),
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(
      "Provide exactly one clear rule: --clear-probe/--clear-expr, --clear-metric, --clear-producer-resolve, --clear-decay, or --clear-manual.",
    );
  }
  if (options.clearProbe || options.clearExpr) {
    if (!options.clearProbe || !options.clearExpr) {
      throw new Error("--clear-probe and --clear-expr are required together.");
    }
    return {
      type: "probe",
      probe: options.clearProbe,
      expr: options.clearExpr,
      recheck_ms: options.recheck ? parseDurationMs(options.recheck, "--recheck") : 5 * 60_000,
      grace_ms: options.grace ? parseDurationMs(options.grace, "--grace") : 0,
    };
  }
  if (options.clearMetric) {
    const metric = parseMetricSpec(options.clearMetric);
    return {
      type: "metric",
      field: metric.field,
      op: metric.op,
      value: metric.value,
      recheck_ms: options.recheck ? parseDurationMs(options.recheck, "--recheck") : 5 * 60_000,
    };
  }
  if (options.clearProducerResolve) {
    if (!options.ttl) throw new Error("--clear-producer-resolve requires --ttl.");
    return { type: "producer_resolve", ttl_ms: parseDurationMs(options.ttl, "--ttl") };
  }
  if (options.clearDecay) {
    return { type: "decay", after_ms: parseDurationMs(options.clearDecay, "--clear-decay") };
  }
  return { type: "manual" };
}

function humanSignal(signal: ReturnType<typeof findSignal>): void {
  if (!signal) return;
  console.log(`${signal.id}  ${signal.state}  ${signal.kind}/${signal.severity}  ${signal.key}`);
  console.log(`  ${signal.title}`);
  if (signal.detail) console.log(`  ${signal.detail}`);
  console.log(
    `  opened ${new Date(signal.openedAt).toISOString()} · surfaces ${signal.surfaceCount}/${signal.maxSurfaces}`,
  );
}

/**
 * The caller as the invocation resolved it (in-process tool or gateway
 * context first, then the runtime env), not the raw environment alone.
 */
function signalCaller(): { isAgent: boolean; sessionName: string | null } {
  const ctx = getContext();
  const isAgent = Boolean(
    ctx?.agentId?.trim() ||
      ctx?.context?.agentId?.trim() ||
      process.env.RAVI_AGENT_ID?.trim() ||
      process.env.RAVI_CONTEXT_KEY?.trim(),
  );
  const sessionName =
    ctx?.sessionName?.trim() ||
    ctx?.sessionKey?.trim() ||
    process.env.RAVI_SESSION_NAME?.trim() ||
    process.env.RAVI_SESSION_KEY?.trim() ||
    null;
  return { isAgent, sessionName };
}

/** A signal outside the caller session's scope is NOT_FOUND, like `list`. */
function findVisibleSignal(idOrKey: string) {
  const signal = findSignal(idOrKey);
  if (!signal) return null;
  const { sessionName } = signalCaller();
  if (sessionName && !signalIsInSessionScope(signal, readSessionSignalContext(sessionName))) return null;
  return signal;
}

function assertVisibleSignal(idOrKey: string) {
  if (!findVisibleSignal(idOrKey)) fail(`Signal not found: ${idOrKey}`);
}

@Group({
  name: "signals",
  description: "Durable world conditions with piggyback delivery",
  scope: "open",
})
export class SignalsCommands {
  @Command({ name: "raise", description: "Raise or refresh a signal" })
  @CommandAccess({ kind: "mutate", resource: "signals", action: "raise", risk: "medium" })
  @Returns(signalMutationReturnSchema)
  raise(
    @Arg("key", { description: "Stable condition key, e.g. host.disk.free" }) key: string,
    @Option({ flags: "--kind <fact|judgment>", description: "Producer species" }) kind: string,
    @Option({ flags: "--scope <scope>", description: "fleet or person|chat|project|agent:<id>" }) scope: string,
    @Option({ flags: "--title <title>", description: "One redacted line" }) title: string,
    @Option({ flags: "--severity <severity>", description: "ambient|piggyback|nudge|interrupt|page" })
    severity?: string,
    @Option({ flags: "--detail <text>", description: "Redacted context, max 500 chars" }) detail?: string,
    @Option({ flags: "--evidence <json>", description: "Structured observation JSON" }) evidence?: string,
    @Option({ flags: "--clear-probe <probe>", description: "Registered probe id" }) clearProbe?: string,
    @Option({ flags: "--clear-expr <expr>", description: "Probe clear expression" }) clearExpr?: string,
    @Option({ flags: "--recheck <duration>", description: "Probe recheck interval" }) recheck?: string,
    @Option({ flags: "--grace <duration>", description: "Clear grace window" }) grace?: string,
    @Option({ flags: "--clear-metric <spec>", description: "Metric clear rule, e.g. free_pct>=20" })
    clearMetric?: string,
    @Option({ flags: "--clear-producer-resolve", description: "Close when the producer resolves" })
    clearProducerResolve?: boolean,
    @Option({ flags: "--clear-decay <duration>", description: "Judgment decay window" }) clearDecay?: string,
    @Option({ flags: "--clear-manual", description: "Manual resolution only" }) clearManual?: boolean,
    @Option({ flags: "--cooldown <duration>", description: "Minimum gap between surfaces" }) cooldown?: string,
    @Option({ flags: "--renotify-after <duration>", description: "Re-surface gap after ack" }) renotifyAfter?: string,
    @Option({ flags: "--escalate-after <duration>", description: "Age before out-of-band escalation" })
    escalateAfter?: string,
    @Option({ flags: "--max-surfaces <n>", description: "Lifetime surface cap" }) maxSurfaces?: string,
    @Option({ flags: "--ttl <duration>", description: "Hard lifetime" }) ttl?: string,
    @Option({ flags: "--reopen-after <duration>", description: "Cooldown before the key may reopen" })
    reopenAfter?: string,
    @Option({ flags: "--dedupe-key <key>", description: "Producer event idempotency key" }) dedupeKey?: string,
    @Option({ flags: "--subject <type:id>", description: "Entity the signal is about" }) subject?: string,
    @Option({ flags: "--target-session <names>", description: "Comma-separated explicit target sessions" })
    targetSession?: string,
    @Option({ flags: "--source <source>", description: "Producer provenance" }) source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const scopeValue = normalizeScope(scope);
      const subjectValue = parseSubject(subject);
      const clearWhen = parseClearRule({
        clearProbe,
        clearExpr,
        recheck,
        grace,
        clearMetric,
        clearProducerResolve,
        clearDecay,
        clearManual,
        ttl,
      });
      if (kind !== "fact" && kind !== "judgment") {
        fail("Invalid --kind. Use fact|judgment.");
      }
      if (kind === "fact" && signalCaller().isAgent) {
        fail("Facts must be raised by code producers. Agent turns may raise judgment signals only.");
      }
      const producerId =
        source?.trim() || (process.env.RAVI_SESSION_KEY ? `session:${process.env.RAVI_SESSION_KEY}` : "cli:signals");
      const result = raiseSignal({
        key,
        kind,
        producerId,
        scopeType: scopeValue.scopeType,
        scopeId: scopeValue.scopeId,
        ...(subjectValue ?? {}),
        ...(severity ? { severity: normalizeSeverity(severity) } : {}),
        title: assertSignalTitle(title),
        ...(detail ? { detail } : {}),
        ...(evidence ? { evidence: parseEvidence(evidence) } : {}),
        clearWhen: validateClearWhen(clearWhen, kind === "fact" ? "fact" : "judgment"),
        ...(dedupeKey ? { dedupeKey } : {}),
        ...(cooldown ? { cooldownMs: parseDurationMs(cooldown, "--cooldown") } : {}),
        ...(renotifyAfter ? { renotifyAfterMs: parseDurationMs(renotifyAfter, "--renotify-after") } : {}),
        ...(escalateAfter ? { escalateAfterMs: parseDurationMs(escalateAfter, "--escalate-after") } : {}),
        ...(maxSurfaces ? { maxSurfaces: Number(maxSurfaces) } : {}),
        ...(ttl ? { ttlMs: parseDurationMs(ttl, "--ttl") } : {}),
        ...(reopenAfter ? { reopenAfterMs: parseDurationMs(reopenAfter, "--reopen-after") } : {}),
        ...(targetSession ? { targetSessions: parseTargetSessions(targetSession) } : {}),
      });
      const payload = {
        status: result.suppressed ? "suppressed" : result.created ? "created" : "updated",
        signal: result.signal,
        created: result.created,
        updated: result.updated,
        ...(result.suppressed ? { suppressed: result.suppressed } : {}),
      };
      if (asJson) printJson(payload);
      else {
        console.log(`${result.created ? "✓ raised" : "✓ updated"}: ${result.signal.id} (${result.signal.state})`);
        humanSignal(result.signal);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "update", description: "Update a non-terminal signal" })
  @CommandAccess({ kind: "mutate", resource: "signals", action: "update", risk: "low" })
  @Returns(signalMutationReturnSchema)
  update(
    @Arg("idOrKey", { description: "Signal id or key" }) idOrKey: string,
    @Option({ flags: "--severity <severity>", description: "New severity within producer ceiling" }) severity?: string,
    @Option({ flags: "--title <title>", description: "New title" }) title?: string,
    @Option({ flags: "--detail <text>", description: "New detail" }) detail?: string,
    @Option({ flags: "--evidence <json>", description: "New evidence JSON" }) evidence?: string,
    @Option({ flags: "--by <actor>", description: "Actor" }) by?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      assertVisibleSignal(idOrKey);
      const signal = updateSignal({
        idOrKey,
        ...(severity ? { severity: normalizeSeverity(severity) } : {}),
        ...(title ? { title } : {}),
        ...(detail ? { detail } : {}),
        ...(evidence ? { evidence: parseEvidence(evidence) } : {}),
        ...(by ? { by } : {}),
      });
      const payload = { status: "updated", signal };
      if (asJson) printJson(payload);
      else humanSignal(signal);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "list", description: "List signals" })
  @CommandAccess({ kind: "read", resource: "signals", action: "list", risk: "low" })
  @Returns(signalsListReturnSchema)
  list(
    @Option({ flags: "--state <state>", description: "State filter or non_terminal" }) state?: string,
    @Option({ flags: "--scope <scope>", description: "fleet or type:id" }) scope?: string,
    @Option({ flags: "--key <key>", description: "Exact key" }) key?: string,
    @Option({ flags: "--limit <n>", description: "Max rows" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Rows to skip" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsedScope = scope ? normalizeScope(scope) : undefined;
    if (state && state !== "non_terminal" && !(SIGNAL_STATES as readonly string[]).includes(state)) {
      fail(`Invalid --state: ${state}. Use ${SIGNAL_STATES.join("|")}|non_terminal.`);
    }
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      fail("--limit must be a positive integer.");
    }
    const parsedOffset = offset ? Number(offset) : undefined;
    if (parsedOffset !== undefined && (!Number.isInteger(parsedOffset) || parsedOffset < 0)) {
      fail("--offset must be a non-negative integer.");
    }
    const { sessionName } = signalCaller();
    const filters: Parameters<typeof listSignals>[0] = {
      ...(state ? { state: state === "non_terminal" ? "non_terminal" : (state as never) } : {}),
      ...(parsedScope ? { scopeType: parsedScope.scopeType, scopeId: parsedScope.scopeId } : {}),
      ...(key ? { key } : {}),
    };
    // A session sees only its scope; filter before paging so the page and
    // total count only visible rows.
    let visible: ReturnType<typeof listSignals>;
    if (sessionName) {
      const sessionContext = readSessionSignalContext(sessionName);
      const start = parsedOffset ?? 0;
      const inScope = listSignals({ ...filters, limit: 500 }).filter((item) =>
        signalIsInSessionScope(item, sessionContext),
      );
      visible = parsedLimit ? inScope.slice(start, start + parsedLimit) : inScope.slice(start);
    } else {
      visible = listSignals({
        ...filters,
        ...(parsedLimit ? { limit: parsedLimit } : {}),
        ...(parsedOffset ? { offset: parsedOffset } : {}),
      });
    }
    const payload = { total: visible.length, items: visible };
    if (asJson) printJson(payload);
    else if (visible.length === 0) console.log("No signals.");
    else
      for (const item of visible)
        console.log(`${item.id}  ${item.state}  ${item.kind}/${item.severity}  ${item.key}  ${item.title}`);
    return payload;
  }

  @Command({ name: "show", description: "Show one signal" })
  @CommandAccess({ kind: "read", resource: "signals", action: "show", risk: "low" })
  @Returns(z.object({ signal: signalRecordSchema }))
  show(
    @Arg("idOrKey", { description: "Signal id or key" }) idOrKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const signal = findVisibleSignal(idOrKey);
    if (!signal) fail(`Signal not found: ${idOrKey}`);
    if (asJson) printJson({ signal });
    else humanSignal(signal);
    return { signal };
  }

  @Command({ name: "ack", description: "Acknowledge a signal" })
  @CommandAccess({ kind: "mutate", resource: "signals", action: "ack", risk: "low" })
  @Returns(signalMutationReturnSchema)
  ack(
    @Arg("idOrKey", { description: "Signal id or key" }) idOrKey: string,
    @Option({ flags: "--note <text>", description: "Ack note" }) note?: string,
    @Option({ flags: "--by <actor>", description: "Actor, e.g. agent:main or operator:luis" }) by?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const target = findVisibleSignal(idOrKey);
      if (!target) fail(`Signal not found: ${idOrKey}`);
      if (signalCaller().isAgent && target.kind === "fact") {
        fail("Fact signals require operator acknowledgement. Agents may acknowledge judgments only.");
      }
      const signal = ackSignal({ idOrKey, ...(note ? { note } : {}), ...(by ? { by } : {}) });
      const payload = { status: "acknowledged", signal };
      if (asJson) printJson(payload);
      else console.log(`✓ acknowledged: ${signal.id}`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "resolve", description: "Resolve a signal with a reason" })
  @CommandAccess({ kind: "mutate", resource: "signals", action: "resolve", risk: "medium" })
  @Returns(signalMutationReturnSchema)
  resolve(
    @Arg("idOrKey", { description: "Signal id or key" }) idOrKey: string,
    @Option({ flags: "--reason <text>", description: "Resolution reason" }) reason: string,
    @Option({ flags: "--by <actor>", description: "Actor" }) by?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      assertVisibleSignal(idOrKey);
      const signal = resolveSignal({ idOrKey, reason, ...(by ? { by } : {}) });
      const payload = { status: "resolved", signal };
      if (asJson) printJson(payload);
      else console.log(`✓ resolved: ${signal.id}`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "mute", description: "Mute a signal for a duration" })
  @CommandAccess({ kind: "mutate", resource: "signals", action: "mute", risk: "low" })
  @Returns(signalMutationReturnSchema)
  mute(
    @Arg("idOrKey", { description: "Signal id or key" }) idOrKey: string,
    @Option({ flags: "--for <duration>", description: "Mute duration" }) duration: string,
    @Option({ flags: "--reason <text>", description: "Mute reason" }) reason?: string,
    @Option({ flags: "--by <actor>", description: "Actor" }) by?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      assertVisibleSignal(idOrKey);
      const signal = muteSignal({
        idOrKey,
        forMs: parseDurationMs(duration, "--for"),
        ...(reason ? { reason } : {}),
        ...(by ? { by } : {}),
      });
      const payload = { status: "muted", signal };
      if (asJson) printJson(payload);
      else console.log(`✓ muted: ${signal.id}`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "unmute", description: "Unmute a signal" })
  @CommandAccess({ kind: "mutate", resource: "signals", action: "unmute", risk: "low" })
  @Returns(signalMutationReturnSchema)
  unmute(
    @Arg("idOrKey", { description: "Signal id or key" }) idOrKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      assertVisibleSignal(idOrKey);
      const signal = unmuteSignal({ idOrKey });
      const payload = { status: "unmuted", signal };
      if (asJson) printJson(payload);
      else console.log(`✓ unmuted: ${signal.id}`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "mute-key", description: "Mute a key across reopenings" })
  @CommandAccess({ kind: "mutate", resource: "signals", action: "mute-key", risk: "low" })
  @Returns(z.object({ status: z.string(), key: z.string(), mutedUntil: z.number(), reason: z.string().optional() }))
  muteKey(
    @Arg("key", { description: "Signal key" }) key: string,
    @Option({ flags: "--for <duration>", description: "Mute duration" }) duration: string,
    @Option({ flags: "--reason <text>", description: "Mute reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const now = Date.now();
    const mutedUntil = now + parseDurationMs(duration, "--for");
    dbSetKeyMute(key, mutedUntil, reason, now);
    const payload = { status: "muted", key, mutedUntil, ...(reason ? { reason } : {}) };
    if (asJson) printJson(payload);
    else console.log(`✓ muted key ${key} until ${new Date(mutedUntil).toISOString()}`);
    return payload;
  }

  @Command({ name: "unmute-key", description: "Unmute a key" })
  @CommandAccess({ kind: "mutate", resource: "signals", action: "unmute-key", risk: "low" })
  @Returns(z.object({ status: z.string(), key: z.string() }))
  unmuteKey(
    @Arg("key", { description: "Signal key" }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    dbClearKeyMute(key);
    const payload = { status: "unmuted", key };
    if (asJson) printJson(payload);
    else console.log(`✓ unmuted key ${key}`);
    return payload;
  }

  @Command({ name: "tick", description: "Evaluate signals and escalate due ones" })
  @CommandAccess({
    kind: "mutate",
    resource: "signals",
    action: "tick",
    risk: "medium",
    requiresConfirmation: true,
  })
  @Returns(signalTickReturnSchema)
  async tick(
    @Option({ flags: "--execute", description: "Actually deliver out-of-band signals" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await tickSignals({ execute: execute === true });
    if (asJson) printJson(result);
    else {
      console.log(`signals tick (${result.executed ? "execute" : "dry-run"})`);
      console.log(
        `  evaluated ${result.evaluated} · resolved ${result.resolved} · expired ${result.expired} · escalated ${result.escalated}`,
      );
      for (const candidate of result.candidates)
        console.log(`  ${candidate.severity} ${candidate.id} -> ${candidate.sessionName}`);
      for (const error of result.errors) console.log(`  ! ${error.id}: ${error.error}`);
    }
    return result;
  }

  @Command({ name: "explain", description: "Explain why a signal is or is not visible" })
  @CommandAccess({ kind: "read", resource: "signals", action: "explain", risk: "low" })
  @Returns(signalExplainReturnSchema)
  explain(
    @Arg("idOrKey", { description: "Signal id or key" }) idOrKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertVisibleSignal(idOrKey);
    const explanation = explainSignal(idOrKey);
    if (!explanation) fail(`Signal not found: ${idOrKey}`);
    if (asJson) printJson(explanation);
    else {
      humanSignal(explanation.signal);
      console.log(`  effective: ${explanation.effectiveSeverity}`);
      console.log(`  targets: ${explanation.targetSessions.join(", ") || "(none)"}`);
      console.log(`  closes: ${explanation.clearRule}`);
      console.log(`  budget: ${explanation.budget.used}/${explanation.budget.limit}`);
      console.log(
        `  last surface: ${explanation.lastSurfaceAt ? new Date(explanation.lastSurfaceAt).toISOString() : "never"}`,
      );
      console.log(`  last oob: ${explanation.lastOobAt ? new Date(explanation.lastOobAt).toISOString() : "never"}`);
      if (explanation.keyMute)
        console.log(`  key mute until ${new Date(explanation.keyMute.mutedUntil).toISOString()}`);
    }
    return explanation;
  }

  @Command({ name: "budget", description: "Show the daily surface budget" })
  @CommandAccess({ kind: "read", resource: "signals", action: "budget", risk: "low" })
  @Returns(signalBudgetReturnSchema)
  budget(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const budget = getSignalBudget();
    const payload = { budget };
    if (asJson) printJson(payload);
    else console.log(`${budget.used}/${budget.limit} surfaces used on ${budget.day} (${budget.held} held)`);
    return payload;
  }
}
