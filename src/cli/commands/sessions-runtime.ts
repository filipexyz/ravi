/**
 * Transparent runtime controls for active sessions.
 *
 * This is intentionally nested under sessions: Ravi sessions remain the user-facing
 * abstraction, while native runtime thread/turn ids are operational metadata.
 */

import "reflect-metadata";
import { Group, Command, CommandAccess, Arg, Option } from "../decorators.js";
import {
  CONTRACT_EXIT_ERROR,
  ContractError,
  contractDryRun,
  contractFail,
  renderContractError,
} from "../agent-contract.js";
import { fail } from "../context.js";
import { declareCommandReturns, runtimeControlReturnSchema } from "./operational-return-schemas.js";
import { requestReply } from "../../utils/request-reply.js";
import { resolveSession } from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "../../runtime/types.js";
import { getScopeContext, isScopeEnforced, canAccessSession, canModifySession } from "../../permissions/scope.js";
import {
  RUNTIME_CONTROL_FAILED,
  RUNTIME_CONTROL_TIMEOUT,
  RUNTIME_CONTROL_UNAVAILABLE,
  isRetryableRuntimeControlCode,
  runtimeControlCatalogCopy,
} from "../../runtime/runtime-control-errors.js";

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

/**
 * A missing session and a session the caller may not read (or, for mutating
 * controls, modify) get the same typed answer, so the refusal does not reveal
 * which sessions exist.
 */
function failControlSessionNotFound(op: string, ref: string, asJson: boolean | undefined): never {
  contractFail(op, "SESSION_NOT_FOUND", `Session not found: ${ref}`, {
    asJson,
    details: {
      suggestedAction:
        "List visible sessions with: ravi sessions list --json (mutating runtime controls also need modify access)",
    },
  });
}

function ensureSessionAccess(
  session: SessionEntry,
  access: "read" | "modify",
  original: string,
  op: string,
  asJson: boolean | undefined,
): void {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) {
    return;
  }

  const sessionName = session.name ?? session.sessionKey;
  const allowed =
    access === "modify" ? canModifySession(scopeCtx, sessionName) : canAccessSession(scopeCtx, sessionName);

  if (!allowed) {
    failControlSessionNotFound(op, original, asJson);
  }
}

function resolveControlSession(
  nameOrKey: string,
  access: "read" | "modify",
  op: string,
  asJson: boolean | undefined,
): SessionEntry {
  const session = resolveSession(nameOrKey);
  if (!session) {
    failControlSessionNotFound(op, nameOrKey, asJson);
  }
  ensureSessionAccess(session, access, nameOrKey, op, asJson);
  return session;
}

const RUNTIME_CONTROL_TURN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** A refused control as a typed contract error: code, catalog next step, bounded state. */
function runtimeControlContractError(op: string, result: RuntimeControlResult): ContractError {
  const code = result.code ?? RUNTIME_CONTROL_FAILED;
  const catalog = runtimeControlCatalogCopy(code);
  const details: Record<string, unknown> = {
    retryable: result.retryable ?? isRetryableRuntimeControlCode(code),
    suggestedAction: catalog?.suggestedAction ?? result.suggestedAction,
    operation: result.operation,
  };
  if (typeof result.state?.activeTurn === "boolean") details.activeTurn = result.state.activeTurn;
  if (result.state?.turnId && RUNTIME_CONTROL_TURN_ID_PATTERN.test(result.state.turnId)) {
    details.turnId = result.state.turnId;
  }
  if (result.disabledReason) details.disabledReason = result.disabledReason;
  return new ContractError(
    op,
    code,
    result.error ?? catalog?.message ?? `Runtime control failed: ${result.operation}`,
    CONTRACT_EXIT_ERROR,
    details,
  );
}

function printRuntimeControlResult(
  op: string,
  result: RuntimeControlResult,
  asJson: boolean | undefined,
  successMessage?: string,
): RuntimeControlResult {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (!result.ok) {
    const error = runtimeControlContractError(op, result);
    renderContractError(error, false);
    throw error;
  }

  if (successMessage) {
    console.log(successMessage);
  } else {
    console.log(JSON.stringify(result.data ?? {}, null, 2));
  }

  return result;
}

