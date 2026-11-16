import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ContractError, stateNotReadyToContractError } from "../cli/agent-contract.js";
import { getContext } from "../cli/context.js";
import { assertStateSchemaReady, StateSchemaNotReadyError } from "../db/schema-owner.js";
import { assertDatabaseTargetAllowed } from "../db/state-boundary.js";
import { isStateNotReadyError } from "../db/state-readiness.js";
import { localOperatorCan } from "../permissions/provider-runtime.js";
import { getScopeContext, canAccessSession } from "../permissions/scope.js";
import { getRaviDbPath } from "../router/router-db.js";
import { resolveGhFollowContext, type GhWatchFollowContext } from "../hooks/gh-watch.js";
import { prError, PUBLICATION_CONTEXT_REQUIRED_MESSAGE } from "./contracts.js";

/** Only the authenticated runtime boundary supplies identity; never reconstruct it from the host. */
export function requirePublicationRuntimeContext() {
  const context = getContext({ localOnly: true });
  const record = context?.context;
  if (
    (context?.transport !== "gateway" && context?.transport !== "tool") ||
    !record?.contextId ||
    !record.agentId ||
    (!record.sessionKey && !record.sessionName)
  )
    throw prError("PERMISSION_DENIED", PUBLICATION_CONTEXT_REQUIRED_MESSAGE, {
      suggestedAction: "Run pr publish in an authorized Ravi session through the gateway/agent.",
    });
  return {
    ...context,
    context: record,
    contextId: record.contextId,
    agentId: record.agentId,
    sessionKey: record.sessionKey,
    sessionName: record.sessionName,
    source: record.source,
  };
}

export type PublicationRuntimeContext = ReturnType<typeof requirePublicationRuntimeContext>;

/**
 * Who is publishing.
 * - `session`: a Ravi session through the gateway/agent. Its identity comes
 *   from the authenticated runtime record and it publishes into itself.
 * - `terminal`: the operator's own terminal, with no runtime context behind
 *   it. It acts as the local operator and names the session that receives the
 *   CI follow.
 * A runtime context never becomes a terminal: one with no session is refused
 * (`requirePublicationRuntimeContext`), so it cannot name another session.
 */
export type PublicationCaller = { kind: "session"; context: PublicationRuntimeContext } | { kind: "terminal" };

export function resolvePublicationCaller(): PublicationCaller {
  const transport = getContext({ localOnly: true })?.transport;
  if (transport === "gateway" || transport === "tool") {
    return { kind: "session", context: requirePublicationRuntimeContext() };
  }
  return { kind: "terminal" };
}

/** The session store is not the one this release's daemon prepared: said with the command that prepares it. */
function sessionStoreNotPrepared(options?: ErrorOptions): Error {
  const notReady = new StateSchemaNotReadyError("router", { ...options, operatorCli: true });
  return stateNotReadyToContractError("pr publish", notReady) ?? notReady;
}

/**
 * The read-only handle both resolvers read sessions through. Publication never
 * creates or migrates runtime state, so the session store has to be the one the
 * installed daemon prepared for this release. A missing `ravi.db`, and one whose
 * router schema this release's daemon has not prepared, are refused as
 * `STATE_SCHEMA_NOT_READY` with the command that prepares them: neither is
 * read, and neither is reported as a missing session.
 */
function openPublicationState(): Database {
  const path = getRaviDbPath();
  if (!existsSync(path)) throw sessionStoreNotPrepared();
  const database = new Database(path, { readonly: true, create: false });
  try {
    assertStateSchemaReady(database, "router");
    return database;
  } catch (error) {
    database.close();
    // Only the readiness refusal is reworded for whoever is publishing; any other failure keeps its shape.
    if (!isStateNotReadyError(error)) throw error;
    throw sessionStoreNotPrepared({ cause: error });
  }
}

