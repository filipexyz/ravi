/**
 * Applying a provider-owned permission grant.
 *
 * One source of truth for turning "this subject needs this capability" into
 * durable provider-owned state:
 *
 *   - the `permission-*` tag definition that carries the capabilities;
 *   - the contact grant, scoped to one chat, to a chat tag, or globally;
 *   - the executor agent ceiling that the contact overlay is intersected with.
 *
 * `ravi permissions allow|resolve --apply` and the Slack permission-grant card
 * both call this module, so the rule lives here and nowhere else.
 */

import { createHash } from "node:crypto";
import { addContactTag, getContactById } from "../contacts.js";
import { getDb } from "../router/router-db.js";
import { dbCreateTagDefinition, dbGetTagDefinition, dbUpdateTagDefinition, normalizeTagSlug } from "../tags/index.js";
import { ensureAgentRuntimeCapability } from "./agent-default-capabilities-provider.js";
import {
  formatCanonicalCapability,
  normalizeAuthorizationCapabilityInput,
  readPermissionTagCapabilities,
  type AuthorizationCapability,
} from "./authorization-guidance.js";
import { dbEnsureContactChatGrant, dbGetContactChatGrant } from "./contact-chat-grants.js";

export type PermissionGrantIntent = "full-access" | "exact";

export interface PermissionCapability {
  readonly permission: string;
  readonly objectType: string;
  readonly objectId: string;
}

/** Where a contact profile grant applies. `global` is every chat. */
export type PermissionGrantScopeRef =
  | { readonly type: "chat"; readonly chatId: string }
  | { readonly type: "chat_tag"; readonly chatTag: string }
  | { readonly type: "global" };

/** Wire form of a scope, as stored on the approval request and sent in buttons. */
export type PermissionGrantScopeValue = "chat" | "contact" | `chat-tag:${string}`;

export type PermissionGrantOperationKind =
  | "profile"
  | "contact-chat-grant"
  | "contact-profile-global"
  | "agent-ceiling";

export interface PermissionGrantOperation {
  readonly kind: PermissionGrantOperationKind;
  readonly status: "applied" | "unchanged";
  readonly target?: string;
  readonly capability?: string;
  readonly message: string;
}

/**
 * Provider-owned profiles that mean "everything the executor agent can do".
 * They are built into the contact policy provider and never get a definition.
 */
export const ADMIN_PERMISSION_PROFILES: readonly string[] = [
  "permission-admin",
  "permission-owner",
  "permission-superadmin",
];

export const FULL_ACCESS_PROFILE = "permission-admin";

export function isAdminPermissionProfile(profileSlug: string): boolean {
  return ADMIN_PERMISSION_PROFILES.includes(profileSlug);
}

export function normalizePermissionProfileSlug(profile: string): string {
  const base = profile
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) {
    throw new Error("Permission profile name is required.");
  }
  return normalizeTagSlug(base.startsWith("permission-") ? base : `permission-${base}`);
}

export function derivePermissionProfileSlugForCapability(capability: PermissionCapability): string {
  return normalizePermissionProfileSlug(`${capability.permission}-${capability.objectType}-${capability.objectId}`);
}

export function normalizeGrantCapability(capability: PermissionCapability): AuthorizationCapability {
  const normalized = normalizeAuthorizationCapabilityInput({
    permission: capability.permission,
    objectType: capability.objectType,
    objectId: capability.objectId,
  });
  if (!normalized) {
    throw new Error(`Invalid capability: ${capability.permission}:${capability.objectType}:${capability.objectId}`);
  }
  return normalized;
}

export function formatGrantScopeValue(scope: PermissionGrantScopeRef): PermissionGrantScopeValue {
  if (scope.type === "chat") return "chat";
  if (scope.type === "chat_tag") return `chat-tag:${scope.chatTag}`;
  return "contact";
}

/** Syntax check for a scope value coming from a click. Never trusts it alone. */
export function isGrantScopeValueShape(value: string): boolean {
  const normalized = value.trim();
  if (normalized === "chat" || normalized === "contact" || normalized === "global") return true;
  return normalized.startsWith("chat-tag:") && normalized.length > "chat-tag:".length;
}

