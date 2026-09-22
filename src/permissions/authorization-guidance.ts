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
  candidateCapabilities: string[];
  subject?: AuthorizationSubject;
  scope: "current-context" | "recurring" | "diagnostic";
  inspectCommands: string[];
  preferredPath: {
    kind: "provider-owned-profile-or-tag";
    message: string;
    allowCommand: string;
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
  candidates?: AuthorizationCapability[];
  subject?: AuthorizationSubject;
  scope?: AuthorizationGuidance["scope"];
  reason?: string;
  includeProviderOwnedTags?: boolean;
}): AuthorizationGuidance {
  const canonicalCapability = formatCanonicalCapability(input.capability);
  const subject = normalizeSubject(input.subject);
  const inspectCommands = buildInspectCommands(subject);
  const candidateCapabilities = dedupeAuthorizationCapabilities([input.capability, ...(input.candidates ?? [])]).map(
    formatCanonicalCapability,
  );
  const suggestedTags = input.includeProviderOwnedTags
    ? findProviderOwnedPermissionTagsForCapabilities([input.capability, ...(input.candidates ?? [])])
    : [];
  const allowCommand = buildRecurringAllowCommand({
    capability: input.capability,
    subject,
    tagSlug: suggestedTags[0]?.slug,
  });
  const profileOrTag = suggestedTags[0]
    ? `permission tag ${suggestedTags[0].slug}`
    : `permission profile ${derivePermissionProfileSlug(input.capability)}`;
  const preferredMessage = suggestedTags[0]
    ? `Use ${allowCommand} (${suggestedTags[0].label}) for recurring access.`
    : `Use ${allowCommand} for recurring access.`;
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
    candidateCapabilities,
    ...(subject ? { subject } : {}),
    scope: input.scope ?? "diagnostic",
    inspectCommands,
    preferredPath: {
      kind: "provider-owned-profile-or-tag",
      message: preferredMessage,
      allowCommand,
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
  const lines = [`Missing capability: ${guidance.canonicalCapability}`];
  if (guidance.candidateCapabilities.length > 1) {
    lines.push(`Required candidates: ${guidance.candidateCapabilities.join(", ")}`);
  }
  lines.push(
    `Inspect: ${guidance.inspectCommands[0]}`,
    `Recurring access: ${guidance.preferredPath.message}`,
    `Fallback: ${guidance.rawCapabilityFallback}`,
    `Break-glass: ${guidance.breakGlass}`,
  );
  return lines;
}

export function derivePermissionProfileSlug(capability: AuthorizationCapability): string {
  return `permission-${capability.permission}-${capability.objectType}-${capability.objectId}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildRecurringAllowCommand(input: {
  capability: AuthorizationCapability;
  subject?: AuthorizationSubject;
  tagSlug?: string;
}): string {
  const profile = input.tagSlug ?? derivePermissionProfileSlug(input.capability);
  const parts = ["ravi", "permissions", "allow", quoteCliArg(profile)];
  const subject = normalizeSubject(input.subject);
  if (subject) {
    parts.push("--to", `${subject.type}:${subject.id}`);
  }
  if (!input.tagSlug) {
    parts.push("--capabilities", formatCanonicalCapability(input.capability));
  }
  parts.push("--apply");
  return parts.join(" ");
}

export function findProviderOwnedPermissionTagsForCapabilities(
  capabilities: AuthorizationCapability[],
): ProviderOwnedPermissionTagSuggestion[] {
  const seen = new Set<string>();
  return capabilities
    .flatMap((capability) => findProviderOwnedPermissionTagsForCapability(capability))
    .filter((tag) => {
      if (seen.has(tag.slug)) return false;
      seen.add(tag.slug);
      return true;
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
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

function dedupeAuthorizationCapabilities(capabilities: AuthorizationCapability[]): AuthorizationCapability[] {
  const seen = new Set<string>();
  const result: AuthorizationCapability[] = [];
  for (const capability of capabilities) {
    const key = formatCanonicalCapability(capability);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

function quoteCliArg(value: string): string {
  return /^[A-Za-z0-9_./:@,-]+$/.test(value) ? value : JSON.stringify(value);
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