async function requestRuntimeControl(
  op: string,
  session: SessionEntry,
  request: RuntimeControlRequest,
  asJson: boolean | undefined,
): Promise<RuntimeControlResult> {
  let reply: RuntimeControlReply;
  try {
    reply = await requestReply<RuntimeControlReply>(
      RUNTIME_CONTROL_TOPIC,
      {
        sessionName: session.name,
        sessionKey: session.sessionKey,
        request,
      },
      RUNTIME_CONTROL_TIMEOUT_MS,
    );
  } catch (error) {
    // Timeout, NATS emit failure or a daemon `{ error }` reply: never surface the raw text.
    const timedOut = error instanceof Error && error.message.startsWith("Request timeout");
    const code = timedOut ? RUNTIME_CONTROL_TIMEOUT : RUNTIME_CONTROL_UNAVAILABLE;
    const catalog = runtimeControlCatalogCopy(code);
    contractFail(op, code, catalog?.message ?? "Runtime control request failed.", {
      asJson,
      details: { retryable: true, suggestedAction: catalog?.suggestedAction, operation: request.operation },
    });
  }

  if (!reply.result) {
    const catalog = runtimeControlCatalogCopy(RUNTIME_CONTROL_FAILED);
    contractFail(op, RUNTIME_CONTROL_FAILED, "Runtime control reply did not include a result.", {
      asJson,
      details: { suggestedAction: catalog?.suggestedAction, operation: request.operation },
    });
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
    const op = "sessions runtime list";
    const session = resolveControlSession(nameOrKey, "read", op, asJson);
    const result = await requestRuntimeControl(
      op,
      session,
      {
        operation: "thread.list",
        limit: limit ? parsePositiveInt(limit, 20) : null,
        cursor: cursor ?? null,
        cwd: cwd ?? null,
        searchTerm: searchTerm ?? null,
        archived: archived ?? null,
      },
      asJson,
    );

    return printRuntimeControlResult(op, result, asJson);
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
    const op = "sessions runtime read";
    const session = resolveControlSession(nameOrKey, "read", op, asJson);
    const result = await requestRuntimeControl(
      op,
      session,
      {
        operation: "thread.read",
        threadId,
        includeTurns: !summaryOnly,
      },
      asJson,
    );

    return printRuntimeControlResult(op, result, asJson);
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
    const op = "sessions runtime steer";
    const session = resolveControlSession(nameOrKey, "modify", op, asJson);
    const result = await requestRuntimeControl(
      op,
      session,
      {
        operation: "turn.steer",
        text,
        threadId,
        turnId,
        expectedTurnId,
      },
      asJson,
    );

    return printRuntimeControlResult(op, result, asJson, "Steered active runtime turn.");
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
    const op = "sessions runtime follow-up";
    const session = resolveControlSession(nameOrKey, "modify", op, asJson);
    const request: RuntimeControlRequest = {
      operation: "turn.follow_up",
      text,
      threadId,
      turnId,
      expectedTurnId,
    };
    if (execute !== true) {
      contractDryRun(op, buildRuntimeControlPlan(session, request), { asJson });
    }
    const result = await requestRuntimeControl(op, session, request, asJson);

    return printRuntimeControlResult(op, result, asJson, "Queued runtime follow-up.");
  }

  @Command({ name: "interrupt", description: "Interrupt the active runtime turn" })
  @CommandAccess({ kind: "mutate", resource: "sessions.runtime", action: "interrupt", risk: "high" })
  async interrupt(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Option({ flags: "--thread <id>", description: "Expected runtime thread id" }) threadId?: string,
    @Option({ flags: "--turn <id>", description: "Runtime turn id" }) turnId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "sessions runtime interrupt";
    const session = resolveControlSession(nameOrKey, "modify", op, asJson);
    const result = await requestRuntimeControl(
      op,
      session,
      {
        operation: "turn.interrupt",
        threadId,
        turnId,
      },
      asJson,
    );

    return printRuntimeControlResult(op, result, asJson, "Interrupt requested for active runtime turn.");
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
    const op = "sessions runtime rollback";
    const session = resolveControlSession(nameOrKey, "modify", op, asJson);
    const request: RuntimeControlRequest = {
      operation: "thread.rollback",
      threadId,
      numTurns: parsePositiveInt(turns, 1),
    };
    if (execute !== true) {
      contractDryRun(op, buildRuntimeControlPlan(session, request), { asJson });
    }
    const result = await requestRuntimeControl(op, session, request, asJson);

    return printRuntimeControlResult(op, result, asJson, "Rolled back runtime thread.");
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
    const op = "sessions runtime fork";
    const session = resolveControlSession(nameOrKey, "modify", op, asJson);
    const request: RuntimeControlRequest = {
      operation: "thread.fork",
      threadId,
      path: path ?? null,
      cwd: cwd ?? null,
    };
    if (execute !== true) {
      contractDryRun(op, buildRuntimeControlPlan(session, request), { asJson });
    }
    const result = await requestRuntimeControl(op, session, request, asJson);

    return printRuntimeControlResult(op, result, asJson);
  }
}

declareCommandReturns(SessionRuntimeCommands, {
  followUp: runtimeControlReturnSchema,
  fork: runtimeControlReturnSchema,
  interrupt: runtimeControlReturnSchema,
  list: runtimeControlReturnSchema,
  read: runtimeControlReturnSchema,
  rollback: runtimeControlReturnSchema,
  steer: runtimeControlReturnSchema,
});
