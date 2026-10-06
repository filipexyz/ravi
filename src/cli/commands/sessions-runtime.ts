/**
 * Transparent runtime controls for active sessions.
 *
 * This is intentionally nested under sessions: Ravi sessions remain the user-facing
 * abstraction, while native runtime thread/turn ids are operational metadata.
 */

import "reflect-metadata";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option } from "../decorators.js";
import { contractDryRun } from "../agent-contract.js";
import { fail } from "../context.js";
import {
  declareCommandReturns,
  runtimeThreadForkReturnSchema,
  runtimeThreadListReturnSchema,
  runtimeThreadReadReturnSchema,
  runtimeThreadRollbackReturnSchema,
  runtimeTurnFollowUpReturnSchema,
  runtimeTurnInterruptReturnSchema,
  runtimeTurnSteerReturnSchema,
} from "./operational-return-schemas.js";
import { requestReply } from "../../utils/request-reply.js";
import { resolveSession } from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import type {
  RuntimeControlOperation,
  RuntimeControlRequest,
  RuntimeControlResult,
  RuntimeControlState,
} from "../../runtime/types.js";
import { getScopeContext, isScopeEnforced, canAccessSession, canModifySession } from "../../permissions/scope.js";

const RUNTIME_CONTROL_TOPIC = "ravi.session.runtime.control";
const RUNTIME_CONTROL_TIMEOUT_MS = 15_000;

interface RuntimeControlReply {
  result?: RuntimeControlResult;
}

function parsePositiveInt(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function ensureSessionAccess(session: SessionEntry, access: "read" | "modify", original: string): void {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) {
    return;
  }

  const sessionName = session.name ?? session.sessionKey;
  const allowed =
    access === "modify" ? canModifySession(scopeCtx, sessionName) : canAccessSession(scopeCtx, sessionName);

  if (!allowed) {
    fail(`Session not found: ${original}`);
  }
}

function resolveControlSession(nameOrKey: string, access: "read" | "modify"): SessionEntry {
  const session = resolveSession(nameOrKey);
  if (!session) {
    fail(`Session not found: ${nameOrKey}`);
  }
  ensureSessionAccess(session, access, nameOrKey);
  return session;
}

type RuntimeThreadSummary = z.infer<typeof runtimeThreadListReturnSchema>["threads"][number];
type RuntimeTurnSummary = z.infer<typeof runtimeThreadReadReturnSchema>["turns"][number];

interface RuntimeControlEnvelope {
  ok: boolean;
  provider: string | null;
  state: z.infer<typeof runtimeThreadListReturnSchema>["state"];
  error: string | null;
}

const nonEmptyTextSchema = z.string().trim().min(1);

function requireNonEmpty(value: string, label: string): string {
  if (!nonEmptyTextSchema.safeParse(value).success) {
    fail(`Expected non-empty ${label}.`);
  }
  return value;
}

