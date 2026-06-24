import type { ContextCapability } from "../router/router-db.js";
import { dbListTagDefinitions } from "../tags/tag-db.js";
import type { TagDefinition } from "../tags/types.js";

export interface AuthorizationCapability {
  permission: string;
  objectType: string;
  objectId: string;
}

export interface AuthorizationSubject {
  type: string;
  id: string;
}

export interface ProviderOwnedPermissionTagSuggestion {
  slug: string;
  label: string;
  description?: string;
  capabilities: string[];
}

export interface AuthorizationGuidance {
  canonicalCapability: string;
  subject?: AuthorizationSubject;
  scope: "current-context" | "recurring" | "diagnostic";
  inspectCommands: string[];
  preferredPath: {
    kind: "provider-owned-profile-or-tag";
    message: string;
    suggestedTags: ProviderOwnedPermissionTagSuggestion[];
  };
  rawCapabilityFallback: string;
  breakGlass: string;
  requestShape: {
    subject?: string;
    scope: string;
    profileOrTag: string;
    reason: string;
    ttl: string;
  };
  nextSteps: string[];
}

export function formatCanonicalCapability(capability: AuthorizationCapability): string {
  return `${capability.permission}:${capability.objectType}:${capability.objectId}`;
}

export function buildAuthorizationGuidance(input: {
  capability: AuthorizationCapability;
  subject?: AuthorizationSubject;
  scope?: AuthorizationGuidance["scope"];
  reason?: string;
  includeProviderOwnedTags?: boolean;
}): AuthorizationGuidance {
  const canonicalCapability = formatCanonicalCapability(input.capability);
  const subject = normalizeSubject(input.subject);
  const inspectCommands = buildInspectCommands(subject);
  const suggestedTags = input.includeProviderOwnedTags
    ? findProviderOwnedPermissionTagsForCapability(input.capability)
    : [];
  const profileOrTag = suggestedTags[0]
    ? `permission tag ${suggestedTags[0].slug}`
    : "provider-owned permission profile/tag";
  const preferredMessage = suggestedTags[0]
    ? `Use provider-owned permission tag '${suggestedTags[0].slug}' (${suggestedTags[0].label}) for recurring access.`
    : "Use a provider-owned permission profile/tag for recurring access.";
  const rawCapabilityFallback = `Use raw capability ${canonicalCapability} only as temporary/bootstrap material when no profile/tag exists yet.`;
  const breakGlass = "full-access is break-glass and requires explicit operator approval.";

  const nextSteps = [
    `Inspect current authority with '${inspectCommands[0]}'.`,
    preferredMessage,
    rawCapabilityFallback,
    breakGlass,
  ];

  return {
    canonicalCapability,
    ...(subject ? { subject } : {}),
    scope: input.scope ?? "diagnostic",
    inspectCommands,
    preferredPath: {
      kind: "provider-owned-profile-or-tag",
      message: preferredMessage,
      suggestedTags,
    },
    rawCapabilityFallback,
    breakGlass,
    requestShape: {
      ...(subject ? { subject: `${subject.type}:${subject.id}` } : {}),
      scope: input.scope ?? "diagnostic",
      profileOrTag,
      reason: input.reason ?? `Needs ${canonicalCapability} for the blocked workflow.`,
      ttl: "temporary by default; permanent only when explicit",
    },
    nextSteps,
  };
}

export function formatAuthorizationGuidanceLines(guidance: AuthorizationGuidance): string[] {
  return [
    `Missing capability: ${guidance.canonicalCapability}`,
    `Inspect: ${guidance.inspectCommands[0]}`,
    `Recurring access: ${guidance.preferredPath.message}`,
    `Fallback: ${guidance.rawCapabilityFallback}`,
    `Break-glass: ${guidance.breakGlass}`,
  ];
}

export function findProviderOwnedPermissionTagsForCapability(
  capability: AuthorizationCapability,
): ProviderOwnedPermissionTagSuggestion[] {
  try {
    return dbListTagDefinitions({ kind: "system", source: "permissions", limit: 500 })
      .flatMap((tag) => {
        const capabilities = readPermissionTagCapabilities(tag);
        if (!capabilities.some((candidate) => capabilityMatches(candidate, capability))) return [];
        return [
          {
            slug: tag.slug,
            label: tag.label,
            ...(tag.description ? { description: tag.description } : {}),
            capabilities: capabilities.map(formatCanonicalCapability),
          },
        ];
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {
    return [];
  }
}

function buildInspectCommands(subject: AuthorizationSubject | undefined): string[] {
  if (subject) {
    return [`ravi permissions materialize --subject-type ${subject.type} --subject-id ${subject.id} --json`];
  }
  return ["ravi permissions materialize --subject-type <type> --subject-id <id> --json", "ravi permissions status"];
}

function normalizeSubject(subject: AuthorizationSubject | undefined): AuthorizationSubject | undefined {
  const type = subject?.type.trim();
  const id = subject?.id.trim();
  return type && id ? { type, id } : undefined;
}

export function readPermissionTagCapabilities(definition: TagDefinition): AuthorizationCapability[] {
  const metadata = definition.metadata;
  if (!isRecord(metadata)) return [];

  const permissions = isRecord(metadata.permissions) ? metadata.permissions : metadata;
  const values = Array.isArray(permissions.capabilities)
    ? permissions.capabilities
    : Array.isArray(metadata.permissionCapabilities)
      ? metadata.permissionCapabilities
      : [];

  return values.flatMap((value) => {
    const capability = normalizeAuthorizationCapabilityInput(value);
    return capability ? [capability] : [];
  });
}

function capabilityMatches(candidate: AuthorizationCapability, requested: AuthorizationCapability): boolean {
  if (candidate.permission !== requested.permission) return false;
  if (candidate.objectType !== requested.objectType) return false;
  return candidate.objectId === requested.objectId || candidate.objectId === "*";
}

export function normalizeAuthorizationCapabilityInput(value: unknown): AuthorizationCapability | null {
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

function normalizeCapabilityObject(value: Record<string, unknown>): AuthorizationCapability | null {
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

export function stripCapabilitySource(capability: ContextCapability): AuthorizationCapability {
  return {
    permission: capability.permission,
    objectType: capability.objectType,
    objectId: capability.objectId,
  };
}