/**
 * Turn a validated scope value into the ref the apply step needs. `chat` is
 * only meaningful with the request's canonical chat id.
 */
export function resolveGrantScopeRef(value: string, chatId: string | null | undefined): PermissionGrantScopeRef | null {
  const normalized = value.trim();
  if (normalized === "chat") {
    const id = chatId?.trim();
    return id ? { type: "chat", chatId: id } : null;
  }
  if (normalized === "contact" || normalized === "global") return { type: "global" };
  if (normalized.startsWith("chat-tag:")) {
    const chatTag = normalized.slice("chat-tag:".length).trim();
    return chatTag ? { type: "chat_tag", chatTag } : null;
  }
  return null;
}

export interface UpsertPermissionProfileInput {
  readonly profile: string;
  readonly capabilities: readonly PermissionCapability[];
  readonly label?: string;
  readonly description?: string;
  /** The caller named the capabilities explicitly, so they replace the definition. */
  readonly explicitCapabilities?: boolean;
  readonly updatedBy?: string;
}

export interface UpsertPermissionProfileResult {
  readonly status: "applied" | "unchanged";
  readonly tagSlug: string;
  readonly created: boolean;
  readonly message: string;
}

/**
 * Create or update the provider-owned `permission-*` definition that carries a
 * capability set. Admin profiles are built in: nothing is written for them.
 */
export function upsertPermissionProfileDefinition(input: UpsertPermissionProfileInput): UpsertPermissionProfileResult {
  const tagSlug = normalizePermissionProfileSlug(input.profile);
  const capabilities = input.capabilities.map(normalizeGrantCapability);
  if (isAdminPermissionProfile(tagSlug)) {
    return {
      status: "unchanged",
      tagSlug,
      created: false,
      message: "Built-in admin permission profile needs no definition.",
    };
  }

  const existing = dbGetTagDefinition(tagSlug);
  const label = input.label?.trim() || existing?.label || labelFromProfile(tagSlug);
  const description = input.description?.trim() || existing?.description || undefined;

  if (existing) {
    assertProviderOwnedPermissionTag(tagSlug, existing.kind, existing.source);
    const current = readPermissionTagCapabilities(existing);
    const shouldUpdate =
      input.explicitCapabilities === true ||
      label !== existing.label ||
      (description ?? undefined) !== (existing.description ?? undefined) ||
      !capabilityListsEqual(current, capabilities);
    if (!shouldUpdate) {
      return {
        status: "unchanged",
        tagSlug,
        created: false,
        message: "Provider-owned permission profile already matches the requested capabilities.",
      };
    }
    dbUpdateTagDefinition({
      slug: tagSlug,
      label,
      description: description ?? null,
      kind: "system",
      source: "permissions",
      metadata: mergePermissionTagMetadata(existing.metadata, capabilities),
      updatedBy: input.updatedBy ?? "permissions.apply-grant",
    });
    return {
      status: "applied",
      tagSlug,
      created: false,
      message: "Updated provider-owned permission profile.",
    };
  }

  dbCreateTagDefinition({
    slug: tagSlug,
    label,
    description,
    kind: "system",
    source: "permissions",
    metadata: permissionTagMetadata(capabilities),
    createdBy: input.updatedBy ?? "permissions.apply-grant",
  });
  return {
    status: "applied",
    tagSlug,
    created: true,
    message: "Created provider-owned permission profile.",
  };
}

export interface GrantContactProfileInput {
  readonly contactId: string;
  readonly profile: string;
  readonly scope: PermissionGrantScopeRef;
  readonly createdBy?: string;
}

export interface GrantContactProfileResult {
  readonly status: "applied" | "unchanged";
  readonly profile: string;
  readonly target: string;
  readonly message: string;
}

