import { ConsoleApiClient, getMeWithAutoRefresh } from "../../cloud-auth/client.js";
import { deleteCachedActorBinding, writeCachedActorBinding } from "../../cloud-auth/actor-bindings.js";
import { CloudAuthError, isCloudAuthError } from "../../cloud-auth/errors.js";
import { resolveAmbientLocalIdentity } from "../../cloud-auth/link-identity.js";
import { redactCloudAuthPayload } from "../../cloud-auth/redaction.js";
import {
  persistMeIntoCredentials,
  readCloudCredentials,
  shouldPersistHydratedIdentity,
  writeCloudCredentials,
  deleteCloudCredentials,
} from "../../cloud-auth/storage.js";
import type { ActorBinding, CloudCredentials, ConsoleMeResponse } from "../../cloud-auth/types.js";
import { dbGetContext, dbUpdateContextRuntimeState } from "../../router/router-db.js";

export interface LinkCommandOptions {
  json?: boolean;
}

export interface LinkCommandDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
  resolveLocalIdentity?: typeof resolveAmbientLocalIdentity;
  env?: NodeJS.ProcessEnv;
}

export async function runLink(options: LinkCommandOptions = {}, deps: LinkCommandDeps = {}) {
  const { local, binding, idempotent } = await upsertAmbientBinding(deps);
  applyBindingToContext(local.context.contextId, binding);

  const payload = {
    success: true,
    linked: true,
    idempotent,
    binding: safeBinding(binding),
    console: {
      userId: binding.consoleUserId,
      orgId: binding.orgId,
      installationId: binding.installationId,
    },
    local: {
      actorPrincipal: local.actorPrincipal,
      contactId: local.contactId,
      platformIdentity: local.platformIdentity,
    },
  };

  printPayload(payload, options.json, () => {
    console.log(`✓ Linked ${local.actorPrincipal} to Console user ${binding.consoleUserId}`);
    console.log(`Organization: ${binding.orgId}`);
    console.log(`Installation: ${binding.installationId}`);
  });
  return payload;
}

export async function runUnlink(options: LinkCommandOptions = {}, deps: LinkCommandDeps = {}) {
  const session = await requireCloudSession(deps);
  const local = (deps.resolveLocalIdentity ?? resolveAmbientLocalIdentity)(deps.env ?? process.env);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: session.credentials.consoleUrl });

  try {
    await client.unlinkActorBinding(
      { contactId: local.contactId, installationId: session.credentials.installationId },
      session.credentials.accessToken,
    );
  } catch (error) {
    if (!(isCloudAuthError(error) && error.status === 404)) {
      throw error;
    }
  }

  deleteCachedActorBinding(local.contactId, deps.env ?? process.env);
  clearBindingFromContext(local.context.contextId);

  const payload = {
    success: true,
    unlinked: true,
    contactId: local.contactId,
    actorPrincipal: local.actorPrincipal,
    consoleUserId: session.me.user?.id ?? session.credentials.user?.id ?? null,
    orgId: session.me.organization?.id ?? session.credentials.organization?.id ?? null,
  };

  printPayload(payload, options.json, () => {
    console.log(`✓ Unlinked ${local.actorPrincipal} from the current Console session`);
  });
  return payload;
}

async function upsertAmbientBinding(deps: LinkCommandDeps): Promise<{
  credentials: CloudCredentials;
  me: ConsoleMeResponse;
  local: ReturnType<typeof resolveAmbientLocalIdentity>;
  binding: ActorBinding;
  idempotent: boolean;
}> {
  const session = await requireCloudSession(deps);
  const local = (deps.resolveLocalIdentity ?? resolveAmbientLocalIdentity)(deps.env ?? process.env);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: session.credentials.consoleUrl });
  const consoleUserId = requireConsoleUserId(session);
  const orgId = requireCloudSessionOrg(session);

  const input = {
    contactId: local.contactId,
    actorPrincipal: local.actorPrincipal,
    installationId: session.credentials.installationId,
    orgId,
    platformIdentity: local.platformIdentity,
  };

  let binding: ActorBinding;
  let idempotent = false;
  try {
    binding = await client.upsertActorBinding(input, session.credentials.accessToken);
  } catch (error) {
    if (isCloudAuthError(error) && error.code === "ACTOR_BINDING_CONFLICT") {
      const existing = await client.resolveActorBinding(
        { contactId: local.contactId, installationId: session.credentials.installationId },
        session.credentials.accessToken,
      );
      if (existing && existing.consoleUserId === consoleUserId) {
        binding = existing;
        idempotent = true;
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  writeCachedActorBinding(binding, deps.env ?? process.env);
  return {
    credentials: session.credentials,
    me: session.me,
    local,
    binding,
    idempotent,
  };
}

async function requireCloudSession(deps: LinkCommandDeps): Promise<{
  credentials: CloudCredentials;
  me: ConsoleMeResponse;
}> {
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const del = deps.deleteCredentials ?? deleteCloudCredentials;
  const env = deps.env ?? process.env;
  const stored = read(env);
  if (!stored) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login` first.");
  }

  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: stored.consoleUrl });
  const result = await getMeWithAutoRefresh({
    client,
    credentials: stored,
    write: (credentials) => write(credentials, env),
    delete: () => del(env),
  });
  const hydrated = persistMeIntoCredentials(result.credentials, result.me);
  if (shouldPersistHydratedIdentity(result.credentials, hydrated)) {
    write(hydrated, env);
  }
  return { credentials: hydrated, me: result.me };
}

function requireConsoleUserId(session: { credentials: CloudCredentials; me: ConsoleMeResponse }): string {
  const userId = session.me.user?.id ?? session.credentials.user?.id;
  if (!userId?.trim()) {
    throw new CloudAuthError(
      "CREDENTIALS_INVALID",
      "Console session did not include a user id. Run `ravi login` again.",
    );
  }
  return userId.trim();
}

function requireCloudSessionOrg(session: { credentials: CloudCredentials; me: ConsoleMeResponse }): string {
  const orgId = session.me.organization?.id ?? session.me.org?.id ?? session.credentials.organization?.id;
  if (!orgId?.trim()) {
    throw new CloudAuthError(
      "ORG_ACCESS_DENIED",
      "Console session has no organization. Installation enrollment split is a follow-up; ravi link currently requires the cloud session org.",
    );
  }
  return orgId.trim();
}

function applyBindingToContext(contextId: string, binding: ActorBinding): void {
  try {
    const current = dbGetContext(contextId);
    if (!current) return;
    dbUpdateContextRuntimeState(contextId, {
      metadata: {
        ...(current.metadata ?? {}),
        consoleUserId: binding.consoleUserId,
        consoleOrgId: binding.orgId,
      },
    });
  } catch {
    // Context updates are best-effort; Console + local cache remain source of truth.
  }
}

function clearBindingFromContext(contextId: string): void {
  try {
    const current = dbGetContext(contextId);
    if (!current?.metadata) return;
    const next = { ...current.metadata };
    delete next.consoleUserId;
    delete next.consoleOrgId;
    dbUpdateContextRuntimeState(contextId, { metadata: next });
  } catch {
    // Best-effort local metadata cleanup.
  }
}

function safeBinding(binding: ActorBinding) {
  return {
    id: binding.id ?? null,
    contactId: binding.contactId,
    actorPrincipal: binding.actorPrincipal,
    consoleUserId: binding.consoleUserId,
    orgId: binding.orgId,
    installationId: binding.installationId,
    platformIdentity: binding.platformIdentity ?? null,
  };
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    console.log(JSON.stringify(redactCloudAuthPayload(payload), null, 2));
    return;
  }
  printHuman();
}
