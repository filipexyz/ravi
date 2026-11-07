import { Database } from "bun:sqlite";
import { ContractError } from "../cli/agent-contract.js";
import { getContext } from "../cli/context.js";
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

/** Validate live ownership without bootstrapping or migrating state during preview. */
export function resolvePublicationFollowContext(context: GhWatchFollowContext): GhWatchFollowContext {
  let database: Database | undefined;
  try {
    database = new Database(getRaviDbPath(), { readonly: true, create: false });
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

/** Read-only even in a fresh installation: preview must not bootstrap the runtime database. */
export function resolvePublicationContext(): GhWatchFollowContext {
  const context = requirePublicationRuntimeContext();
  const target = (context.sessionKey ?? context.sessionName)!;
  if (!canAccessSession(getScopeContext(), target))
    throw prError("SESSION_NOT_FOUND", "Publishing session is unavailable in this scope.");
  let database: Database | undefined;
  try {
    database = new Database(getRaviDbPath(), { readonly: true, create: false });
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
    const source = context.source
      ? context.source
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
    if (error instanceof ContractError) throw error;
    throw prError("PUBLICATION_SESSION_REQUIRED", "A readable Ravi session database is required for publication.");
  } finally {
    database?.close();
  }
}