/** Attach a profile to one contact in a chat, a chat tag, or globally. */
export function grantContactProfile(input: GrantContactProfileInput): GrantContactProfileResult {
  const profile = normalizePermissionProfileSlug(input.profile);
  const contactId = input.contactId.trim();
  if (!contactId) throw new Error("A contact id is required to grant a contact profile.");

  if (input.scope.type === "global") {
    const contact = getContactById(contactId);
    if (!contact) throw new Error(`Contact not found: ${contactId}`);
    if (contact.tags.includes(profile)) {
      return {
        status: "unchanged",
        profile,
        target: `contact:${contactId}`,
        message: "Contact already has the global permission profile tag.",
      };
    }
    addContactTag(contactId, profile);
    return {
      status: "applied",
      profile,
      target: `contact:${contactId}`,
      message: "Attached global permission profile tag through contact policy.",
    };
  }

  const key = {
    contactId,
    profileSlug: profile,
    scopeType: input.scope.type,
    scopeId: input.scope.type === "chat" ? input.scope.chatId : input.scope.chatTag,
  };
  if (input.scope.type === "chat" && !key.scopeId) {
    throw new Error("A chat id is required to grant a chat-scoped profile.");
  }
  const label = input.scope.type === "chat" ? `chat:${key.scopeId}` : `chat-tag:${key.scopeId}`;
  const target = `contact:${contactId}@${label}`;
  if (dbGetContactChatGrant(key)) {
    return {
      status: "unchanged",
      profile,
      target,
      message: `Contact already has the permission profile in ${label}.`,
    };
  }
  dbEnsureContactChatGrant({ ...key, createdBy: input.createdBy ?? "permissions.apply-grant" });
  return {
    status: "applied",
    profile,
    target,
    message: `Granted the permission profile to the contact only in ${label}.`,
  };
}

export interface EnsureAgentCeilingInput {
  readonly agentId: string;
  readonly capability: PermissionCapability;
}

export interface EnsureAgentCeilingResult {
  readonly status: "applied" | "unchanged";
  readonly changed: boolean;
  readonly target: string;
  readonly capability: string;
  readonly message: string;
}

/**
 * The contact overlay only materializes when the executor agent ceiling already
 * holds the capability; without this the grant looks applied and does nothing.
 */
export function ensureAgentCeilingCapability(input: EnsureAgentCeilingInput): EnsureAgentCeilingResult {
  const capability = normalizeGrantCapability(input.capability);
  const result = ensureAgentRuntimeCapability(input.agentId, capability);
  if (!result.agent) {
    throw new Error(`Agent not found: ${input.agentId}`);
  }
  return {
    status: result.changed ? "applied" : "unchanged",
    changed: result.changed,
    target: `agent:${input.agentId}`,
    capability: formatCanonicalCapability(capability),
    message: result.changed
      ? "Added capability to agent runtime ceiling."
      : "Agent runtime ceiling already includes this capability.",
  };
}

export interface ApplyPermissionGrantInput {
  readonly intent: PermissionGrantIntent;
  /** Contact/chat scope. Absent for an agent-only grant. */
  readonly scope?: PermissionGrantScopeRef | null;
  readonly capability: PermissionCapability;
  readonly contactId?: string;
  readonly agentId?: string;
  readonly actor?: { readonly channel: string; readonly userId?: string; readonly contactId?: string };
  readonly requestId?: string;
  readonly denialId?: number;
  /** Replaying the same key never applies twice. */
  readonly idempotencyKey?: string;
  readonly createdBy?: string;
  readonly now?: number;
}

export interface ApplyPermissionGrantResult {
  readonly profile: string;
  readonly capabilities: AuthorizationCapability[];
  readonly operations: PermissionGrantOperation[];
  readonly changed: boolean;
  /** True when this call returned a previously applied result instead of applying again. */
  readonly replay: boolean;
}

/**
 * Apply one grant: profile definition, the contact-scoped grant, and the agent
 * ceiling. Every step is an ensure, so re-running with the same inputs reports
 * `changed: false`; the idempotency ledger makes an explicit replay cheap.
 */
