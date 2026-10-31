import { getContactDetails } from "../contacts.js";
import {
  dbFindChat,
  dbGetChat,
  dbGetThreadParentChat,
  type ChatRecord,
  type ContextCapability,
} from "../router/router-db.js";
import { canonicalTagSlugsForAsset } from "../tags/helpers.js";
import { dbFindTagBindings, dbGetTagDefinition } from "../tags/tag-db.js";
import type { TagDefinition } from "../tags/types.js";
import {
  dbListContactChatGrants,
  dbListContactChatGrantsCoveringChat,
  type ContactChatGrant,
} from "./contact-chat-grants.js";
import { PERMISSION_TAG_PREFIX, normalizePermissionTag } from "./permission-tags.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

const ADMIN_CONTACT_TAGS = new Set(["permission-admin", "permission-owner", "permission-superadmin"]);
const PERMISSION_TAG_SOURCE = "permissions";
const ADMIN_CAPABILITY = "admin:system:*";

export const USER_OVERLAY_AUTHORIZATION_MODE = "user-overlay";

export const contactPolicyPermissionsProvider: PermissionProvider = {
  id: "contact-policy-permissions",
  version: "contact-tags/v2",
  required: true,
  supports() {
    return false;
  },
  authorize(request) {
    return notApplicableDecision(request);
  },
  materializeCapabilities(subject, options) {
    if (subject.type !== "contact") return [];
    const compartmentId = cleanString(options?.compartmentId);
    if (compartmentId && (options?.compartmentType === "chat" || options?.compartmentType === "dm")) {
      return resolveContactChatOverlay({ contactId: subject.id, chatId: compartmentId }).capabilities;
    }
    return materializeContactPolicyCapabilities(subject.id);
  },
};

/**
 * Unscoped (global) contact capabilities from provider-owned permission tags.
 * Chat-scoped grants never appear here; they only materialize with a chat.
 */
export function materializeContactPolicyCapabilities(contactId: string): ContextCapability[] {
  const details = getContactDetails(contactId);
  const policy = details?.policy;
  if (!policy || policy.status !== "allowed" || policy.optOut) return [];
  return dedupeCapabilities(materializeGlobalTagCapabilities(contactId, policy.tags));
}

export interface PermissionChatScope {
  /** Canonical chat the grants are keyed on. For a thread this is its container chat. */
  chatId: string;
  requestedChatId: string;
  /** Present when `requestedChatId` is a thread inside `chatId`. */
  threadChatId?: string;
  chatTags: string[];
  known: boolean;
}

export type ContactGrantScope =
  | { type: "chat"; chatId: string }
  | { type: "chat_tag"; chatTag: string }
  | { type: "global" };

export interface ContactProfileGrant {
  contactId: string;
  profile: string;
  scope: ContactGrantScope;
  source: "contact-chat-grant" | "contact-tag";
  capabilities: string[];
}

export interface ContactChatOverlay {
  /** True when any contact grant covers this chat; only then does the overlay gate the turn. */
  active: boolean;
  contactId: string;
  scope: PermissionChatScope;
  eligible: boolean;
  grants: ContactProfileGrant[];
  capabilities: ContextCapability[];
}

export function resolvePermissionChatScope(
  chatRef: string,
  hint: { channel?: string | null; instanceId?: string | null } = {},
): PermissionChatScope {
  const requestedChatId = chatRef.trim();
  const chat = findChat(requestedChatId, hint);
  if (!chat) {
    return {
      chatId: requestedChatId,
      requestedChatId,
      chatTags: canonicalTagSlugsForAsset("chat", requestedChatId),
      known: false,
    };
  }
  const parent = dbGetThreadParentChat(chat);
  const container = parent ?? chat;
  return {
    chatId: container.id,
    requestedChatId,
    ...(parent ? { threadChatId: chat.id } : {}),
    chatTags: canonicalTagSlugsForAsset("chat", container.id),
    known: true,
  };
}

export function isUserOverlayActiveForChat(scope: Pick<PermissionChatScope, "chatId" | "chatTags">): boolean {
  return dbListContactChatGrantsCoveringChat({ chatId: scope.chatId, chatTags: scope.chatTags }).length > 0;
}

/**
 * contact_chat_caps for one contact in one chat: direct chat grants, grants on
 * tags the chat carries, and global contact permission tags. The runtime
 * intersects these with the executor agent ceiling only when `active`.
 */
