/**
 * `ravi link` / `ravi unlink` for the author of the current chat message.
 *
 * Runs in the daemon (the CLI forwards over the gateway with the turn's
 * context). The person approves the link in the Console with their own
 * login; this side only asks, delivers the private link and records where to
 * confirm. Outputs never carry the approval URL, tokens, emails or ids.
 */

import type { resolveOutboundAccount } from "../channels/account-resolution.js";
import { ConsoleApiClient, getMeWithAutoRefresh, refreshCredentialsForStore } from "../cloud-auth/client.js";
import {
  deleteCachedActorBinding,
  readActorBindingForActiveLogin,
  writeCachedActorBinding,
} from "../cloud-auth/actor-bindings.js";
import { CloudAuthError, isCloudAuthError } from "../cloud-auth/errors.js";
import { resolveLinkRequester, type LinkRequester } from "../cloud-auth/link-identity.js";
import {
  deleteCloudCredentials,
  persistMeIntoCredentials,
  readCloudCredentials,
  shouldPersistHydratedIdentity,
  writeCloudCredentials,
} from "../cloud-auth/storage.js";
import type { ActorBinding, CloudCredentials } from "../cloud-auth/types.js";
import type { ContextRecord } from "../router/router-db.js";
import { dbGetContext, dbUpdateContextRuntimeState } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import {
  createChannelLinkMessenger,
  linkRequestDmText,
  resolveLinkDmRoute,
  type LinkDmRoute,
  type LinkMessenger,
} from "./link-dm.js";
import {
  completeLocalLinkRequest,
  insertLocalLinkRequest,
  listPendingLocalLinkRequestsForContact,
} from "./link-requests-db.js";
import { clearContactLinkState, enterAwaitingDm } from "./link-states-db.js";

const log = logger.child("identity:link");

export interface IdentityLinkDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
  messenger?: LinkMessenger;
  /** Account lookup for the private-message route; defaults to the live channel config. */
  resolveAccount?: typeof resolveOutboundAccount;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export type IdentityLinkResult =
  | { success: true; status: "already_linked"; linked: true }
  | { success: true; status: "dm_sent"; linked: false; expiresAt: string }
  /** WhatsApp from a group: the person must write to the agent in private, where Ravi sends the link. */
  | { success: true; status: "awaiting_dm"; linked: false };

export interface IdentityLinkOptions {
  /**
   * Console just refused a write for this person (`ACTOR_NOT_LINKED`), so a
   * cached binding is stale: it is dropped instead of answering
   * `already_linked`.
   */
  refusedByConsole?: boolean;
}

export interface IdentityUnlinkResult {
  success: true;
  status: "unlinked" | "not_linked";
  linked: false;
}

export async function requestIdentityLink(
  context: ContextRecord | null | undefined,
  deps: IdentityLinkDeps = {},
  options: IdentityLinkOptions = {},
): Promise<IdentityLinkResult> {
  const requester = resolveLinkRequester(context);
  const route = resolveLinkDmRoute(requester, deps.resolveAccount);
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  if (route.startsConversation) {
    // On WhatsApp the agent never starts a conversation: the person writes in
    // private, and the daemon answers that message with the link.
    if (options.refusedByConsole) {
      deleteCachedActorBinding(requester.contactId, env);
    } else if (readActorBindingForActiveLogin(requester.contactId, env)) {
      return { success: true, status: "already_linked", linked: true };
    }
    enterAwaitingDm({
      contactId: requester.contactId,
      channel: route.channel,
      accountId: route.accountId,
      agentId: context?.agentId ?? null,
      displayName: requester.displayName,
      origin: requester.origin,
      now: now(),
    });
    return { success: true, status: "awaiting_dm", linked: false };
  }

  const sent = await sendLinkRequest(requester, route, deps);
  if (sent.status === "already_linked") applyBindingToContext(context, sent.binding.consoleUserId, sent.binding.orgId);
  return sent.status === "already_linked"
    ? { success: true, status: "already_linked", linked: true }
    : { success: true, status: "dm_sent", linked: false, expiresAt: sent.expiresAt };
}

export type SentLinkRequest =
  | { status: "already_linked"; binding: ActorBinding }
  | { status: "dm_sent"; requestId: string; expiresAt: string; expiresAtMs: number; dmChatId: string };

/**
 * Ask the Console for a link request for `requester` and deliver its approval
 * link privately on `route`. A person already linked gets their binding
 * cached instead.
 */