export function applyPermissionGrant(input: ApplyPermissionGrantInput): ApplyPermissionGrantResult {
  const now = input.now ?? Date.now();
  const deniedCapability = normalizeGrantCapability(input.capability);
  const fullAccess = input.intent === "full-access";
  const derivedProfile = derivePermissionProfileSlugForCapability(input.capability);
  // An exact grant delivers the denied capability and nothing else. The derived
  // profile can already carry other capabilities (an operator-created profile,
  // or a previous grant), so it is never attached as is: the grant goes through
  // a single-capability sibling instead. The derived profile itself is left
  // untouched, so its current holders keep every capability they already have.
  const profile = fullAccess ? FULL_ACCESS_PROFILE : selectExactGrantProfile(derivedProfile, deniedCapability);
  const capabilities: AuthorizationCapability[] = fullAccess
    ? [{ permission: "admin", objectType: "system", objectId: "*" }]
    : [deniedCapability];

  const ledgerKey = input.idempotencyKey?.trim();
  if (ledgerKey) {
    const previous = readGrantApplication(ledgerKey);
    if (previous?.status === "done" && previous.result) {
      return { ...previous.result, replay: true };
    }
    beginGrantApplication({
      key: ledgerKey,
      requestId: input.requestId,
      denialId: input.denialId,
      intent: input.intent,
      scope: input.scope ? formatGrantScopeValue(input.scope) : "agent",
      profileSlug: profile,
      now,
    });
  }

  const operations: PermissionGrantOperation[] = [];
  if (fullAccess || !isAdminPermissionProfile(profile)) {
    const profileResult = upsertPermissionProfileDefinition({
      profile,
      // An exact grant writes exactly the denied capability, so neither the
      // derived profile nor its sibling can widen what the contact receives.
      capabilities,
      updatedBy: input.createdBy ?? "approval.grant-card",
    });
    operations.push({
      kind: "profile",
      status: profileResult.status,
      target: profileResult.tagSlug,
      message: profileResult.message,
    });
  }

  if (input.scope) {
    if (!input.contactId) {
      throw new Error("A contact id is required for a contact scoped grant.");
    }
    const contactResult = grantContactProfile({
      contactId: input.contactId,
      profile,
      scope: input.scope,
      createdBy: input.createdBy ?? "approval.grant-card",
    });
    operations.push({
      kind: input.scope.type === "global" ? "contact-profile-global" : "contact-chat-grant",
      status: contactResult.status,
      target: contactResult.target,
      message: contactResult.message,
    });
  }

  if (input.agentId?.trim()) {
    const ceilingResult = ensureAgentCeilingCapability({
      agentId: input.agentId.trim(),
      capability: input.capability,
    });
    operations.push({
      kind: "agent-ceiling",
      status: ceilingResult.status,
      target: ceilingResult.target,
      capability: ceilingResult.capability,
      message: ceilingResult.message,
    });
  }

  const result: ApplyPermissionGrantResult = {
    profile,
    capabilities,
    operations,
    changed: operations.some((operation) => operation.status === "applied"),
    replay: false,
  };

  if (ledgerKey) {
    completeGrantApplication(ledgerKey, result, now);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Idempotency ledger
// ---------------------------------------------------------------------------

interface GrantApplicationRow {
  idempotency_key: string;
  status: string;
  result_json: string | null;
}

/** One applied grant per key. A retry after a crash never grants twice. */
export function ensurePermissionGrantApplicationTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS permission_grant_applications (
      idempotency_key TEXT PRIMARY KEY,
      request_id TEXT,
      denial_id INTEGER,
      intent TEXT NOT NULL,
      scope TEXT NOT NULL,
      profile_slug TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_permission_grant_applications_request
      ON permission_grant_applications(request_id);
  `);
}

export function readGrantApplication(
  key: string,
): { status: string; result: ApplyPermissionGrantResult | null } | null {
  ensurePermissionGrantApplicationTable();
  const row = getDb()
    .prepare("SELECT idempotency_key, status, result_json FROM permission_grant_applications WHERE idempotency_key = ?")
    .get(key) as GrantApplicationRow | undefined;
  if (!row) return null;
  return { status: row.status, result: parseGrantResult(row.result_json) };
}

function beginGrantApplication(input: {
  key: string;
  requestId?: string;
  denialId?: number;
  intent: PermissionGrantIntent;
  scope: string;
  profileSlug: string;
  now: number;
}): void {
  ensurePermissionGrantApplicationTable();
  getDb()
    .prepare(
      `INSERT INTO permission_grant_applications (
        idempotency_key, request_id, denial_id, intent, scope, profile_slug, status, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'applying', NULL, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET status = 'applying', updated_at = excluded.updated_at`,
    )
    .run(
      input.key,
      input.requestId ?? null,
      input.denialId ?? null,
      input.intent,
      input.scope,
      input.profileSlug,
      input.now,
      input.now,
    );
}

function completeGrantApplication(key: string, result: ApplyPermissionGrantResult, now: number): void {
  ensurePermissionGrantApplicationTable();
  getDb()
    .prepare(
      `UPDATE permission_grant_applications
          SET status = 'done', result_json = ?, updated_at = ?
        WHERE idempotency_key = ?`,
    )
    .run(safeStringify(result), now, key);
}

function parseGrantResult(value: string | null): ApplyPermissionGrantResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ApplyPermissionGrantResult;
    if (!parsed || typeof parsed !== "object" || typeof parsed.profile !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers shared with the CLI
// ---------------------------------------------------------------------------

export function labelFromProfile(profile: string): string {
  const slug = profile.startsWith("permission-") ? profile.slice("permission-".length) : profile;
  return slug
    .split(/[-_.:]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function assertProviderOwnedPermissionTag(slug: string, kind: string, source: string): void {
  if (kind !== "system" || source !== "permissions") {
    throw new Error(
      `Tag ${slug} is not provider-owned by permissions; refusing to mutate it as an authorization profile.`,
    );
  }
}

export function permissionTagMetadata(capabilities: readonly PermissionCapability[]): Record<string, unknown> {
  return {
    permissions: {
      capabilities: capabilities.map((capability) => formatCanonicalCapability(capability)),
    },
  };
}

export function mergePermissionTagMetadata(
  metadata: Record<string, unknown> | undefined,
  capabilities: readonly PermissionCapability[],
): Record<string, unknown> {
  const previousPermissions =
    metadata?.permissions && typeof metadata.permissions === "object" && !Array.isArray(metadata.permissions)
      ? (metadata.permissions as Record<string, unknown>)
      : {};
  return {
    ...(metadata ?? {}),
    permissions: {
      ...previousPermissions,
      capabilities: capabilities.map((capability) => formatCanonicalCapability(capability)),
    },
  };
}

export function capabilityListsEqual(a: readonly PermissionCapability[], b: readonly PermissionCapability[]): boolean {
  const left = a.map(formatCanonicalCapability).sort();
  const right = b.map(formatCanonicalCapability).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function shortCapabilityHash(capability: AuthorizationCapability): string {
  return createHash("sha256").update(formatCanonicalCapability(capability)).digest("hex").slice(0, 8);
}

/**
 * The profile an exact grant attaches.
 *
 * A grant never redefines a profile somebody else may already use, so every
 * candidate slug is read before it is written: it is reused only when it does
 * not exist yet or when it already carries exactly the denied capability.
 * The derived slug is tried first, then a single-capability sibling
 * (`<derived>-exact`), then a capability-hashed sibling
 * (`<derived>-exact-<hash>`, deterministic so a repeated click lands on the
 * same profile). If all three already carry other capabilities the grant fails
 * loudly instead of rewriting a definition another holder depends on. A tag
 * permissions does not own is still refused, exactly like any other profile
 * write.
 */
function selectExactGrantProfile(derivedProfile: string, capability: AuthorizationCapability): string {
  const candidates = [
    normalizePermissionProfileSlug(derivedProfile),
    normalizePermissionProfileSlug(`${derivedProfile}-exact`),
    normalizePermissionProfileSlug(`${derivedProfile}-exact-${shortCapabilityHash(capability)}`),
  ];
  for (const candidate of candidates) {
    const existing = dbGetTagDefinition(candidate);
    if (!existing) return candidate;
    assertProviderOwnedPermissionTag(candidate, existing.kind, existing.source);
    if (capabilityListsEqual(readPermissionTagCapabilities(existing), [capability])) return candidate;
  }
  throw new Error(
    `Cannot grant ${formatCanonicalCapability(capability)} without redefining an existing permission profile: ` +
      `${candidates.join(", ")} already carry different capabilities. ` +
      "Create an explicit single-capability profile and grant that instead.",
  );
}
