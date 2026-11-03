// Theme pointers: the theme an organization uses, and the one a project uses
// instead. A pointer names a theme item; what applies is that item's current
// published version when it is read (`ravi pages ship` snapshots it). An
// archived item counts as no pointer. See `.ravi/specs/console/library`.

import { and, asc, eq, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";
import { compileTheme } from "@/shared/widgets/theme/compile";
import type { LibraryFileText } from "@/shared/widgets/types";

import { isLibrarySlug } from "./files";
import { agentSchema, parseBody } from "./proposals";
import {
  assertLibraryFeature,
  auditEvent,
  conflict,
  findProject,
  iso,
  LIBRARY_ORG_SCOPE,
  notFound,
  PUBLISHING_ORG_ROLES,
  scopeRoles,
  selectItems,
  summarizeProject,
  type Executor,
  type ItemRow,
  type LibraryActor,
  type LibraryWorkspace,
  type ProjectSummary,
  type SelectedItem,
} from "./service";

export const THEME_POINTER_AUDIT_ACTION = "library.theme.pointer.set";

const setBodySchema = z
  .object({
    scope: z.enum(["org", "project"]),
    project: z.string().trim().min(1).max(200).optional(),
    ref: z.string().trim().min(1).max(200).nullable(),
    dryRun: z.boolean().optional(),
    agent: agentSchema.optional(),
  })
  .strict();

/** A pointer, described by the theme item it names (`scope` is the item's). */
export type ThemePointerView = {
  ref: string;
  itemId: string;
  scope: "org" | "project";
  slug: string;
  name: string;
  setAt: string | null;
  setBy: { name: string | null } | null;
};

export type EffectiveThemeView = ThemePointerView & { version: number; hash: string; source: "project" | "org" };

export type AffectedHost = { siteSlug: string; hostname: string; routes: number };

/** The theme that applies to a project, for the page kit: its current published version's files. */
export type EffectiveTheme = {
  item: ItemRow;
  versionNumber: number;
  files: LibraryFileText[];
  source: "project" | "org";
  ref: string;
};

type PointerRow = {
  pointer: typeof schema.libraryThemePointers.$inferSelect;
  item: ItemRow;
  itemProject: ProjectSummary | null;
  setByName: string | null;
};

// ---------------------------------------------------------------------------
// Reads

/** `GET themes/active?project=`: the org pointer, the project's, and the one that applies. */
export async function getActiveTheme(input: { workspace: LibraryWorkspace; projectRef: string | null }) {
  await assertLibraryFeature(input.workspace);
  const { workspace } = input;
  const project = input.projectRef ? await findProject(workspace, input.projectRef, "read") : null;
  if (input.projectRef && !project) throw notFound("Project not found.");
  const rows = await loadPointers(db, workspace.organization.id, project?.id ?? null);
  const warnings: string[] = [];
  const org = livePointer(rows.org, "organization's", warnings);
  const own = livePointer(rows.project, "project's", warnings);
  const chosen = own ?? org;
  let effective: EffectiveThemeView | null = null;
  if (chosen) {
    const version = await loadVersion(db, chosen.versionId);
    const compiled = compileTheme(version.files).theme;
    if (!compiled) {
      warnings.push(`${pointerRef(chosen.row)} version ${chosen.versionNumber} no longer compiles; ravi pages ship reports its diagnostics.`);
    }
    effective = {
      ...serializePointer(chosen.row),
      version: chosen.versionNumber,
      hash: compiled?.hash ?? version.contentHash,
      source: own ? "project" : "org",
    };
  }
  const projectRoles = project ? await scopeRoles(workspace, project.id) : null;
  return {
    org: org ? serializePointer(org.row) : null,
    project: own ? serializePointer(own.row) : null,
    effective,
    warnings,
    can: { setOrg: PUBLISHING_ORG_ROLES.has(workspace.membership.role), setProject: projectRoles?.canReview ?? false },
  };
}

/**
 * The theme that applies to a project (its pointer, else the org's), at the
 * item's current published version, or null. Archived items are skipped. No
 * access check: callers authorize the project first.
 */
export async function resolveEffectiveTheme(input: { organizationId: string; projectId: string | null }): Promise<EffectiveTheme | null> {
  const rows = await loadPointers(db, input.organizationId, input.projectId);
  const candidates = [
    ["project", rows.project],
    ["org", rows.org],
  ] as const;
  for (const [source, row] of candidates) {
    const live = row ? liveVersion(row) : null;
    if (!row || !live) continue;
    const { files } = await loadVersion(db, live.versionId);
    return { item: row.item, versionNumber: live.versionNumber, files, source, ref: pointerRef(row) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writes

/**
 * `POST themes/active`: points the org (owners and admins) or a project (its
 * admins) at a theme, or clears the pointer with `ref: null`. Answers the
 * plan, with the Pages hosts whose theme follows it; `dryRun` only plans.
 */
export async function setActiveTheme(input: { workspace: LibraryWorkspace; actor: LibraryActor; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(setBodySchema, input.body, "theme pointer");
  if (body.agent) throw cliApiError(403, "ORG_ACCESS_DENIED", "Agents never change the active theme; a person does it in the Console.");
  const { workspace } = input;
  const organizationId = workspace.organization.id;
  let project: ProjectSummary | null = null;
  if (body.scope === "org") {
    if (body.project) throw cliApiError(400, "PAYLOAD_INVALID", "An org theme pointer takes no project.");
    if (!PUBLISHING_ORG_ROLES.has(workspace.membership.role)) {
      throw cliApiError(403, "ORG_ACCESS_DENIED", "Only organization owners and admins set the organization's theme.");
    }
  } else {
    if (!body.project) throw cliApiError(400, "PAYLOAD_INVALID", "A project theme pointer needs project.");
    const record = await findProject(workspace, body.project, "admin");
    if (!record) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", "Only project admins and organization owners and admins set a project's theme.");
    }
    project = summarizeProject(record);
  }

  const target = body.ref === null ? null : await resolveThemeTarget(workspace, body.ref, project);
  const current = await loadPointers(db, organizationId, project?.id ?? null);
  const fromRow = project ? current.project : current.org;
  const unchanged = (fromRow?.item.id ?? null) === (target?.item.id ?? null);
  const plan = {
    scope: body.scope,
    project,
    from: fromRow ? serializePointer(fromRow) : null,
    to: target ? (unchanged && fromRow ? serializePointer(fromRow) : targetView(target)) : null,
    affectedHosts: await listAffectedHosts(organizationId, project),
  };
  if (body.dryRun) return { status: 200, payload: { plan, applied: false, unchanged } };
  if (unchanged) return { status: 200, payload: { plan, applied: true, unchanged: true } };

  const pointers = schema.libraryThemePointers;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`library:theme-pointer:${organizationId}:${project?.id ?? LIBRARY_ORG_SCOPE}`}))`);
    const [existing] = await tx.select().from(pointers).where(pointerKey(organizationId, project?.id ?? null)).limit(1);
    let pointerId = existing?.id ?? null;
    if (!target) {
      if (!existing) return;
      await tx.delete(pointers).where(eq(pointers.id, existing.id));
    } else if (existing) {
      await tx.update(pointers).set({ itemId: target.item.id, setByUserId: workspace.user.id, setAt: now }).where(eq(pointers.id, existing.id));
    } else {
      const [inserted] = await tx
        .insert(pointers)
        .values({ organizationId, projectId: project?.id ?? null, itemId: target.item.id, setByUserId: workspace.user.id, setAt: now })
        .returning({ id: pointers.id });
      if (!inserted) throw new Error("library_theme_pointers insert returned no row");
      pointerId = inserted.id;
    }
    if (!pointerId) return;
    await tx.insert(schema.auditEvents).values({
      ...auditEvent(input, {
        organizationId,
        projectId: project?.id ?? null,
        itemId: pointerId,
        action: THEME_POINTER_AUDIT_ACTION,
        before: { itemId: existing?.itemId ?? null },
        after: { itemId: target?.item.id ?? null },
      }),
      targetType: "library_theme_pointer",
    });
  });

  const after = await loadPointers(db, organizationId, project?.id ?? null);
  const stored = project ? after.project : after.org;
  return {
    status: 200,
    payload: { plan: { ...plan, to: stored ? serializePointer(stored) : null }, applied: true, unchanged: false },
  };
}

// ---------------------------------------------------------------------------
// Helpers

function pointerKey(organizationId: string, projectId: string | null) {
  const pointers = schema.libraryThemePointers;
  return and(eq(pointers.organizationId, organizationId), projectId ? eq(pointers.projectId, projectId) : isNull(pointers.projectId));
}

/** The org pointer and, when `projectId` is given, that project's pointer, each with its item. */
async function loadPointers(executor: Executor, organizationId: string, projectId: string | null) {
  const pointers = schema.libraryThemePointers;
  const setter = alias(schema.users, "library_theme_pointer_setter");
  const rows = await executor
    .select({
      pointer: pointers,
      item: schema.libraryItems,
      projectId: schema.projects.id,
      projectSlug: schema.projects.slug,
      projectName: schema.projects.name,
      setByName: setter.displayName,
    })
    .from(pointers)
    .innerJoin(schema.libraryItems, eq(schema.libraryItems.id, pointers.itemId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.libraryItems.projectId))
    .leftJoin(setter, eq(setter.id, pointers.setByUserId))
    .where(
      and(
        eq(pointers.organizationId, organizationId),
        projectId ? or(isNull(pointers.projectId), eq(pointers.projectId, projectId)) : isNull(pointers.projectId),
      ),
    );
  const toRow = (row: (typeof rows)[number]): PointerRow => ({
    pointer: row.pointer,
    item: row.item,
    itemProject: row.projectId && row.projectSlug ? { id: row.projectId, slug: row.projectSlug, name: row.projectName ?? row.projectSlug } : null,
    setByName: row.setByName ?? null,
  });
  const org = rows.find((row) => row.pointer.projectId === null);
  const project = projectId ? rows.find((row) => row.pointer.projectId === projectId) : undefined;
  return { org: org ? toRow(org) : null, project: project ? toRow(project) : null };
}

/** The published version a pointer applies, or null when its item is archived, unpublished or out of scope. */
function liveVersion(row: PointerRow) {
  const { item, pointer } = row;
  if (item.kind !== "theme" || item.organizationId !== pointer.organizationId || item.archivedAt) return null;
  if (item.projectId !== null && item.projectId !== pointer.projectId) return null;
  if (!item.currentVersionId || !item.currentVersionNumber) return null;
  return { versionId: item.currentVersionId, versionNumber: item.currentVersionNumber };
}

function livePointer(row: PointerRow | null, whose: string, warnings: string[]) {
  if (!row) return null;
  const live = liveVersion(row);
  if (live) return { row, ...live };
  warnings.push(`The ${whose} theme ${pointerRef(row)} is archived or has no published version, so it is skipped.`);
  return null;
}

async function loadVersion(executor: Executor, versionId: string) {
  const [version] = await executor
    .select({ contentHash: schema.libraryVersions.contentHash })
    .from(schema.libraryVersions)
    .where(eq(schema.libraryVersions.id, versionId))
    .limit(1);
  const files: LibraryFileText[] = await executor
    .select({ path: schema.libraryFiles.path, content: schema.libraryFiles.content })
    .from(schema.libraryFiles)
    .where(eq(schema.libraryFiles.versionId, versionId))
    .orderBy(schema.libraryFiles.path);
  return { contentHash: version?.contentHash ?? "", files };
}

function pointerRef(row: Pick<PointerRow, "item" | "itemProject">) {
  return `${row.itemProject ? row.itemProject.slug : LIBRARY_ORG_SCOPE}/${row.item.slug}`;
}

function serializePointer(row: PointerRow): ThemePointerView {
  return {
    ref: pointerRef(row),
    itemId: row.item.id,
    scope: row.itemProject ? "project" : "org",
    slug: row.item.slug,
    name: row.item.name,
    setAt: iso(row.pointer.setAt),
    setBy: { name: row.setByName },
  };
}

function targetView(target: SelectedItem): ThemePointerView {
  return {
    ref: pointerRef({ item: target.item, itemProject: target.project }),
    itemId: target.item.id,
    scope: target.project ? "project" : "org",
    slug: target.item.slug,
    name: target.item.name,
    setAt: null,
    setBy: null,
  };
}

const THEME_REF_PATTERN = /^(?:([^/]+)\/)?([^/]+)$/;

/**
 * The theme `ref` names (`org/<slug>`, `<project>/<slug>`, or a bare slug in
 * the pointer's view). An org pointer takes only org themes; a project pointer
 * org themes and its own (`theme_out_of_scope`). The theme needs a published
 * version and must not be archived (`not_published`).
 */
async function resolveThemeTarget(workspace: LibraryWorkspace, ref: string, project: ProjectSummary | null) {
  const match = THEME_REF_PATTERN.exec(ref);
  const scopeRef = match?.[1] ?? null;
  const slug = match?.[2] ?? "";
  if (!match || !isLibrarySlug(slug)) throw notFound("Theme not found.");
  const items = schema.libraryItems;
  let scope: SQL | undefined;
  if (scopeRef === null) {
    scope = project ? or(isNull(items.projectId), eq(items.projectId, project.id)) : isNull(items.projectId);
  } else if (scopeRef === LIBRARY_ORG_SCOPE) {
    scope = isNull(items.projectId);
  } else {
    const owner = await findProject(workspace, scopeRef, "read");
    if (!owner) throw notFound("Theme not found.");
    scope = eq(items.projectId, owner.id);
  }
  const rows = await selectItems(db, {
    where: and(eq(items.organizationId, workspace.organization.id), eq(items.kind, "theme"), eq(items.slug, slug), scope),
    limit: 2,
  });
  const row = rows.sort((a, b) => Number(a.item.projectId !== null) - Number(b.item.projectId !== null))[0];
  if (!row) throw notFound("Theme not found.");
  const itemRef = pointerRef({ item: row.item, itemProject: row.project });
  if (row.item.projectId !== null && row.item.projectId !== project?.id) {
    throw conflict(
      "theme_out_of_scope",
      project
        ? `${itemRef} belongs to another project. A project uses an org theme or one of its own.`
        : `${itemRef} is a project theme. The organization's theme must be an org theme.`,
    );
  }
  if (row.item.archivedAt || !row.item.currentVersionId) {
    throw conflict("not_published", `${itemRef} is archived or has no published version. Publish it first.`);
  }
  return row;
}

