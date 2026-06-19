import { getContactDetails } from "../contacts.js";
import type { ContextCapability } from "../router/router-db.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

const ADMIN_CONTACT_TAGS = new Set(["permission-admin", "permission-owner", "permission-superadmin"]);

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
  materializeDelegationOverrides() {
    return [];
  },
};

export function materializeContactPolicyCapabilities(contactId: string): ContextCapability[] {
  const details = getContactDetails(contactId);
  const policy = details?.policy;
  if (!policy || policy.status !== "allowed" || policy.optOut) return [];

  const tags = new Set(policy.tags.map(normalizeTag).filter((tag): tag is string => Boolean(tag)));
  if (!hasAdminTag(tags)) return [];

  return [
    {
      permission: "admin",
      objectType: "system",
      objectId: "*",
      source: `contact-policy:contact:${contactId}:admin-tag`,
    },
  ];
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
