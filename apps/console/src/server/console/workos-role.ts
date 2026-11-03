import type { ConsoleRole } from "@/lib/auth/session";

export const CONSOLE_ORGANIZATION_ROLES = ["owner", "admin", "developer", "viewer", "billing"] as const;

export const CONSOLE_ORGANIZATION_ROLE_SET = new Set<ConsoleRole>(CONSOLE_ORGANIZATION_ROLES);

const WORKOS_ROLE_ALIASES: Record<string, ConsoleRole> = {
  member: "viewer",
};

const CONSOLE_ROLE_RANK: Record<ConsoleRole, number> = {
  viewer: 0,
  billing: 1,
  developer: 2,
  admin: 3,
  owner: 4,
};

export type WorkosRoleClaimShape = "missing" | "string" | "object" | "array" | "other";

export type WorkosRoleParserPath =
  | "missing_claim"
  | "unsupported_shape"
  | "console_role"
  | "workos_member_alias"
  | "unmapped_slug";

export type WorkosRoleClaimSource = "role" | "organization_role" | "roles";

export type WorkosRoleClaimInspection = {
  sourceClaim: WorkosRoleClaimSource | null;
  shape: WorkosRoleClaimShape;
  slugs: string[];
  rawKind: string;
  parserPath: WorkosRoleParserPath;
  mappedRole: ConsoleRole | null;
};

export type WorkosOrganizationAccessDiagnostics = {
  hasSubject: boolean;
  hasEmail: boolean;
  hasOrganization: boolean;
  hasRole: boolean;
  roleClaimShape: WorkosRoleClaimShape;
  roleClaimSource: WorkosRoleClaimSource | null;
  roleSlugs: string[];
  mappedRole: ConsoleRole | null;
  parserPath: WorkosRoleParserPath;
  organizationIdSuffix: string | null;
  userOnlyFallbackPossible: boolean;
  profileResolved: boolean;
  profileHasEmail: boolean;
};

export function parseConsoleRole(role: string | undefined): ConsoleRole | null {
  if (role && CONSOLE_ORGANIZATION_ROLE_SET.has(role as ConsoleRole)) return role as ConsoleRole;
  return null;
}

export function mapWorkosOrganizationRoleSlug(slug: string | null | undefined): {
  role: ConsoleRole | null;
  parserPath: Exclude<WorkosRoleParserPath, "missing_claim" | "unsupported_shape">;
} {
  const trimmed = slug?.trim();
  if (!trimmed) return { role: null, parserPath: "unmapped_slug" };

  const normalized = trimmed.toLowerCase();
  const aliased = WORKOS_ROLE_ALIASES[normalized];
  if (aliased) return { role: aliased, parserPath: "workos_member_alias" };

  const parsed = parseConsoleRole(normalized) ?? parseConsoleRole(trimmed);
  if (parsed) return { role: parsed, parserPath: "console_role" };

  return { role: null, parserPath: "unmapped_slug" };
}

export function inspectWorkosRoleClaims(
  source: Record<string, unknown> | { role?: unknown; organization_role?: unknown; roles?: unknown },
): WorkosRoleClaimInspection {
  const record = source as Record<string, unknown>;
  const candidates: Array<{ sourceClaim: WorkosRoleClaimSource; value: unknown }> = [
    { sourceClaim: "role", value: record.role },
    { sourceClaim: "organization_role", value: record.organization_role },
    { sourceClaim: "roles", value: record.roles },
  ];
  const present = candidates.filter((candidate) => candidate.value !== undefined && candidate.value !== null);

  if (present.length === 0) {
    return {
      sourceClaim: null,
      shape: "missing",
      slugs: [],
      rawKind: "undefined",
      parserPath: "missing_claim",
      mappedRole: null,
    };
  }

  const primary = present[0]!;
  const slugs = uniqueSlugs(present.flatMap((candidate) => extractRoleSlugs(candidate.value)));
  const shape = classifyRoleClaimShape(primary.value);
  if (shape === "other" && slugs.length === 0) {
    return {
      sourceClaim: primary.sourceClaim,
      shape,
      slugs,
      rawKind: rawKind(primary.value),
      parserPath: "unsupported_shape",
      mappedRole: null,
    };
  }

  const mapped = pickHighestMappedRole(slugs);
  return {
    sourceClaim: primary.sourceClaim,
    shape,
    slugs,
    rawKind: rawKind(primary.value),
    parserPath: mapped.parserPath,
    mappedRole: mapped.role,
  };
}

export function mapWorkosOrganizationRole(value: unknown): ConsoleRole | null {
  return inspectWorkosRoleClaims({ role: value }).mappedRole;
}

export function normalizeConsoleRole(role: unknown): ConsoleRole {
  return mapWorkosOrganizationRole(role) ?? "viewer";
}