/** Active Pages sites whose theme follows this pointer: the project's, or the org's minus projects with their own theme. */
async function listAffectedHosts(organizationId: string, project: ProjectSummary | null): Promise<AffectedHost[]> {
  const sites = schema.pageSites;
  const routes = schema.pageRoutes;
  let projectScope: SQL | undefined;
  if (project) {
    projectScope = eq(sites.projectId, project.id);
  } else {
    const pointers = schema.libraryThemePointers;
    const overriding = await db
      .select({ projectId: pointers.projectId })
      .from(pointers)
      .innerJoin(schema.libraryItems, eq(schema.libraryItems.id, pointers.itemId))
      .where(
        and(
          eq(pointers.organizationId, organizationId),
          isNotNull(pointers.projectId),
          isNull(schema.libraryItems.archivedAt),
          isNotNull(schema.libraryItems.currentVersionId),
        ),
      );
    const ids = overriding.map((row) => row.projectId).filter((id): id is string => Boolean(id));
    projectScope = ids.length ? notInArray(sites.projectId, ids) : undefined;
  }
  const rows = await db
    .select({ siteSlug: sites.slug, hostname: sites.defaultHostname, routes: sql<number>`count(${routes.id})::int` })
    .from(sites)
    .leftJoin(routes, and(eq(routes.siteId, sites.id), eq(routes.status, "active")))
    .where(and(eq(sites.organizationId, organizationId), eq(sites.status, "active"), projectScope))
    .groupBy(sites.id)
    .orderBy(asc(sites.defaultHostname));
  return rows.map((row) => ({ siteSlug: row.siteSlug, hostname: row.hostname, routes: Number(row.routes) }));
}
