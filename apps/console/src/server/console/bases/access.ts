// Bases authorization. See SPEC "Scope And Roles", "Principals", and
// "Ravi Pages". Capabilities derive only from current project access; a view
// admits principals by effective project role, user id, or Pages site.

import type {
  BaseCapabilities,
  BaseProjectRole,
  BaseViewPrincipal,
  BaseViewWritePrincipal,
} from "@/shared/bases/types";
import { isBaseSystemColumn } from "@/shared/bases/operators";
import { decideInTransaction } from "../authorization/store";
import { and, eq } from "drizzle-orm";
import { schema } from "@/server/db";
import { forbidden } from "./errors";
import { assertBasesServiceOperation, isBasesServiceProject, type BasesServiceOperation } from "./service-principal";

import type { BasesCaller } from "./context";
import {
  findActiveProjectRole,
  activeMemberIds,
  type BasesExecutor,
} from "./repository";

export type BasesCallerAccess = {
  /** Explicit project membership; never inherited from organization role. */
  projectRole: BaseProjectRole | null;
  projectRead: boolean;
  projectWrite: boolean;
  /** `base.manage`, `base.read_direct`, and `base.write_direct`. */
  manage: boolean;
  userId: string | null;
  /** Caller user is an active member of the base organization right now. */
  activeOrgMember: boolean;
  /** Pages viewer session: only `page_viewer` principals for this site admit. */
  pageSiteId: string | null;
  pageSurface: boolean;
};

const PROJECT_ROLE_RANK: Record<BaseProjectRole, number> = { viewer: 0, developer: 1, project_admin: 2 };

/** Organization role cannot fabricate a project membership. */
export function effectiveProjectRole(_orgRole: string | null, projectMembershipRole: BaseProjectRole | null): BaseProjectRole | null {
  return projectMembershipRole;
}

export function projectRoleAtLeast(role: BaseProjectRole | null, minRole: BaseProjectRole) {
  return role !== null && PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[minRole];
}

/** The coarse project.write catalog includes direct Base management; Pages never manage. */
export function canManageBases(access: Pick<BasesCallerAccess, "projectRead" | "projectWrite" | "pageSurface">) {
  return !access.pageSurface && access.projectRead && access.projectWrite;
}

export function baseCapabilities(access: Pick<BasesCallerAccess, "manage">): BaseCapabilities {
  return { manage: access.manage, readDirect: access.manage, writeDirect: access.manage };
}

/** Loads the caller's effective project role and current org membership for a project of its organization. */
export async function loadBasesCallerAccess(
  executor: BasesExecutor,
  caller: BasesCaller,
  project: { id: string; organizationId: string },
): Promise<BasesCallerAccess> {
  const pageSurface = caller.surface === "page";
  if (!caller.user) {
    let service = false;
    if (isBasesServiceProject(caller, project)) {
      const [active] = await executor.select({ id: schema.projects.id }).from(schema.projects)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.projects.organizationId))
        .where(and(eq(schema.projects.id, project.id), eq(schema.projects.organizationId, project.organizationId),
          eq(schema.projects.status, "active"), eq(schema.organizations.status, "active"))).limit(1).for("share");
      service = Boolean(active);
    }
    return {
      projectRole: null,
      projectRead: service,
      projectWrite: service,
      manage: service,
      userId: null,
      activeOrgMember: false,
      pageSiteId: caller.pageSiteId,
      pageSurface,
    };
  }
  const userId = caller.user.id;
  if (caller.surface === "cli" && !caller.authorization) {
    return { projectRole: null, projectRead: false, projectWrite: false, manage: false,
      userId, activeOrgMember: false, pageSiteId: caller.pageSiteId, pageSurface };
  }
  const actor = { userId, organizationId: caller.organizationId, delegation: caller.authorization };
  // Capability probes run on every Bases request; a denied read is still recorded,
  // and a refused management effect is recorded by assertCurrentBasesManagement.
  const read = await decideInTransaction(executor, actor, project.id, "project.read", caller.requestId, "observation");
  const write = read.allowed ? await decideInTransaction(executor, actor, project.id, "project.write", caller.requestId, "probe") : read;
  const viewWrite = read.allowed && !write.allowed
    ? await decideInTransaction(executor, actor, project.id, "bases.view.write", caller.requestId, "probe") : write;
  const [membershipRole, members] = await Promise.all([
    findActiveProjectRole(executor, { projectId: project.id, userId }),
    activeMemberIds(executor, project.organizationId, [userId]),
  ]);
  const activeOrgMember = members.has(userId.toLowerCase());
  const projectRole = activeOrgMember && read.allowed ? membershipRole : null;
  const access = { projectRole, projectRead: read.allowed, projectWrite: write.allowed || viewWrite.allowed,
    userId, activeOrgMember, pageSiteId: caller.pageSiteId, pageSurface };
  return { ...access, manage: canManageBases({ ...access, projectWrite: write.allowed }) };
}