export function resolveContactChatOverlay(input: {
  contactId: string;
  chatId: string;
  channel?: string | null;
  instanceId?: string | null;
}): ContactChatOverlay {
  const scope = resolvePermissionChatScope(input.chatId, { channel: input.channel, instanceId: input.instanceId });
  const active = isUserOverlayActiveForChat(scope);
  const details = getContactDetails(input.contactId);
  const contactId = details?.contact.id ?? input.contactId;
  const policy = details?.policy ?? null;
  const eligible = Boolean(details) && policy?.status !== "blocked" && policy?.optOut !== true;
  if (!eligible) {
    return { active, contactId, scope, eligible, grants: [], capabilities: [] };
  }

  const scopedGrants = dbListContactChatGrantsCoveringChat({
    chatId: scope.chatId,
    chatTags: scope.chatTags,
    contactId,
  }).map(toContactProfileGrant);
  // Global permission tags keep the legacy tag-policy gate; explicit chat grants only need eligibility.
  const globalGrants = policy?.status === "allowed" ? globalProfileGrantsFromTags(contactId, policy.tags) : [];
  const grants = [...scopedGrants, ...globalGrants];
  const capabilities = grants.flatMap((grant) =>
    grant.capabilities.flatMap((value) => {
      const capability = normalizeCapabilityInput(value);
      return capability ? [{ ...capability, source: grantCapabilitySource(grant) }] : [];
    }),
  );
  return { active, contactId, scope, eligible, grants, capabilities: dedupeCapabilities(capabilities) };
}

/** Every chat-scoped and tag-scoped grant, optionally filtered. */
export function listContactScopedProfileGrants(
  query: { contactId?: string; scope?: ContactGrantScope } = {},
): ContactProfileGrant[] {
  const scopeQuery =
    query.scope?.type === "chat"
      ? { scopeType: "chat" as const, scopeId: query.scope.chatId }
      : query.scope?.type === "chat_tag"
        ? { scopeType: "chat_tag" as const, scopeId: query.scope.chatTag }
        : {};
  return dbListContactChatGrants({ ...(query.contactId ? { contactId: query.contactId } : {}), ...scopeQuery }).map(
    toContactProfileGrant,
  );
}

/** Grants covering a chat (direct + chat tags), across contacts unless filtered. */
export function listContactProfileGrantsCoveringChat(
  scope: Pick<PermissionChatScope, "chatId" | "chatTags">,
  contactId?: string,
): ContactProfileGrant[] {
  return dbListContactChatGrantsCoveringChat({
    chatId: scope.chatId,
    chatTags: scope.chatTags,
    ...(contactId ? { contactId } : {}),
  }).map(toContactProfileGrant);
}

/** Global (unscoped) grants: provider-owned permission tags attached to contacts. */
export function listContactGlobalProfileGrants(contactId?: string): ContactProfileGrant[] {
  if (contactId) {
    const details = getContactDetails(contactId);
    return globalProfileGrantsFromTags(details?.contact.id ?? contactId, details?.policy?.tags ?? []);
  }
  const tagsByContact = new Map<string, string[]>();
  for (const binding of dbFindTagBindings({ assetType: "contact" })) {
    if (!binding.tagSlug.startsWith(PERMISSION_TAG_PREFIX)) continue;
    tagsByContact.set(binding.assetId, [...(tagsByContact.get(binding.assetId) ?? []), binding.tagSlug]);
  }
  return [...tagsByContact.entries()].flatMap(([id, tags]) => globalProfileGrantsFromTags(id, tags));
}

export function formatContactGrantScope(scope: ContactGrantScope): string {
  if (scope.type === "chat") return `chat:${scope.chatId}`;
  if (scope.type === "chat_tag") return `chat-tag:${scope.chatTag}`;
  return "global";
}

export function readProfileCapabilityStrings(profileSlug: string): string[] {
  if (ADMIN_CONTACT_TAGS.has(profileSlug)) return [ADMIN_CAPABILITY];
  const definition = dbGetTagDefinition(profileSlug);
  if (!isPermissionTagDefinition(definition)) return [];
  return readPermissionTagCapabilities(definition).map(formatCapability);
}

function findChat(chatRef: string, hint: { channel?: string | null; instanceId?: string | null }): ChatRecord | null {
  if (!chatRef) return null;
  const direct = dbGetChat(chatRef);
  if (direct) return direct;
  const channel = cleanString(hint.channel);
  if (!channel) return null;
  return dbFindChat({ channel, instanceId: cleanString(hint.instanceId), platformChatId: chatRef });
}