function optionalNonEmpty(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : requireNonEmpty(value, label);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusString(value: unknown): string | null {
  return firstString(value, asRecord(value)?.type);
}

function normalizeRuntimeState(state: RuntimeControlState | undefined): RuntimeControlEnvelope["state"] {
  if (!state) return null;
  return {
    provider: state.provider,
    threadId: state.threadId ?? null,
    turnId: state.turnId ?? null,
    activeTurn: state.activeTurn ?? null,
    supportedOperations: [...(state.supportedOperations ?? [])],
  };
}

function runtimeControlEnvelope(result: RuntimeControlResult): RuntimeControlEnvelope {
  const state = normalizeRuntimeState(result.state);
  return {
    ok: result.ok,
    provider: state?.provider ?? null,
    state,
    error: result.error ?? null,
  };
}

function normalizeRuntimeThread(value: unknown): RuntimeThreadSummary | null {
  const thread = asRecord(value);
  const threadId = firstString(thread?.id, thread?.threadId, thread?.sessionId);
  if (!thread || !threadId) return null;
  return {
    threadId,
    title: firstString(thread.name, thread.title),
    preview: firstString(thread.preview),
    status: statusString(thread.status),
    cwd: firstString(thread.cwd),
    path: firstString(thread.path),
    createdAt: finiteNumber(thread.createdAt),
    updatedAt: finiteNumber(thread.updatedAt),
  };
}

function normalizeRuntimeTurn(value: unknown): RuntimeTurnSummary | null {
  const turn = asRecord(value);
  const turnId = firstString(turn?.id, turn?.turnId);
  if (!turn || !turnId) return null;
  return {
    turnId,
    status: statusString(turn.status),
    startedAt: finiteNumber(turn.startedAt),
    completedAt: finiteNumber(turn.completedAt),
  };
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}

/** Pi wraps its native RPC reply as `{ response }`; other providers return fields directly. */
function providerResponse(data: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(data?.response);
}

function normalizeThreadList(result: RuntimeControlResult) {
  const data = asRecord(result.data);
  const threads = Array.isArray(data?.threads) ? data.threads : Array.isArray(data?.data) ? data.data : [];
  return {
    ...runtimeControlEnvelope(result),
    operation: "thread.list" as const,
    threads: compact(threads.map(normalizeRuntimeThread)),
    nextCursor: firstString(data?.nextCursor, data?.next_cursor),
  };
}

function normalizeThreadRead(result: RuntimeControlResult) {
  const data = asRecord(result.data);
  const rawThread = asRecord(data?.thread);
  const turns = Array.isArray(rawThread?.turns) ? rawThread.turns : Array.isArray(data?.turns) ? data.turns : [];
  return {
    ...runtimeControlEnvelope(result),
    operation: "thread.read" as const,
    thread: normalizeRuntimeThread(rawThread),
    turns: compact(turns.map(normalizeRuntimeTurn)),
  };
}

function normalizeTurnInputAck<TOperation extends "turn.steer" | "turn.follow_up">(
  result: RuntimeControlResult,
  operation: TOperation,
) {
  const data = asRecord(result.data);
  const response = providerResponse(data);
  return {
    ...runtimeControlEnvelope(result),
    operation,
    accepted: result.ok && data?.accepted !== false && response?.success !== false,
    queued: data?.queued === true || response?.queued === true || asRecord(response?.data)?.queued === true,
    threadId: firstString(data?.threadId, result.state?.threadId),
    turnId: firstString(data?.turnId, data?.expectedTurnId, result.state?.turnId),
  };
}

function normalizeTurnInterrupt(result: RuntimeControlResult) {
  const data = asRecord(result.data);
  const response = providerResponse(data);
  const interrupted = typeof data?.interrupted === "boolean" ? data.interrupted : response?.success !== false;
  return {
    ...runtimeControlEnvelope(result),
    operation: "turn.interrupt" as const,
    interrupted: result.ok && interrupted,
    pending: result.ok && data?.pending === true,
    threadId: firstString(data?.threadId, result.state?.threadId),
    turnId: firstString(data?.turnId, result.state?.turnId),
  };
}

function normalizeThreadRollback(result: RuntimeControlResult) {
  const data = asRecord(result.data);
  const rolledBackTurns = finiteNumber(data?.rolledBackTurns);
  return {
    ...runtimeControlEnvelope(result),
    operation: "thread.rollback" as const,
    thread: normalizeRuntimeThread(data?.thread),
    rolledBackTurns: rolledBackTurns !== null && Number.isSafeInteger(rolledBackTurns) ? rolledBackTurns : null,
  };
}

function normalizeThreadFork(result: RuntimeControlResult, request: RuntimeControlRequest) {
  const data = asRecord(result.data);
  const thread = normalizeRuntimeThread(data?.thread);
  return {
    ...runtimeControlEnvelope(result),
    operation: "thread.fork" as const,
    sourceThreadId: firstString(request.threadId, result.state?.threadId),
    forkedThreadId: thread?.threadId ?? null,
    thread,
  };
}

const RUNTIME_CONTROL_RETURN_SCHEMAS: Partial<Record<RuntimeControlOperation, z.ZodTypeAny>> = {
  "thread.list": runtimeThreadListReturnSchema,
  "thread.read": runtimeThreadReadReturnSchema,
  "turn.steer": runtimeTurnSteerReturnSchema,
  "turn.follow_up": runtimeTurnFollowUpReturnSchema,
  "turn.interrupt": runtimeTurnInterruptReturnSchema,
  "thread.rollback": runtimeThreadRollbackReturnSchema,
  "thread.fork": runtimeThreadForkReturnSchema,
};

function printRuntimeControlResult<T extends RuntimeControlEnvelope & { operation: RuntimeControlOperation }>(
  payload: T,
  asJson: boolean | undefined,
  successMessage?: string,
): T {
  // Fail at the CLI boundary if normalization ever drifts from the declared contract.
  RUNTIME_CONTROL_RETURN_SCHEMAS[payload.operation]?.parse(payload);
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  if (!payload.ok) {
    fail(payload.error ?? `Runtime control failed: ${payload.operation}`);
  }

  if (successMessage) {
    console.log(successMessage);
  } else {
    const { ok: _ok, provider: _provider, state: _state, error: _error, operation: _operation, ...details } = payload;
    console.log(JSON.stringify(details, null, 2));
  }

  return payload;
}

async function requestRuntimeControl(
  session: SessionEntry,
  request: RuntimeControlRequest,
): Promise<RuntimeControlResult> {
  const reply = await requestReply<RuntimeControlReply>(
    RUNTIME_CONTROL_TOPIC,
    {
      sessionName: session.name,
      sessionKey: session.sessionKey,
      request,
    },
    RUNTIME_CONTROL_TIMEOUT_MS,
  );

  if (!reply.result) {
    fail("Runtime control reply did not include a result.");
  }

  return reply.result;
}

function buildRuntimeControlPlan(session: SessionEntry, request: RuntimeControlRequest): Record<string, unknown> {
  const plan = {
    session: session.name ?? session.sessionKey,
    operation: request.operation,
    threadId: request.threadId ?? null,
  };

  switch (request.operation) {
    case "turn.follow_up":
      return {
        ...plan,
        turnId: request.turnId ?? null,
        expectedTurnId: request.expectedTurnId ?? null,
        textLength: request.text?.length ?? 0,
      };
    case "thread.rollback":
      return { ...plan, numTurns: request.numTurns ?? 1 };
    case "thread.fork":
      return { ...plan, hasPath: Boolean(request.path), hasCwd: Boolean(request.cwd) };
    default:
      return plan;
  }
}

@Group({
  name: "sessions.runtime",
  description: "Transparent controls for active session runtimes",
  scope: "admin",
})
export class SessionRuntimeCommands {
  @Command({ name: "list", description: "List runtime threads through an active session" })
  @CommandAccess({ kind: "read", resource: "sessions.runtime", action: "list", risk: "low" })
  async list(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Option({ flags: "--limit <count>", description: "Maximum number of threads to return" }) limit?: string,
    @Option({ flags: "--cursor <cursor>", description: "Pagination cursor" }) cursor?: string,
    @Option({ flags: "--cwd <path>", description: "Filter by Codex working directory" }) cwd?: string,
    @Option({ flags: "--search <term>", description: "Search runtime thread text" }) searchTerm?: string,
    @Option({ flags: "--archived", description: "Only include archived threads" }) archived?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "read");
    const result = await requestRuntimeControl(session, {
      operation: "thread.list",
      limit: limit ? parsePositiveInt(limit, 20) : null,
      cursor: cursor ?? null,
      cwd: cwd ?? null,
      searchTerm: searchTerm ?? null,
      archived: archived ?? null,
    });

    return printRuntimeControlResult(normalizeThreadList(result), asJson);
  }

  @Command({ name: "read", description: "Read a runtime thread through an active session" })
  @CommandAccess({ kind: "read", resource: "sessions.runtime", action: "read", risk: "low" })
  async read(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Arg("threadId", { description: "Runtime thread id; defaults to current thread", required: false })
    threadId?: string,
    @Option({ flags: "--summary-only", description: "Do not include runtime turns" }) summaryOnly?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "read");
    const result = await requestRuntimeControl(session, {
      operation: "thread.read",
      threadId: optionalNonEmpty(threadId, "thread id"),
      includeTurns: !summaryOnly,
    });

    return printRuntimeControlResult(normalizeThreadRead(result), asJson);
  }

  @Command({ name: "steer", description: "Steer the active runtime turn" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.runtime",
    action: "steer",
    risk: "high",
    redactions: ["text"],
  })
  async steer(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Arg("text", { description: "Steering text to append to the active turn" }) text: string,
    @Option({ flags: "--thread <id>", description: "Expected runtime thread id" }) threadId?: string,
    @Option({ flags: "--turn <id>", description: "Runtime turn id" }) turnId?: string,
    @Option({ flags: "--expected-turn <id>", description: "Expected active runtime turn id" }) expectedTurnId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "modify");
    const result = await requestRuntimeControl(session, {
      operation: "turn.steer",
      text: requireNonEmpty(text, "steering text"),
      threadId: optionalNonEmpty(threadId, "thread id"),
      turnId: optionalNonEmpty(turnId, "turn id"),
      expectedTurnId: optionalNonEmpty(expectedTurnId, "expected turn id"),
    });

    return printRuntimeControlResult(
      normalizeTurnInputAck(result, "turn.steer"),
      asJson,
      "Steered active runtime turn.",
    );
  }

  @Command({ name: "follow-up", description: "Queue a follow-up after the active runtime turn" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.runtime",
    action: "follow-up",
    risk: "high",
    redactions: ["text"],
    requiresConfirmation: true,
  })
  async followUp(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Arg("text", { description: "Follow-up text to run after the active turn" }) text: string,
    @Option({ flags: "--thread <id>", description: "Expected runtime thread id" }) threadId?: string,
    @Option({ flags: "--turn <id>", description: "Runtime turn id" }) turnId?: string,
    @Option({ flags: "--expected-turn <id>", description: "Expected active runtime turn id" }) expectedTurnId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually queue the follow-up; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "modify");
    const request: RuntimeControlRequest = {
      operation: "turn.follow_up",
      text: requireNonEmpty(text, "follow-up text"),
      threadId: optionalNonEmpty(threadId, "thread id"),
      turnId: optionalNonEmpty(turnId, "turn id"),
      expectedTurnId: optionalNonEmpty(expectedTurnId, "expected turn id"),
    };
    if (execute !== true) {
      contractDryRun("sessions runtime follow-up", buildRuntimeControlPlan(session, request), { asJson });
    }
    const result = await requestRuntimeControl(session, request);

    return printRuntimeControlResult(
      normalizeTurnInputAck(result, "turn.follow_up"),
      asJson,
      "Queued runtime follow-up.",
    );
  }

  @Command({ name: "interrupt", description: "Interrupt the active runtime turn" })
  @CommandAccess({ kind: "mutate", resource: "sessions.runtime", action: "interrupt", risk: "high" })
  async interrupt(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Option({ flags: "--thread <id>", description: "Expected runtime thread id" }) threadId?: string,
    @Option({ flags: "--turn <id>", description: "Runtime turn id" }) turnId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "modify");
    const result = await requestRuntimeControl(session, {
      operation: "turn.interrupt",
      threadId: optionalNonEmpty(threadId, "thread id"),
      turnId: optionalNonEmpty(turnId, "turn id"),
    });

    return printRuntimeControlResult(
      normalizeTurnInterrupt(result),
      asJson,
      "Interrupt requested for active runtime turn.",
    );
  }

  @Command({ name: "rollback", description: "Rollback completed runtime turns" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.runtime",
    action: "rollback",
    risk: "destructive",
    requiresConfirmation: true,
  })
  async rollback(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Arg("turns", { description: "Number of completed turns to rollback", required: false }) turns?: string,
    @Option({ flags: "--thread <id>", description: "Runtime thread id; defaults to current thread" }) threadId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually roll back runtime turns; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "modify");
    const request: RuntimeControlRequest = {
      operation: "thread.rollback",
      threadId: optionalNonEmpty(threadId, "thread id"),
      numTurns: parsePositiveInt(turns, 1),
    };
    if (execute !== true) {
      contractDryRun("sessions runtime rollback", buildRuntimeControlPlan(session, request), { asJson });
    }
    const result = await requestRuntimeControl(session, request);

    return printRuntimeControlResult(normalizeThreadRollback(result), asJson, "Rolled back runtime thread.");
  }

  @Command({ name: "fork", description: "Fork a runtime thread if the provider supports it" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.runtime",
    action: "fork",
    risk: "high",
    redactions: ["path", "cwd"],
    requiresConfirmation: true,
  })
  async fork(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Arg("threadId", { description: "Runtime thread id; defaults to current thread", required: false })
    threadId?: string,
    @Option({ flags: "--path <path>", description: "Runtime fork path" }) path?: string,
    @Option({ flags: "--cwd <path>", description: "Working directory for the fork" }) cwd?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually fork the runtime thread; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "modify");
    const request: RuntimeControlRequest = {
      operation: "thread.fork",
      threadId: optionalNonEmpty(threadId, "thread id"),
      path: path ?? null,
      cwd: cwd ?? null,
    };
    if (execute !== true) {
      contractDryRun("sessions runtime fork", buildRuntimeControlPlan(session, request), { asJson });
    }
    const result = await requestRuntimeControl(session, request);

    return printRuntimeControlResult(normalizeThreadFork(result, request), asJson);
  }
}

declareCommandReturns(SessionRuntimeCommands, {
  followUp: runtimeTurnFollowUpReturnSchema,
  fork: runtimeThreadForkReturnSchema,
  interrupt: runtimeTurnInterruptReturnSchema,
  list: runtimeThreadListReturnSchema,
  read: runtimeThreadReadReturnSchema,
  rollback: runtimeThreadRollbackReturnSchema,
  steer: runtimeTurnSteerReturnSchema,
});