/** Validate live ownership without bootstrapping or migrating state during preview. */
export function resolvePublicationFollowContext(context: GhWatchFollowContext): GhWatchFollowContext {
  let database: Database | undefined;
  try {
    database = openPublicationState();
    const resolved = resolveGhFollowContext(context, database);
    const ref = resolved.sessionKey ?? resolved.sessionName;
    if (
      !resolved.agentId ||
      !ref ||
      !database.query("SELECT 1 FROM sessions WHERE session_key=? OR name=?").get(ref, ref)
    )
      throw new Error("Cannot register PR follow: durable session is missing.");
    return resolved;
  } catch (error) {
    // State the daemon has not prepared keeps its own code and recovery command.
    if (isStateNotReadyError(error)) throw error;
    throw prError(
      "PUBLICATION_SESSION_REQUIRED",
      error instanceof Error && error.message.startsWith("Cannot register PR follow:")
        ? error.message
        : "Cannot register PR follow: readable durable lifecycle state is required.",
    );
  } finally {
    database?.close();
  }
}

/**
 * Where the publication's CI follow reports. Read-only even in a fresh
 * installation: preview must not bootstrap the runtime database.
 *
 * A session publishes into itself; `--reply-session`, when given, must be that
 * session. The operator's terminal has no session, so it must name one. That
 * is a destination and grants no authority: the authority is the local
 * operator's own admin access.
 */
export function resolvePublicationContext(replySession?: string): GhWatchFollowContext {
  const caller = resolvePublicationCaller();
  const reply = replySession?.trim();
  let target: string;
  if (caller.kind === "session") {
    const { sessionKey, sessionName } = caller.context;
    if (reply && reply !== sessionKey && reply !== sessionName)
      throw prError("USAGE_ERROR", "A session publication follows in its own session; omit --reply-session.", {}, 2);
    target = (sessionKey ?? sessionName)!;
  } else {
    if (!reply)
      throw prError(
        "PUBLICATION_SESSION_REQUIRED",
        "Name the session whose chat receives the CI follow: --reply-session <session>.",
        { suggestedAction: "Rerun with --reply-session <session>; `ravi sessions list` shows the sessions." },
        2,
      );
    if (!localOperatorCan("admin", "system", "*"))
      throw prError(
        "PERMISSION_DENIED",
        "Publishing from a terminal takes the local operator's admin access; --reply-session names a destination and grants no authority.",
      );
    target = reply;
  }
  if (!canAccessSession(getScopeContext(), target))
    throw prError("SESSION_NOT_FOUND", "Publishing session is unavailable in this scope.");
  const contextSource = caller.kind === "session" ? caller.context.source : undefined;
  let database: Database | undefined;
  try {
    // The session is read from runtime state, which a checkout or worktree never reaches.
    assertDatabaseTargetAllowed(getRaviDbPath());
    database = openPublicationState();
    const row = database
      .query(`SELECT session_key,name,agent_id,last_channel,last_account_id,last_to,last_thread_id
      FROM sessions WHERE session_key=? OR name=?`)
      .get(target, target) as {
      session_key: string;
      name: string | null;
      agent_id: string;
      last_channel: string | null;
      last_account_id: string | null;
      last_to: string | null;
      last_thread_id: string | null;
    } | null;
    if (!row) throw prError("SESSION_NOT_FOUND", "Publishing session is unavailable in this scope.");
    const source = contextSource
      ? contextSource
      : row.last_channel && row.last_account_id && row.last_to
        ? {
            channel: row.last_channel,
            accountId: row.last_account_id,
            chatId: row.last_to,
            ...(row.last_thread_id ? { threadId: row.last_thread_id } : {}),
          }
        : undefined;
    if (!source)
      throw prError("PUBLICATION_SESSION_REQUIRED", "The publishing session has no chat destination for CI follow.");
    return {
      agentId: row.agent_id,
      sessionKey: row.session_key,
      sessionName: row.name ?? row.session_key,
      accountId: source.accountId,
      source,
    };
  } catch (error) {
    // A ContractError keeps its code; the STATE_SCHEMA_NOT_READY refusal of the open above is one.
    if (error instanceof ContractError) throw error;
    throw prError("PUBLICATION_SESSION_REQUIRED", "A readable Ravi session database is required for publication.");
  } finally {
    database?.close();
  }
}