/** Policy and identity locks are held by the caller's effect transaction. */
export async function assertCurrentBasesManagement(executor: BasesExecutor, input: { caller: BasesCaller; project: { id: string; organizationId: string }; base?: { slug: string } }, operation?: BasesServiceOperation, slug?: string) {
  assertBasesServiceOperation(input, operation, slug ?? input.base?.slug);
  const access = await loadBasesCallerAccess(executor, input.caller, input.project);
  if (!access.manage) {
    const { caller, project } = input;
    // The probe wrote nothing; the refused effect is audited as a decision.
    if (caller.user && access.projectRead && (caller.surface !== "cli" || caller.authorization)) {
      await decideInTransaction(executor, { userId: caller.user.id, organizationId: caller.organizationId, delegation: caller.authorization },
        project.id, "project.write", caller.requestId);
    }
    forbidden("Current project policy does not permit Base management.");
  }
  return access;
}

// ---------------------------------------------------------------------------
// View admission

export type StoredViewAccess = {
  read: BaseViewPrincipal[];
  write: {
    principals: BaseViewWritePrincipal[];
    /** Column refs (property ids or `body`). */
    columns: string[];
    create: boolean;
    archive: boolean;
    /** Property id -> stored value or viewer variable. */
    set: Record<string, unknown>;
    allowEscape: boolean;
  };
};

export type ViewAdmission = {
  /** Admitted in any way (read rows, aggregate only, or write). */
  admitted: boolean;
  /** May read rows. */
  read: boolean;
  /** May only read chart data of charts on this view. */
  aggregateOnly: boolean;
  /** Admitted by `access.write.principals` (or manages the base). */
  write: boolean;
  /** Column refs the caller may change (property ids or `body`). */
  writeColumns: string[];
  create: boolean;
  archive: boolean;
  /** Post-images may leave the view filter. */
  allowEscape: boolean;
  /** Keys of `write.set` may be supplied by the caller (managers only). */
  maySupplySetKeys: boolean;
  manage: boolean;
};

export function principalAdmits(
  principal: BaseViewPrincipal | BaseViewWritePrincipal,
  access: Pick<BasesCallerAccess, "projectRole" | "userId" | "activeOrgMember" | "pageSiteId" | "pageSurface">,
): boolean {
  switch (principal.kind) {
    case "project_role":
      return !access.pageSurface && projectRoleAtLeast(access.projectRole, principal.minRole);
    case "user":
      return (
        !access.pageSurface &&
        access.activeOrgMember &&
        access.userId !== null &&
        access.userId.toLowerCase() === principal.userId.toLowerCase()
      );
    case "page_viewer":
      return access.pageSurface && access.pageSiteId !== null && access.pageSiteId.toLowerCase() === principal.siteId.toLowerCase();
    default:
      return false;
  }
}

/**
 * What the caller may do through a view. Managers (outside Pages) read and
 * write every projected non-system column, create, archive, and escape.
 * Everyone else is admitted by the view's principals only. `readOnlyRefs`
 * (agent columns) are never writable through a view.
 */
export function computeViewAdmission(
  stored: { columns: readonly string[]; access: StoredViewAccess },
  access: BasesCallerAccess,
  readOnlyRefs: ReadonlySet<string> = new Set(),
): ViewAdmission {
  if (!access.projectRead) return { admitted: false, read: false, aggregateOnly: false, write: false, writeColumns: [],
    create: false, archive: false, allowEscape: false, maySupplySetKeys: false, manage: false };
  if (access.manage) {
    return {
      admitted: true,
      read: true,
      aggregateOnly: false,
      write: true,
      writeColumns: stored.columns.filter((ref) => !isBaseSystemColumn(ref) && !readOnlyRefs.has(ref)),
      create: true,
      archive: true,
      allowEscape: true,
      maySupplySetKeys: true,
      manage: true,
    };
  }
  const readers = stored.access.read.filter((principal) => principalAdmits(principal, access));
  const read = readers.some((principal) => (principal.mode ?? "rows") === "rows");
  const aggregateOnly = !read && readers.length > 0;
  const write = access.projectWrite && stored.access.write.principals.some((principal) => principalAdmits(principal, access));
  const projected = new Set(stored.columns);
  const setKeys = new Set(Object.keys(stored.access.write.set));
  const writeColumns = write
    ? stored.access.write.columns.filter(
        (ref) => projected.has(ref) && !isBaseSystemColumn(ref) && !setKeys.has(ref) && !readOnlyRefs.has(ref),
      )
    : [];
  return {
    admitted: read || aggregateOnly || write,
    read,
    aggregateOnly,
    write,
    writeColumns,
    create: write && stored.access.write.create,
    archive: write && stored.access.write.archive,
    allowEscape: stored.access.write.allowEscape,
    maySupplySetKeys: false,
    manage: false,
  };
}
