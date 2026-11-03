// Who may use cloud agents (D12) and the dependencies every service takes.
// Order of checks: the Console key (`RAVI_CLOUD_AGENTS_KEY`), the optional
// organization allowlist (`RAVI_CLOUD_AGENTS_ORGS`), then the feature.

import { and, eq } from "drizzle-orm";

import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { canAccessProject, findAccessibleProjectRecord, type ProjectAccessAction } from "@/server/console/project-access";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";
import { db, schema } from "@/server/db";

import { cloudSecretCodec, type CloudSecretCodec } from "./crypto";
import { cloudError } from "./errors";
import { githubRepositoryTokenMinter } from "./github";
import { anthropicCloudProvider } from "./providers/anthropic";
import type { CloudProviderFactory, CloudProviderLimits } from "./providers/types";

export const CLOUD_AGENTS_FEATURE_KEY = "console.cloud_agents";
/** Deploy, run, approve and schedule (D12). */
export const CLOUD_WRITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "developer"]);
/** Set and remove the organization's key; deploy `writes: auto` or unrestricted networking. */
export const CLOUD_ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export type CloudWorkspace = {
  authorization?: import("../authorization/identity").AuthorizationActor["delegation"];
  user: { id: string };
  organization: { id: string; slug?: string | null };
  membership: { role: string };
};

export type CloudRepositoryTokenMinter = (input: {
  organizationId: string;
  repo: string;
}) => Promise<{ url: string; token: string }>;

/** Interactive provider calls: a run start (about eight calls) fits in a 300 s route. */
export const CLOUD_INTERACTIVE_PROVIDER_LIMITS: CloudProviderLimits = { timeoutMs: 15_000, maxRetries: 1 };

export type CloudDeps = {
  providerFactory?: CloudProviderFactory;
  providerLimits?: CloudProviderLimits;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Short GitHub installation token for one repository (`github.ts` by default). */
  mintRepositoryToken?: CloudRepositoryTokenMinter;
};

export type ResolvedCloudDeps = {
  providerFactory: CloudProviderFactory;
  providerLimits: CloudProviderLimits;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  codec: CloudSecretCodec;
  mintRepositoryToken: CloudRepositoryTokenMinter;
  consoleOrigin: string;
  mcpBaseUrl: string;
};

/** The caller of a service: who, from which surface, for which request. */
export type CloudContext = {
  workspace: CloudWorkspace;
  requestId: string;
  surface: "cli" | "console" | "operation" | "tick";
  /** The caller's local installation (CLI only), for task runs. */
  localInstallationId?: string | null;
  deps?: CloudDeps;
};

export function resolveCloudDeps(deps: CloudDeps = {}): ResolvedCloudDeps {
  const env = deps.env ?? process.env;
  return {
    providerFactory: deps.providerFactory ?? (({ apiKey, limits }) => anthropicCloudProvider({ apiKey, limits })),
    providerLimits: deps.providerLimits ?? CLOUD_INTERACTIVE_PROVIDER_LIMITS,
    now: deps.now ?? (() => new Date()),
    env,
    codec: cloudSecretCodec(env),
    mintRepositoryToken: deps.mintRepositoryToken ?? githubRepositoryTokenMinter({ env }),
    consoleOrigin: raviLinkConsoleOrigin("https://console.ravi.bot/"),
    mcpBaseUrl: (env.RAVI_MCP_BASE_URL?.trim() || "https://mcp.ravi.so").replace(/\/+$/, ""),
  };
}

/** `RAVI_CLOUD_AGENTS_ORGS`: comma-separated org slugs or ids; unset or empty allows every organization. */
export function organizationAllowed(organization: { id: string; slug: string | null }, env: NodeJS.ProcessEnv = process.env) {
  const raw = env.RAVI_CLOUD_AGENTS_ORGS?.trim();
  if (!raw) return true;
  const allowed = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.has(organization.id.toLowerCase()) || (organization.slug !== null && allowed.has(organization.slug.toLowerCase()));
}

/** Key, allowlist and feature, in that order; returns the resolved dependencies. */
export async function assertCloudAgentsEnabled(ctx: CloudContext): Promise<ResolvedCloudDeps> {
  const deps = resolveCloudDeps(ctx.deps);
  const organization = await organizationRecord(ctx.workspace.organization.id);
  if (!organizationAllowed({ id: organization.id, slug: organization.slug }, deps.env)) {
    throw cloudError("cloud_agents_not_enabled", "Cloud agents are not enabled for this organization yet.");
  }
  const access = await getConsoleFeatureAccessForOrganizationRole({
    organizationId: ctx.workspace.organization.id,
    role: ctx.workspace.membership.role,
  });
  if (!access.byKey[CLOUD_AGENTS_FEATURE_KEY]?.enabled) {
    throw cloudError("cloud_agents_not_enabled", "Cloud agents (console.cloud_agents) are not enabled for this organization or role.");
  }
  return deps;
}

export function assertWriteRole(workspace: CloudWorkspace) {
  if (!CLOUD_WRITE_ROLES.has(workspace.membership.role)) {
    throw cloudError("forbidden", "Only organization owners, admins and developers deploy, run and schedule cloud agents.");
  }
}

export function assertAdminRole(workspace: CloudWorkspace, what = "manage the organization's Anthropic key") {
  if (!CLOUD_ADMIN_ROLES.has(workspace.membership.role)) {
    throw cloudError("forbidden", `Only organization owners and admins ${what}.`);
  }
}

/** A project the caller may read (or write, which also needs a write role). */
export async function requireCloudProject(workspace: CloudWorkspace, ref: unknown, action: Exclude<ProjectAccessAction, "admin">) {
  if (typeof ref !== "string" || !ref.trim()) throw cloudError("validation_failed", "Name the project (id or slug).");
  if (action === "write") assertWriteRole(workspace);
  const project = await findAccessibleProjectRecord(workspace, ref.trim(), action);
  if (!project) throw cloudError("not_found", "Project not found, or you cannot access it.");
  return project;
}

export async function canAccessCloudProject(workspace: CloudWorkspace, projectId: string, action: Exclude<ProjectAccessAction, "admin">) {
  if (action === "write" && !CLOUD_WRITE_ROLES.has(workspace.membership.role)) return false;
  return canAccessProject(workspace, projectId, action);
}

export async function assertCloudProjectAccess(
  workspace: CloudWorkspace,
  projectId: string,
  action: Exclude<ProjectAccessAction, "admin">,
) {
  if (action === "write") assertWriteRole(workspace);
  if (!(await canAccessProject(workspace, projectId, action))) {
    throw cloudError("not_found", "Not found, or you cannot access it.");
  }
}

/** The current role of a person in an organization, or null when not an active member. */
export async function activeMemberRole(organizationId: string, userId: string) {
  const [row] = await db
    .select({ role: schema.organizationMemberships.role, status: schema.organizationMemberships.status, userStatus: schema.users.status })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.userId, userId),
      ),
    )
    .limit(1);
  if (!row || row.status !== "active" || row.userStatus !== "active") return null;
  return row.role;
}

async function organizationRecord(organizationId: string) {
  const [organization] = await db
    .select({ id: schema.organizations.id, slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);
  if (!organization) throw cloudError("not_found", "Organization not found.");
  return organization;
}
