import { getContactDetails } from "../contacts.js";
import type { ContextCapability } from "../router/router-db.js";
import { dbGetTagDefinition } from "../tags/tag-db.js";
import type { TagDefinition } from "../tags/types.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

const ADMIN_CONTACT_TAGS = new Set(["permission-admin", "permission-owner", "permission-superadmin"]);
const PERMISSION_TAG_PREFIX = "permission-";
const PERMISSION_TAG_SOURCE = "permissions";

export const contactPolicyPermissionsProvider: PermissionProvider = {
  id: "contact-policy-permissions",
  version: "contact-tags/v1",
  required: true,
  supports() {
    return false;
  },
  authorize(request) {
    return notApplicableDecision(request);
  },
  materializeCapabilities(subject) {
    if (subject.type !== "contact") return [];
    return materializeContactPolicyCapabilities(subject.id);
  },
};

export function materializeContactPolicyCapabilities(contactId: string): ContextCapability[] {
  const details = getContactDetails(contactId);
  const policy = details?.policy;
  if (!policy || policy.status !== "allowed" || policy.optOut) return [];

  const tags = new Set(policy.tags.map(normalizeTag).filter((tag): tag is string => Boolean(tag)));
  const capabilities: ContextCapability[] = [];

  if (hasAdminTag(tags)) {
    capabilities.push({
      permission: "admin",
      objectType: "system",
      objectId: "*",
      source: `contact-policy:contact:${contactId}:admin-tag`,
    });
  }

  for (const tag of tags) {
    capabilities.push(...materializeConfiguredPermissionTagCapabilities(contactId, tag));
  }

  return dedupeCapabilities(capabilities);
}

function hasAdminTag(tags: Set<string>): boolean {
  for (const tag of ADMIN_CONTACT_TAGS) {
    if (tags.has(tag)) return true;
  }
  return false;
}

function normalizeTag(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

function materializeConfiguredPermissionTagCapabilities(contactId: string, tag: string): ContextCapability[] {
  if (!tag.startsWith(PERMISSION_TAG_PREFIX)) return [];

  const definition = dbGetTagDefinition(tag);
  if (!isPermissionTagDefinition(definition)) return [];

  return readPermissionTagCapabilities(definition).map((capability) => ({
    ...capability,
    source: `contact-policy:contact:${contactId}:tag:${definition.slug}`,
  }));
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