export function workosOrganizationAccessDiagnostics(input: {
  payload: Record<string, unknown>;
  userProfile?: { email?: string | null } | null;
}): WorkosOrganizationAccessDiagnostics {
  const inspection = inspectWorkosRoleClaims(input.payload);
  const providerUserId = stringClaim(input.payload.sub);
  const email =
    stringClaim(input.payload.email) ??
    stringClaim(input.payload.user_email) ??
    stringClaim(input.payload.preferred_username) ??
    (input.userProfile?.email?.trim() || null);
  const providerOrganizationId =
    stringClaim(input.payload.org_id) ?? stringClaim(input.payload.organization_id);

  return {
    hasSubject: Boolean(providerUserId),
    hasEmail: Boolean(email),
    hasOrganization: Boolean(providerOrganizationId),
    hasRole: inspection.shape !== "missing",
    roleClaimShape: inspection.shape,
    roleClaimSource: inspection.sourceClaim,
    roleSlugs: inspection.slugs,
    mappedRole: inspection.mappedRole,
    parserPath: inspection.parserPath,
    organizationIdSuffix: organizationIdSuffix(providerOrganizationId),
    userOnlyFallbackPossible: Boolean(providerUserId && email),
    profileResolved: Boolean(input.userProfile),
    profileHasEmail: Boolean(input.userProfile?.email),
  };
}

export function workosOrganizationRoleDeniedMessage(
  inspection:
    | Pick<WorkosRoleClaimInspection, "shape" | "slugs" | "sourceClaim" | "parserPath">
    | Pick<WorkosOrganizationAccessDiagnostics, "roleClaimShape" | "roleSlugs" | "roleClaimSource" | "parserPath">,
): string {
  return [
    "WorkOS CLI token is missing a Console-compatible organization role.",
    describeSeenRoleClaim(normalizeRoleClaimDescription(inspection)),
    "Console accepts owner, admin, developer, viewer, billing; WorkOS default member maps to viewer.",
    "Next: run `ravi login` and approve at /cli/authorize?user_code=…, ask an organization owner to assign a Console-compatible role, or retry in a private window if SSO signed in the wrong account.",
  ].join(" ");
}

function normalizeRoleClaimDescription(
  inspection:
    | Pick<WorkosRoleClaimInspection, "shape" | "slugs" | "sourceClaim" | "parserPath">
    | Pick<WorkosOrganizationAccessDiagnostics, "roleClaimShape" | "roleSlugs" | "roleClaimSource" | "parserPath">,
): Pick<WorkosRoleClaimInspection, "shape" | "slugs" | "sourceClaim" | "parserPath"> {
  if ("shape" in inspection) return inspection;
  return {
    shape: inspection.roleClaimShape,
    slugs: inspection.roleSlugs,
    sourceClaim: inspection.roleClaimSource,
    parserPath: inspection.parserPath,
  };
}

export function describeSeenRoleClaim(inspection: Pick<
  WorkosRoleClaimInspection,
  "shape" | "slugs" | "sourceClaim" | "parserPath"
>): string {
  if (inspection.parserPath === "missing_claim" || inspection.shape === "missing") {
    return "Saw no role, organization_role, or roles claim.";
  }

  const source = inspection.sourceClaim ?? "role";
  const slugText = inspection.slugs.length > 0 ? ` slug="${inspection.slugs.join(",")}"` : "";
  return `Saw ${source} claim shape=${inspection.shape}${slugText} (parser=${inspection.parserPath}).`;
}

function pickHighestMappedRole(slugs: string[]): {
  role: ConsoleRole | null;
  parserPath: WorkosRoleParserPath;
} {
  let best: ConsoleRole | null = null;
  let parserPath: WorkosRoleParserPath = slugs.length > 0 ? "unmapped_slug" : "missing_claim";

  for (const slug of slugs) {
    const mapped = mapWorkosOrganizationRoleSlug(slug);
    if (!mapped.role) continue;
    if (!best || CONSOLE_ROLE_RANK[mapped.role] > CONSOLE_ROLE_RANK[best]) {
      best = mapped.role;
      parserPath = mapped.parserPath;
    }
  }

  return { role: best, parserPath };
}

function extractRoleSlugs(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(extractRoleSlugs);
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const slugs: string[] = [];
  if (typeof record.slug === "string" && record.slug.trim()) slugs.push(record.slug.trim());
  if (typeof record.role === "string" && record.role.trim()) slugs.push(record.role.trim());
  if (Array.isArray(record.roles)) slugs.push(...extractRoleSlugs(record.roles));
  if (Array.isArray(record.slugs)) slugs.push(...extractRoleSlugs(record.slugs));
  return slugs;
}

function classifyRoleClaimShape(value: unknown): WorkosRoleClaimShape {
  if (value === undefined || value === null) return "missing";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "other";
}

function rawKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function uniqueSlugs(slugs: string[]): string[] {
  return [...new Set(slugs)];
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function organizationIdSuffix(organizationId: string | null): string | null {
  if (!organizationId) return null;
  return organizationId.slice(-6);
}
