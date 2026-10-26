/**
 * What a Slack permission-denial card may grant.
 *
 * The metadata is computed once, server-side, when the approval request is
 * created, and stored on the request. A click carries only an intent and a
 * scope value; both are validated against this record, never trusted from the
 * Slack payload.
 */

import type { ApprovalRequestRecord } from "./store.js";
import { buildAuditContextProvenance } from "../permissions/audit-provenance.js";
import {
  isGrantScopeValueShape,
  resolveGrantScopeRef,
  type PermissionGrantIntent,
  type PermissionGrantScopeRef,
  type PermissionGrantScopeValue,
} from "../permissions/apply-grant.js";
import { resolvePermissionChatScope } from "../permissions/contact-policy-permissions-provider.js";
import type { ContextRecord } from "../router/router-db.js";

export interface PermissionGrantCapability {
  readonly permission: string;
  readonly objectType: string;
  readonly objectId: string;
}

export interface PermissionGrantTargets {
  readonly contactId?: string;
  readonly chatId?: string;
  readonly chatTags: readonly string[];
  readonly agentId?: string;
}

export interface PermissionGrantMetadata {
  readonly denialId?: number;
  readonly capability: PermissionGrantCapability;
  readonly targets: PermissionGrantTargets;
  readonly adminUserIds: readonly string[];
  readonly allowed: readonly PermissionGrantIntent[];
  readonly scopes: readonly PermissionGrantScopeValue[];
  /** Short denial reason kept for card re-renders. */
  readonly reason?: string;
}

export const GRANT_SCOPE_CHAT: PermissionGrantScopeValue = "chat";
export const GRANT_SCOPE_CONTACT: PermissionGrantScopeValue = "contact";

export function chatTagScopeValue(chatTag: string): PermissionGrantScopeValue {
  return `chat-tag:${chatTag}`;
}

/**
 * Build the grant metadata for one denied runtime call.
 *
 * Returns null when the turn has no canonical chat to key the grant on: without
 * it no provider-owned grant can be written, so the caller keeps today's
 * one-shot approval card instead of offering buttons that cannot work.
 */
export function buildPermissionGrantMetadata(input: {
  readonly context: ContextRecord;
  readonly capability: PermissionGrantCapability;
  readonly adminUserIds: readonly string[];
  readonly denialId?: number;
}): PermissionGrantMetadata | null {
  const provenance = buildAuditContextProvenance({ context: input.context });
  const chatRef =
    clean(input.context.source?.canonicalChatId) ??
    stripChatPrefix(clean(provenance?.userOverlayChat)) ??
    clean(input.context.source?.chatId);
  if (!chatRef) return null;

  const scope = resolvePermissionChatScope(chatRef, {
    channel: clean(input.context.source?.channel),
    instanceId: clean(input.context.source?.instanceId),
  });
  if (!scope.known || !scope.chatId) return null;

  const contactId = parseContactPrincipal(clean(provenance?.actorPrincipal));
  const agentId = clean(provenance?.executorAgentId) ?? clean(input.context.agentId);
  const targets: PermissionGrantTargets = {
    ...(contactId ? { contactId } : {}),
    chatId: scope.chatId,
    chatTags: [...scope.chatTags],
    ...(agentId ? { agentId } : {}),
  };

  // A contact scope needs a resolved contact. Without one only the executor
  // agent ceiling can be granted, so no scope selector is offered.
  const scopes: PermissionGrantScopeValue[] = contactId
    ? [GRANT_SCOPE_CHAT, GRANT_SCOPE_CONTACT, ...scope.chatTags.map((tag) => chatTagScopeValue(tag))]
    : [];
  // Full access is the admin profile, so it is only offered when this instance
  // has an admin to click it; otherwise the card falls back to the exact grant.
  const hasAdmin = input.adminUserIds.some((id) => id.trim().length > 0);
  const allowed: PermissionGrantIntent[] = [
    ...(contactId && hasAdmin ? (["full-access"] as const) : []),
    ...(contactId || agentId ? (["exact"] as const) : []),
  ];
  if (allowed.length === 0) return null;

  return {
    ...(typeof input.denialId === "number" ? { denialId: input.denialId } : {}),
    capability: {
      permission: input.capability.permission,
      objectType: input.capability.objectType,
      objectId: input.capability.objectId,
    },
    targets,
    adminUserIds: [...new Set(input.adminUserIds.map((id) => id.trim().toUpperCase()).filter(Boolean))],
    allowed,
    scopes,
  };
}

