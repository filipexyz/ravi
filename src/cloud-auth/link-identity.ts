import { getRuntimeContextFromEnv } from "../runtime/context-registry.js";
import type { ContextRecord } from "../router/router-db.js";
import { CloudAuthError } from "./errors.js";
import { parsePlatformIdentity } from "./actor-bindings.js";
import type { ActorPlatformIdentity } from "./types.js";

export interface AmbientLocalIdentity {
  contactId: string;
  actorPrincipal: string;
  platformIdentity: ActorPlatformIdentity | null;
  context: ContextRecord;
}

export function resolveAmbientLocalIdentity(
  env: NodeJS.ProcessEnv = process.env,
  context = getRuntimeContextFromEnv(env),
): AmbientLocalIdentity {
  if (!context) {
    throw new CloudAuthError(
      "CONTACT_REQUIRED",
      "ravi link must run inside a turn or session with a resolved contact. Do not pass a contact flag.",
    );
  }

  const metadata = asRecord(context.metadata) ?? {};
  const actor = asRecord(metadata.actor) ?? asRecord(metadata.actorMetadata) ?? {};
  const actorPrincipal = firstString(metadata.actorPrincipal, actor.actorPrincipal);
  const contactId = resolveContactId(actorPrincipal, metadata, actor);

  if (!contactId) {
    throw new CloudAuthError(
      "CONTACT_REQUIRED",
      "Current context has no resolved contact. Run this command from a turn or session with a contact; do not pass a contact flag.",
    );
  }

  const principal = actorPrincipal && actorPrincipal.startsWith("contact:") ? actorPrincipal : `contact:${contactId}`;
  if (!principal.startsWith("contact:")) {
    throw new CloudAuthError(
      "CONTACT_REQUIRED",
      `Current actor is ${principal}. ravi link requires actorPrincipal contact:<id>.`,
    );
  }

  return {
    contactId,
    actorPrincipal: principal,
    platformIdentity: parsePlatformIdentity({
      channel: firstString(actor.channel, metadata.channel, context.source?.channel),
      accountId: firstString(actor.accountId, metadata.accountId, context.source?.accountId),
      platformUserId: firstString(actor.platformUserId, actor.rawSenderId, metadata.rawSenderId),
      platformIdentityId: firstString(actor.platformIdentityId, metadata.platformIdentityId),
    }),
    context,
  };
}

function resolveContactId(
  actorPrincipal: string | null,
  metadata: Record<string, unknown>,
  actor: Record<string, unknown>,
): string | null {
  if (actorPrincipal?.startsWith("contact:")) {
    const id = actorPrincipal.slice("contact:".length).trim();
    if (id) return id;
  }
  return firstString(actor.contactId, metadata.contactId);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
