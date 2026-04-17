/**
 * Transparent runtime controls for active sessions.
 *
 * This is intentionally nested under sessions: Ravi sessions remain the user-facing
 * abstraction, while native runtime thread/turn ids are operational metadata.
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { requestReply } from "../../utils/request-reply.js";
import { resolveSession } from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "../../runtime/types.js";
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

function printRuntimeControlResult(
  result: RuntimeControlResult,
  asJson: boolean | undefined,
  successMessage?: string,
): RuntimeControlResult {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (!result.ok) {
    fail(result.error ?? `Runtime control failed: ${result.operation}`);
  }

  if (successMessage) {
    console.log(successMessage);
  } else {
    console.log(JSON.stringify(result.data ?? {}, null, 2));
  }

  return result;
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

@Group({
  name: "sessions.runtime",
  description: "Transparent controls for active session runtimes",
  scope: "admin",
})
export class SessionRuntimeCommands {
  @Command({ name: "list", description: "List runtime threads through an active session" })
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

    return printRuntimeControlResult(result, asJson);
  }

  @Command({ name: "read", description: "Read a runtime thread through an active session" })
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
      threadId,
      includeTurns: !summaryOnly,
    });

    return printRuntimeControlResult(result, asJson);
  }

  @Command({ name: "steer", description: "Steer the active runtime turn" })
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
      text,
      threadId,
      turnId,
      expectedTurnId,
    });

    return printRuntimeControlResult(result, asJson, "Steered active runtime turn.");
  }

  @Command({ name: "interrupt", description: "Interrupt the active runtime turn" })
  async interrupt(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Option({ flags: "--thread <id>", description: "Expected runtime thread id" }) threadId?: string,
    @Option({ flags: "--turn <id>", description: "Runtime turn id" }) turnId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "modify");
    const result = await requestRuntimeControl(session, {
      operation: "turn.interrupt",
      threadId,
      turnId,
    });

    return printRuntimeControlResult(result, asJson, "Interrupt requested for active runtime turn.");
  }

  @Command({ name: "rollback", description: "Rollback completed runtime turns" })
  async rollback(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Arg("turns", { description: "Number of completed turns to rollback", required: false }) turns?: string,
    @Option({ flags: "--thread <id>", description: "Runtime thread id; defaults to current thread" }) threadId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "modify");
    const result = await requestRuntimeControl(session, {
      operation: "thread.rollback",
      threadId,
      numTurns: parsePositiveInt(turns, 1),
    });

    return printRuntimeControlResult(result, asJson, "Rolled back runtime thread.");
  }

  @Command({ name: "fork", description: "Fork a runtime thread if the provider supports it" })
  async fork(
    @Arg("session", { description: "Ravi session name or key" }) nameOrKey: string,
    @Arg("threadId", { description: "Runtime thread id; defaults to current thread", required: false })
    threadId?: string,
    @Option({ flags: "--path <path>", description: "Runtime fork path" }) path?: string,
    @Option({ flags: "--cwd <path>", description: "Working directory for the fork" }) cwd?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = resolveControlSession(nameOrKey, "modify");
    const result = await requestRuntimeControl(session, {
      operation: "thread.fork",
      threadId,
      path: path ?? null,
      cwd: cwd ?? null,
    });

    return printRuntimeControlResult(result, asJson);
  }
}