/** The stored grant metadata of an approval request, when it has any. */
export function readPermissionGrantMetadata(
  record: Pick<ApprovalRequestRecord, "grant"> | null | undefined,
): PermissionGrantMetadata | null {
  const grant = record?.grant;
  if (!grant) return null;
  if (!grant.capability?.permission || !grant.capability.objectType || !grant.capability.objectId) return null;
  return {
    ...(typeof grant.denialId === "number" ? { denialId: grant.denialId } : {}),
    capability: grant.capability,
    targets: {
      ...(grant.targets.contactId ? { contactId: grant.targets.contactId } : {}),
      ...(grant.targets.chatId ? { chatId: grant.targets.chatId } : {}),
      chatTags: [...(grant.targets.chatTags ?? [])],
      ...(grant.targets.agentId ? { agentId: grant.targets.agentId } : {}),
    },
    adminUserIds: [...(grant.adminUserIds ?? [])],
    allowed: [...(grant.allowed ?? [])],
    scopes: [...(grant.scopes ?? [])],
    ...(grant.reason ? { reason: grant.reason } : {}),
  };
}

export function grantAllowsIntent(grant: PermissionGrantMetadata, intent: PermissionGrantIntent): boolean {
  return grant.allowed.includes(intent);
}

/**
 * A scope value from a click is untrusted: only the scopes recorded on the
 * request are accepted. An agent-only grant accepts no scope at all.
 */
export function resolveClickScope(
  grant: PermissionGrantMetadata,
  value: string | undefined,
): { scopeValue: PermissionGrantScopeValue; scopeRef: PermissionGrantScopeRef } | null {
  const candidate = clean(value) ?? (grant.scopes.includes(GRANT_SCOPE_CHAT) ? GRANT_SCOPE_CHAT : grant.scopes[0]);
  if (!candidate || !isGrantScopeValueShape(candidate)) return null;
  if (!grant.scopes.includes(candidate as PermissionGrantScopeValue)) return null;
  const scopeRef = resolveGrantScopeRef(candidate, grant.targets.chatId);
  if (!scopeRef) return null;
  return { scopeValue: candidate as PermissionGrantScopeValue, scopeRef };
}

/** Stable dedupe identity: one open card per (chat, subject, agent, capability). */
export function grantSubjectKey(grant: PermissionGrantMetadata): string {
  if (grant.targets.contactId) return `contact:${grant.targets.contactId}`;
  if (grant.targets.agentId) return `agent:${grant.targets.agentId}`;
  return "unknown";
}

export function sameGrantTuple(a: PermissionGrantMetadata, b: PermissionGrantMetadata): boolean {
  return (
    a.targets.chatId === b.targets.chatId &&
    grantSubjectKey(a) === grantSubjectKey(b) &&
    // The grant also widens the executor agent's ceiling: two agents serving
    // the same contact each need their own card.
    (a.targets.agentId ?? null) === (b.targets.agentId ?? null) &&
    a.capability.permission === b.capability.permission &&
    a.capability.objectType === b.capability.objectType &&
    a.capability.objectId === b.capability.objectId
  );
}

export function describeGrantScope(scope: PermissionGrantScopeValue): string {
  if (scope === GRANT_SCOPE_CHAT) return "this chat";
  if (scope === GRANT_SCOPE_CONTACT) return "this contact (all chats)";
  return `every chat tagged ${scope.slice("chat-tag:".length)}`;
}

function parseContactPrincipal(value: string | undefined): string | undefined {
  if (!value?.startsWith("contact:")) return undefined;
  const contactId = value.slice("contact:".length).trim();
  return contactId && contactId !== "unknown" ? contactId : undefined;
}

function stripChatPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("chat:") ? value.slice("chat:".length) : value;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