export async function sendLinkRequest(
  requester: LinkRequester,
  route: LinkDmRoute,
  deps: IdentityLinkDeps = {},
  options: { answeringDm?: boolean } = {},
): Promise<SentLinkRequest> {
  const messenger = deps.messenger ?? createChannelLinkMessenger();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  return withCloudSession(deps, async (client, credentials) => {
    const expectedEmail = await messenger.lookupEmail(route);
    const created = await client.createLinkRequest(
      {
        contactId: requester.contactId,
        platformIdentities: requester.platformIdentity,
        requester: requester.displayName ? { displayName: requester.displayName } : null,
        expectedEmail,
      },
      credentials.accessToken,
    );

    if (created.status === "already_linked") {
      writeCachedActorBinding(created.binding, env);
      supersedeLocalRequests(requester.contactId, "cancelled");
      return { status: "already_linked", binding: created.binding };
    }

    const expiresAtMs = Date.parse(created.request.expiresAt);
    const expiresInMinutes = Math.max(1, Math.round((expiresAtMs - now()) / 60_000));
    let dmChatId: string;
    try {
      const delivered = await messenger.send(
        { channel: route.channel, accountId: route.accountId, chatId: route.recipient },
        linkRequestDmText({
          approveUrl: created.approveUrl,
          channel: route.channel,
          displayName: requester.displayName,
          expiresInMinutes,
          ...(options.answeringDm ? { answeringDm: true } : {}),
        }),
        { privateLink: true },
      );
      dmChatId = delivered.chatId;
    } catch (error) {
      log.warn("Link request DM failed", {
        requestId: created.request.id,
        channel: route.channel,
        error: errorText(error),
      });
      await client.cancelLinkRequest(created.request.id, credentials.accessToken).catch(() => undefined);
      throw new CloudAuthError("LINK_DM_FAILED", "Ravi could not send the private message to the person who asked.");
    }

    try {
      // Console replaced any earlier pending request for this person; mirror that locally.
      supersedeLocalRequests(requester.contactId, "cancelled");
      insertLocalLinkRequest({
        id: created.request.id,
        consoleUrl: credentials.consoleUrl,
        installationId: credentials.installationId,
        contactId: requester.contactId,
        displayName: requester.displayName,
        origin: requester.origin,
        dm: { channel: route.channel, accountId: route.accountId, chatId: dmChatId },
        expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : now() + 10 * 60_000,
        now: now(),
      });
    } catch (error) {
      // Without the local row nobody would watch the request, so it must not stay approvable.
      log.warn("Link request persistence failed", { requestId: created.request.id, error: errorText(error) });
      await client.cancelLinkRequest(created.request.id, credentials.accessToken).catch(() => undefined);
      throw error;
    }
    return {
      status: "dm_sent",
      requestId: created.request.id,
      expiresAt: created.request.expiresAt,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : now() + 10 * 60_000,
      dmChatId,
    };
  });
}

export async function unlinkIdentity(
  context: ContextRecord | null | undefined,
  deps: IdentityLinkDeps = {},
): Promise<IdentityUnlinkResult> {
  const requester = resolveLinkRequester(context);
  const env = deps.env ?? process.env;

  return withCloudSession(deps, async (client, credentials) => {
    for (const pending of listPendingLocalLinkRequestsForContact(requester.contactId)) {
      if (completeLocalLinkRequest(pending.id, "cancelled")) {
        await client.cancelLinkRequest(pending.id, credentials.accessToken).catch(() => undefined);
      }
    }

    const result = await client.unlinkActorBinding({ contactId: requester.contactId }, credentials.accessToken);
    deleteCachedActorBinding(requester.contactId, env);
    clearContactLinkState(requester.contactId);
    clearBindingFromContext(context);
    return { success: true, status: result.binding ? "unlinked" : "not_linked", linked: false };
  });
}

/**
 * Run `fn` with the daemon's active Console session (the operator's
 * `ravi login`), refreshing once on an expired token. The session is only the
 * transport: the Console binds the contact to whoever approves in the browser.
 */
export async function withCloudSession<T>(
  deps: Pick<IdentityLinkDeps, "client" | "readCredentials" | "writeCredentials" | "deleteCredentials" | "env">,
  fn: (client: ConsoleApiClient, credentials: CloudCredentials) => Promise<T>,
): Promise<T> {
  const env = deps.env ?? process.env;
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const del = deps.deleteCredentials ?? deleteCloudCredentials;
  const stored = read(env);
  if (!stored) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login` first.");
  }

  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: stored.consoleUrl });
  const store = {
    client,
    write: (credentials: CloudCredentials) => write(credentials, env),
    delete: () => del(env),
  };
  const session = await getMeWithAutoRefresh({ ...store, credentials: stored });
  let credentials = persistMeIntoCredentials(session.credentials, session.me);
  if (shouldPersistHydratedIdentity(session.credentials, credentials)) {
    write(credentials, env);
  }

  try {
    return await fn(client, credentials);
  } catch (error) {
    if (!(isCloudAuthError(error) && error.code === "AUTH_EXPIRED")) throw error;
    credentials = await refreshCredentialsForStore({ ...store, credentials });
    return fn(client, credentials);
  }
}

function supersedeLocalRequests(contactId: string, status: "cancelled"): void {
  for (const pending of listPendingLocalLinkRequestsForContact(contactId)) {
    completeLocalLinkRequest(pending.id, status);
  }
}

function applyBindingToContext(
  context: ContextRecord | null | undefined,
  consoleUserId: string,
  consoleOrgId: string,
): void {
  if (!context) return;
  try {
    const current = dbGetContext(context.contextId);
    if (!current) return;
    updateContextMetadata(current, { ...(current.metadata ?? {}), consoleUserId, consoleOrgId });
  } catch {
    // Best effort: the next turn reads the binding cache anyway.
  }
}

function clearBindingFromContext(context: ContextRecord | null | undefined): void {
  if (!context) return;
  try {
    const current = dbGetContext(context.contextId);
    if (!current?.metadata) return;
    const next = { ...current.metadata };
    delete next.consoleUserId;
    delete next.consoleOrgId;
    updateContextMetadata(current, next);
  } catch {
    // Best effort: the cache entry is already gone.
  }
}

/**
 * Replace only the context's metadata. The runtime-state update writes
 * session name and source too, clearing whichever is omitted, and the live
 * turn context needs both: without its session name, the private-DM check
 * fails and the rest of the turn reads Pages as public only.
 */
function updateContextMetadata(current: ContextRecord, metadata: Record<string, unknown>): void {
  dbUpdateContextRuntimeState(current.contextId, {
    sessionName: current.sessionName,
    source: current.source,
    metadata,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