function toContactProfileGrant(grant: ContactChatGrant): ContactProfileGrant {
  return {
    contactId: grant.contactId,
    profile: grant.profileSlug,
    scope:
      grant.scopeType === "chat"
        ? { type: "chat", chatId: grant.scopeId }
        : { type: "chat_tag", chatTag: grant.scopeId },
    source: "contact-chat-grant",
    capabilities: readProfileCapabilityStrings(grant.profileSlug),
  };
}

function globalProfileGrantsFromTags(contactId: string, rawTags: readonly string[]): ContactProfileGrant[] {
  const tags = [...new Set(rawTags.map(normalizePermissionTag).filter((tag): tag is string => Boolean(tag)))];
  return tags.flatMap((tag) => {
    if (!tag.startsWith(PERMISSION_TAG_PREFIX)) return [];
    const capabilities = readProfileCapabilityStrings(tag);
    if (capabilities.length === 0) return [];
    return [
      {
        contactId,
        profile: tag,
        scope: { type: "global" as const },
        source: "contact-tag" as const,
        capabilities,
      },
    ];
  });
}

function grantCapabilitySource(grant: ContactProfileGrant): string {
  if (grant.scope.type === "global") {
    return ADMIN_CONTACT_TAGS.has(grant.profile)
      ? `contact-policy:contact:${grant.contactId}:admin-tag`
      : `contact-policy:contact:${grant.contactId}:tag:${grant.profile}`;
  }
  return `contact-policy:contact:${grant.contactId}:${formatContactGrantScope(grant.scope)}:profile:${grant.profile}`;
}

function materializeGlobalTagCapabilities(contactId: string, rawTags: readonly string[]): ContextCapability[] {
  return globalProfileGrantsFromTags(contactId, rawTags).flatMap((grant) =>
    grant.capabilities.flatMap((value) => {
      const capability = normalizeCapabilityInput(value);
      return capability ? [{ ...capability, source: grantCapabilitySource(grant) }] : [];
    }),
  );
}

/** Provider-owned permission tags a contact carries, in normalized form. */
export function contactPermissionPolicyTags(contactId: string): string[] {
  const tags = getContactDetails(contactId)?.policy?.tags ?? [];
  return [
    ...new Set(
      tags.map(normalizePermissionTag).filter((tag): tag is string => Boolean(tag?.startsWith(PERMISSION_TAG_PREFIX))),
    ),
  ];
}

function isPermissionTagDefinition(definition: TagDefinition | null): definition is TagDefinition {
  return Boolean(definition && definition.kind === "system" && definition.source === PERMISSION_TAG_SOURCE);
}

function readPermissionTagCapabilities(definition: TagDefinition): Array<Omit<ContextCapability, "source">> {
  const metadata = definition.metadata;
  if (!isRecord(metadata)) return [];

  const permissions = isRecord(metadata.permissions) ? metadata.permissions : metadata;
  const values = Array.isArray(permissions.capabilities)
    ? permissions.capabilities
    : Array.isArray(metadata.permissionCapabilities)
      ? metadata.permissionCapabilities
      : [];
  return values.flatMap((value) => {
    const capability = normalizeCapabilityInput(value);
    return capability ? [capability] : [];
  });
}

function normalizeCapabilityInput(value: unknown): Omit<ContextCapability, "source"> | null {
  if (typeof value === "string") {
    const parts = value.split(":");
    if (parts.length < 3) return null;
    const [permission, objectType, ...objectIdParts] = parts;
    return normalizeCapabilityObject({
      permission,
      objectType,
      objectId: objectIdParts.join(":"),
    });
  }
  if (isRecord(value)) {
    return normalizeCapabilityObject(value);
  }
  return null;
}

function normalizeCapabilityObject(value: Record<string, unknown>): Omit<ContextCapability, "source"> | null {
  const permission = cleanString(value.permission);
  const objectType = cleanString(value.objectType);
  const objectId = cleanString(value.objectId);
  if (!permission || !objectType || !objectId) return null;
  return { permission, objectType, objectId };
}

function formatCapability(capability: Omit<ContextCapability, "source">): string {
  return `${capability.permission}:${capability.objectType}:${capability.objectId}`;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function dedupeCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  const seen = new Set<string>();
  const result: ContextCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.permission}:${capability.objectType}:${capability.objectId}:${capability.source ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

function notApplicableDecision(request: PermissionProviderRequest): PermissionProviderDecision {
  return {
    decision: "not_applicable",
    allowed: false,
    providerId: contactPolicyPermissionsProvider.id,
    providerVersion: contactPolicyPermissionsProvider.version,
    reasonCode: "contact_policy_permissions_materializer_only",
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    ...(request.subject ? { subject: request.subject } : {}),
  };
}
