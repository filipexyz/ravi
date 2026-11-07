import { Database } from "bun:sqlite";
import { ContractError } from "../cli/agent-contract.js";
import { getContext } from "../cli/context.js";
import { getScopeContext, canAccessSession } from "../permissions/scope.js";
import { localOperatorCan } from "../permissions/provider-runtime.js";
import { getRaviDbPath } from "../router/router-db.js";
import { resolveGhFollowContext, type GhWatchFollowContext } from "../hooks/gh-watch.js";
import { prError } from "./contracts.js";

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
export function resolvePublicationContext(replySession?: string): GhWatchFollowContext {
  const context = getContext();
  const current = context?.sessionKey ?? context?.sessionName;
  if (current && replySession && replySession !== current && replySession !== context?.sessionName)
    throw prError("USAGE_ERROR", "A session publication follows in its own session; omit --reply-session.", {}, 2);
  const target = current ?? replySession;
  if (!target || (!current && !localOperatorCan("admin", "system", "*")))
    throw prError(
      "PUBLICATION_SESSION_REQUIRED",
      "Publish through an authenticated gateway context in the publishing session; --reply-session alone does not authenticate a bare operator terminal.",
    );
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
    const source =
      current && context?.source
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
