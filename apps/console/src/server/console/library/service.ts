// The Library: skills, agent definitions, themes and widgets an organization
// shares, owned by the organization or by one project, versioned, and searched
// by the OSS (`ravi skills|agents|themes|widgets search|show|publish`) and the
// Console UI. See `.ravi/specs/console/library`.

import { and, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { canAccessProject, findAccessibleProjectRecord, type ProjectAccessAction } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import { isAuditPassing, readScriptAudit } from "@/shared/widgets/script/audit";
import { WIDGET_SCRIPT_FILE } from "@/shared/widgets/script/check";

import { assertAgentSkillsInScope, isLibrarySlug, LIBRARY_LIMITS, parseAgentManifest } from "./files";
import {
  assertScriptPublisher,
  assertSlugAllowed,
  isCompiledKind,
  kindNoun,
  kindSearchBody,
  kindText,
  LIBRARY_KINDS,
  prepareKindFiles,
  SCRIPT_PUBLISHING_ORG_ROLES,
  type LibraryKind,
} from "./kinds";
import { buildLibraryTsQuery, librarySearchParts } from "./search";

export { kindNoun, type LibraryKind } from "./kinds";

export const LIBRARY_FEATURE_KEY = "console.library";
export const LIBRARY_ORG_SCOPE = "org";
export const LIBRARY_SEARCH_LIMIT_DEFAULT = 10;
export const LIBRARY_SEARCH_LIMIT_MAX = 50;

export const PUBLISHING_ORG_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
export const PROPOSING_ORG_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "developer"]);

export type LibraryWorkspace = {
  authorization?: import("../authorization/identity").AuthorizationActor["delegation"];
  user: { id: string };
  /** The slug, when the caller has it, names the organization in Console links. */
  organization: { id: string; slug?: string | null };
  membership: { role: string };
};

/** Who is acting, for the version's author and the audit event. */
export type LibraryActor = {
  surface: "cli" | "console";
  requestId: string;
  localInstallationId: string | null;
  /** The Console's origin, for links in notifications. */
  origin: string;
};

export type ProjectSummary = { id: string; slug: string; name: string };
export type ItemRow = typeof schema.libraryItems.$inferSelect;
export type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

export const publishBodySchema = z
  .object({
    kind: z.enum(LIBRARY_KINDS).optional(),
    scope: z.enum(["org", "project"]),
    project: z.string().trim().min(1).max(200).optional(),
    slug: z.string(),
    name: z.string().trim().min(1).max(LIBRARY_LIMITS.maxNameLength).optional(),
    /** Required, except for themes and widgets, which fall back to their files. */
    description: z.string().trim().min(1).max(LIBRARY_LIMITS.maxDescriptionLength).optional(),
    externalAllowed: z.boolean().optional(),
    note: z.string().trim().max(LIBRARY_LIMITS.maxNoteLength).optional(),
    baseVersion: z.number().int().min(0).optional(),
    files: z
      .array(z.object({ path: z.string().max(LIBRARY_LIMITS.maxPathLength), content: z.string() }).strict())
      .max(LIBRARY_LIMITS.maxFiles),
  })
  .strict();

/** The statuses of versions that were published at some point. */
export const PUBLISHED_STATUSES = or(
  eq(schema.libraryVersions.status, "published"),
  eq(schema.libraryVersions.status, "superseded"),
);

// ---------------------------------------------------------------------------
// Reads

export async function searchLibrary(input: {
  workspace: LibraryWorkspace;
  kind: LibraryKind;
  query: string;
  projectRef: string | null;
  limit?: number;
}) {
  await assertLibraryFeature(input.workspace);
  const project = input.projectRef ? await requireProject(input.workspace, input.projectRef, "read") : null;
  const limit = clampLimit(input.limit);
  const tsQuery = buildLibraryTsQuery(input.query);
  const match = tsQuery ? sql`to_tsquery('simple', ${tsQuery})` : null;
  const rank = match ? sql<number>`ts_rank_cd(${schema.libraryItems.searchVector}, ${match})` : sql<number>`0::real`;

  const rows = await selectItems(db, {
    where: and(
      eq(schema.libraryItems.organizationId, input.workspace.organization.id),
      eq(schema.libraryItems.kind, input.kind),
      isNull(schema.libraryItems.archivedAt),
      sql`${schema.libraryItems.currentVersionId} IS NOT NULL`,
      visibleScope(project?.id ?? null),
      match ? sql`${schema.libraryItems.searchVector} @@ ${match}` : undefined,
    ),
    orderBy: [...(match ? [desc(rank)] : []), desc(schema.libraryItems.publishedAt), schema.libraryItems.slug],
    limit,
    extra: { score: rank },
  });

  const roles = await scopeRoles(input.workspace, project?.id ?? null);
  return {
    items: rows.map((row) => ({ ...serializeLibraryItem(row), score: roundScore(Number(row.extra.score ?? 0)) })),
    query: input.query,
    project: project ? summarizeProject(project) : null,
    /** What the caller may do in this view's own scope (the project when given, else the org). */
    can: { propose: roles.canPropose, review: roles.canReview },
  };
}

/**
 * One item with a published version and its files. `scopeRef` is `org`, a
 * project ref, or null for a bare slug resolved in the caller's view (org
 * items plus `projectRef`'s).
 */
export async function showLibraryItem(input: {
  workspace: LibraryWorkspace;
  kind: LibraryKind;
  scopeRef: string | null;
  slug: string;
  projectRef?: string | null;
  version?: number | null;
}) {
  await assertLibraryFeature(input.workspace);
  const row = await findVisibleItem(input);
  const versionNumber = input.version ?? row.item.currentVersionNumber;
  if (!versionNumber) throw notFound();
  const [version] = await db
    .select()
    .from(schema.libraryVersions)
    .where(
      and(
        eq(schema.libraryVersions.itemId, row.item.id),
        eq(schema.libraryVersions.versionNumber, versionNumber),
        PUBLISHED_STATUSES,
      ),
    )
    .limit(1);
  if (!version || version.versionNumber === null) throw notFound("That version does not exist.");
  const files = await db
    .select({
      path: schema.libraryFiles.path,
      content: schema.libraryFiles.content,
      bytes: schema.libraryFiles.bytes,
      sha256: schema.libraryFiles.sha256,
    })
    .from(schema.libraryFiles)
    .where(eq(schema.libraryFiles.versionId, version.id))
    .orderBy(schema.libraryFiles.path);
  return {
    item: serializeLibraryItem(row),
    version: {
      number: version.versionNumber,
      status: version.status,
      note: version.note,
      contentHash: version.contentHash,
      publishedAt: iso(version.publishedAt),
      files,
      ...(row.item.kind === "agent" ? { agent: agentManifestOf(files) } : {}),
      ...(row.item.kind === "widget" ? widgetScriptState(files, version.scriptAudit, input.workspace.membership.role) : {}),
    },
  };
}

/**
 * A widget version's code and its accessibility audit: `script` (sha256 and
 * size of widget.js, null without one), the stored `scriptAudit`, whether it
 * passes for this script, and whether the caller may run it (org owner or
 * admin).
 */
function widgetScriptState(files: readonly { path: string; bytes: number; sha256: string }[], stored: unknown, role: string) {
  const file = files.find((entry) => entry.path === WIDGET_SCRIPT_FILE);
  const script = file ? { sha256: file.sha256, bytes: file.bytes } : null;
  const scriptAudit = script ? readScriptAudit(stored) : null;
  return {
    script,
    scriptAudit,
    scriptAudited: script ? isAuditPassing(scriptAudit, script.sha256) : true,
    canAudit: script !== null && SCRIPT_PUBLISHING_ORG_ROLES.has(role),
  };
}

/** The manifest of a stored agent definition; files were validated when written. */
export function agentManifestOf(files: readonly { path: string; content: string }[]) {
  try {
    return parseAgentManifest(files.find((file) => file.path === "agent.json")?.content);
  } catch {
    return { provider: null, model: null, profile: null, skills: [] };
  }
}

export async function listLibraryVersions(input: {
  workspace: LibraryWorkspace;
  kind: LibraryKind;
  scopeRef: string;
  slug: string;
}) {
  await assertLibraryFeature(input.workspace);
  const row = await findVisibleItem(input);
  const publisher = alias(schema.users, "library_version_publisher");
  const versions = await db
    .select({ version: schema.libraryVersions, publisherName: publisher.displayName })
    .from(schema.libraryVersions)
    .leftJoin(publisher, eq(publisher.id, schema.libraryVersions.publishedByUserId))
    .where(and(eq(schema.libraryVersions.itemId, row.item.id), PUBLISHED_STATUSES))
    .orderBy(desc(schema.libraryVersions.versionNumber));
  return {
    item: serializeLibraryItem(row),
    versions: versions.map(({ version, publisherName }) => ({
      number: version.versionNumber,
      status: version.status,
      note: version.note,
      contentHash: version.contentHash,
      fileCount: version.fileCount,
      totalBytes: version.totalBytes,
      publishedAt: iso(version.publishedAt),
      publishedBy: version.publishedByUserId ? { name: publisherName ?? null } : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes

export async function publishLibraryItem(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  kind?: LibraryKind;
  body: unknown;
}) {
  await assertLibraryFeature(input.workspace);
  const parsed = publishBodySchema.safeParse(input.body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid publish request: ${fields.join(", ")}.`);
  }
  const body = parsed.data;
  const kind: LibraryKind = input.kind ?? "skill";
  if (body.kind && body.kind !== kind) throw cliApiError(400, "PAYLOAD_INVALID", `This route publishes ${kindNoun(kind)}s.`);
  if (body.description === undefined && !isCompiledKind(kind)) throw cliApiError(400, "PAYLOAD_INVALID", "Invalid publish request: description.");
  if (!isLibrarySlug(body.slug)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "A slug is 1-64 characters of a-z, 0-9 and -, starting and ending with a letter or digit.");
  }
  assertSlugAllowed(kind, body.slug);
  const project = await resolvePublishScope(input.workspace, body.scope, body.project, kind);
  const prepared = prepareKindFiles(kind, body.files);
  assertScriptPublisher(input.workspace.membership.role, kind, prepared.files);
  assertAgentSkillsInScope(prepared.manifest, project?.slug ?? null);
  const { name, description } = kindText({
    kind,
    name: body.name,
    description: body.description,
    meta: prepared.meta,
    fallbackName: body.slug,
    what: "publish",
  });
  const externalAllowed = body.externalAllowed ?? false;
  const search = librarySearchParts({ slug: body.slug, name, description, body: kindSearchBody(kind, prepared.files) });
  const organizationId = input.workspace.organization.id;
  const now = new Date();

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`library:${organizationId}:${kind}:${body.slug}`}))`);

    const sameSlug = await tx
      .select()
      .from(schema.libraryItems)
      .where(
        and(
          eq(schema.libraryItems.organizationId, organizationId),
          eq(schema.libraryItems.kind, kind),
          eq(schema.libraryItems.slug, body.slug),
        ),
      );
    const existing = sameSlug.find((item) => (project ? item.projectId === project.id : item.projectId === null)) ?? null;
    await assertSlugFree(tx, input.workspace, { kind, slug: body.slug, project, sameSlug, verb: "publish" });

    const currentVersion = existing?.currentVersionNumber ?? 0;
    if (body.baseVersion !== undefined && !baseMatches(existing, body.baseVersion)) {
      throw conflict("stale_base", `The published version is ${currentVersion}, not ${body.baseVersion}. Show it again before publishing.`, {
        currentVersion,
      });
    }

    let currentHash: string | null = null;
    if (existing?.currentVersionId) {
      const [current] = await tx
        .select({ contentHash: schema.libraryVersions.contentHash })
        .from(schema.libraryVersions)
        .where(eq(schema.libraryVersions.id, existing.currentVersionId))
        .limit(1);
      currentHash = current?.contentHash ?? null;
    }

    if (existing && !existing.archivedAt && currentHash === prepared.contentHash) {
      // Same files: no new version. Item metadata still follows the request.
      const changed =
        existing.name !== name || existing.description !== description || existing.externalAllowed !== externalAllowed;
      if (!changed) return { itemId: existing.id, versionNumber: currentVersion, unchanged: true };
      await tx
        .update(schema.libraryItems)
        .set({ name, description, externalAllowed, ...searchColumns(search), updatedAt: now })
        .where(eq(schema.libraryItems.id, existing.id));
      await tx.insert(schema.auditEvents).values(
        auditEvent(input, {
          organizationId,
          projectId: project?.id ?? null,
          itemId: existing.id,
          action: `library.${kind}.updated`,
          before: { name: existing.name, description: existing.description, externalAllowed: existing.externalAllowed },
          after: { name, description, externalAllowed, version: currentVersion },
        }),
      );
      return { itemId: existing.id, versionNumber: currentVersion, unchanged: true };
    }

    let itemId = existing?.id ?? null;
    if (!itemId) {
      const [created] = await tx
        .insert(schema.libraryItems)
        .values({
          organizationId,
          projectId: project?.id ?? null,
          kind,
          slug: body.slug,
          name,
          description,
          externalAllowed,
          createdByUserId: input.workspace.user.id,
        })
        .returning({ id: schema.libraryItems.id });
      if (!created) throw new Error("library_items insert returned no row");
      itemId = created.id;
    }

    const [maxRow] = await tx
      .select({ maxNumber: sql<number>`coalesce(max(${schema.libraryVersions.versionNumber}), 0)::int` })
      .from(schema.libraryVersions)
      .where(eq(schema.libraryVersions.itemId, itemId));
    const versionNumber = Number(maxRow?.maxNumber ?? 0) + 1;

    await tx
      .update(schema.libraryVersions)
      .set({ status: "superseded", updatedAt: now })
      .where(and(eq(schema.libraryVersions.itemId, itemId), eq(schema.libraryVersions.status, "published")));
    const [version] = await tx
      .insert(schema.libraryVersions)
      .values({
        itemId,
        organizationId,
        versionNumber,
        status: "published",
        name,
        description,
        externalAllowed,
        contentHash: prepared.contentHash,
        fileCount: prepared.files.length,
        totalBytes: prepared.totalBytes,
        note: body.note || null,
        authorType: "user",
        authorUserId: input.workspace.user.id,
        localInstallationId: input.actor.localInstallationId,
        publishedAt: now,
        publishedByUserId: input.workspace.user.id,
      })
      .returning({ id: schema.libraryVersions.id });
    if (!version) throw new Error("library_versions insert returned no row");
    await tx.insert(schema.libraryFiles).values(prepared.files.map((file) => ({ versionId: version.id, ...file })));
    await tx
      .update(schema.libraryItems)
      .set({
        name,
        description,
        externalAllowed,
        currentVersionId: version.id,
        currentVersionNumber: versionNumber,
        publishedAt: now,
        archivedAt: null,
        archivedByUserId: null,
        ...searchColumns(search),
        updatedAt: now,
      })
      .where(eq(schema.libraryItems.id, itemId));
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId,
        projectId: project?.id ?? null,
        itemId,
        action: existing?.archivedAt ? `library.${kind}.restored` : `library.${kind}.published`,
        before: existing ? { version: currentVersion, archived: Boolean(existing.archivedAt) } : null,
        after: { version: versionNumber, contentHash: prepared.contentHash, fileCount: prepared.files.length },
      }),
    );
    return { itemId, versionNumber, unchanged: false };
  });

  const [row] = await selectItems(db, { where: eq(schema.libraryItems.id, outcome.itemId), limit: 1 });
  if (!row) throw new Error("published library item disappeared");
  return {
    status: outcome.unchanged ? 200 : 201,
    payload: {
      item: serializeLibraryItem(row),
      version: { number: outcome.versionNumber, contentHash: row.versionContentHash },
      unchanged: outcome.unchanged,
      ...(isCompiledKind(kind) ? { diagnostics: prepared.diagnostics } : {}),
    },
  };
}

export async function archiveLibraryItem(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  kind: LibraryKind;
  scopeRef: string;
  slug: string;
}) {
  await assertLibraryFeature(input.workspace);
  const project = input.scopeRef === LIBRARY_ORG_SCOPE ? null : await findProject(input.workspace, input.scopeRef, "read");
  if (input.scopeRef !== LIBRARY_ORG_SCOPE && !project) throw notFound();
  const [item] = await db
    .select()
    .from(schema.libraryItems)
    .where(itemKeyPredicate(input.workspace.organization.id, input.kind, project?.id ?? null, input.slug))
    .limit(1);
  if (!item) throw notFound();
  await resolvePublishScope(input.workspace, project ? "project" : "org", project?.id, input.kind);
  if (!item.archivedAt) {
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(schema.libraryItems)
        .set({ archivedAt: now, archivedByUserId: input.workspace.user.id, updatedAt: now })
        .where(eq(schema.libraryItems.id, item.id));
      await tx.insert(schema.auditEvents).values(
        auditEvent(input, {
          organizationId: item.organizationId,
          projectId: item.projectId,
          itemId: item.id,
          action: `library.${item.kind}.archived`,
          before: { archived: false },
          after: { archived: true, version: item.currentVersionNumber },
        }),
      );
    });
  }
  const [row] = await selectItems(db, { where: eq(schema.libraryItems.id, item.id), limit: 1 });
  if (!row) throw notFound();
  return { item: serializeLibraryItem(row) };
}

// ---------------------------------------------------------------------------
// Helpers

/** What the caller may do in a scope: the org (`projectId` null) or one project. */
export type ScopeRoles = { canRead: boolean; canPropose: boolean; canReview: boolean };

export async function scopeRoles(workspace: LibraryWorkspace, projectId: string | null): Promise<ScopeRoles> {
  const role = workspace.membership.role;
  if (!projectId) {
    return { canRead: true, canPropose: PROPOSING_ORG_ROLES.has(role), canReview: PUBLISHING_ORG_ROLES.has(role) };
  }
  const [canRead, canPropose, canReview] = await Promise.all([
    canAccessProject(workspace, projectId, "read"),
    canAccessProject(workspace, projectId, "write"),
    canAccessProject(workspace, projectId, "admin"),
  ]);
  return { canRead, canPropose, canReview };
}

export async function assertLibraryFeature(workspace: LibraryWorkspace) {
  const access = await getConsoleFeatureAccessForOrganizationRole({
    organizationId: workspace.organization.id,
    role: workspace.membership.role,
  });
  if (!access.byKey[LIBRARY_FEATURE_KEY].enabled) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "The Library (console.library) is not enabled for this organization or role.");
  }
}

export async function resolvePublishScope(
  workspace: LibraryWorkspace,
  scope: "org" | "project",
  projectRef: string | undefined,
  kind: LibraryKind = "skill",
) {
  if (scope === "org") {
    if (projectRef) throw cliApiError(400, "PAYLOAD_INVALID", "An org item takes no project.");
    if (!PUBLISHING_ORG_ROLES.has(workspace.membership.role)) {
      throw cliApiError(403, "ORG_ACCESS_DENIED", `Only organization owners and admins publish org ${kindNoun(kind)}s.`);
    }
    return null;
  }
  if (!projectRef) throw cliApiError(400, "PAYLOAD_INVALID", "A project item needs project.");
  const project = await findProject(workspace, projectRef, "admin");
  if (!project) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", `Only project admins and organization owners and admins publish project ${kindNoun(kind)}s.`);
  }
  return project;
}

async function findVisibleItem(input: {
  workspace: LibraryWorkspace;
  kind: LibraryKind;
  scopeRef: string | null;
  slug: string;
  projectRef?: string | null;
}) {
  if (!isLibrarySlug(input.slug)) throw notFound();
  const organizationId = input.workspace.organization.id;
  let where: SQL | undefined;
  if (input.scopeRef === null) {
    const project = input.projectRef ? await findProject(input.workspace, input.projectRef, "read") : null;
    if (input.projectRef && !project) throw notFound();
    where = and(
      eq(schema.libraryItems.organizationId, organizationId),
      eq(schema.libraryItems.kind, input.kind),
      eq(schema.libraryItems.slug, input.slug),
      visibleScope(project?.id ?? null),
    );
  } else if (input.scopeRef === LIBRARY_ORG_SCOPE) {
    where = itemKeyPredicate(organizationId, input.kind, null, input.slug);
  } else {
    const project = await findProject(input.workspace, input.scopeRef, "read");
    if (!project) throw notFound();
    where = itemKeyPredicate(organizationId, input.kind, project.id, input.slug);
  }
  const rows = await selectItems(db, {
    where: and(where, isNull(schema.libraryItems.archivedAt), sql`${schema.libraryItems.currentVersionId} IS NOT NULL`),
    limit: 2,
  });
  // Org first, then the project: slugs are unique across both, so this only orders a repaired collision.
  const row = rows.sort((a, b) => Number(a.item.projectId !== null) - Number(b.item.projectId !== null))[0];
  if (!row) throw notFound();
  return row;
}

export function itemKeyPredicate(organizationId: string, kind: LibraryKind, projectId: string | null, slug: string) {
  return and(
    eq(schema.libraryItems.organizationId, organizationId),
    eq(schema.libraryItems.kind, kind),
    eq(schema.libraryItems.slug, slug),
    projectId ? eq(schema.libraryItems.projectId, projectId) : isNull(schema.libraryItems.projectId),
  );
}

function visibleScope(projectId: string | null) {
  return projectId
    ? or(isNull(schema.libraryItems.projectId), eq(schema.libraryItems.projectId, projectId))
    : isNull(schema.libraryItems.projectId);
}

export async function findProject(workspace: LibraryWorkspace, projectRef: string, action: ProjectAccessAction) {
  return findAccessibleProjectRecord(workspace, projectRef, action);
}

async function requireProject(workspace: LibraryWorkspace, projectRef: string, action: ProjectAccessAction) {
  const project = await findProject(workspace, projectRef, action);
  if (!project) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return project;
}

export type SelectedItem = {
  item: ItemRow;
  project: ProjectSummary | null;
  publisherName: string | null;
  publisherId: string | null;
  versionContentHash: string | null;
  extra: Record<string, unknown>;
};

export async function selectItems(
  executor: Executor,
  options: { where: SQL | undefined; orderBy?: (SQL | ReturnType<typeof desc> | typeof schema.libraryItems.slug)[]; limit: number; extra?: Record<string, SQL> },
): Promise<SelectedItem[]> {
  const publisher = alias(schema.users, "library_item_publisher");
  const rows = await executor
    .select({
      item: schema.libraryItems,
      projectId: schema.projects.id,
      projectSlug: schema.projects.slug,
      projectName: schema.projects.name,
      publisherId: schema.libraryVersions.publishedByUserId,
      publisherName: publisher.displayName,
      versionContentHash: schema.libraryVersions.contentHash,
      ...(options.extra ?? {}),
    })
    .from(schema.libraryItems)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.libraryItems.projectId))
    .leftJoin(schema.libraryVersions, eq(schema.libraryVersions.id, schema.libraryItems.currentVersionId))
    .leftJoin(publisher, eq(publisher.id, schema.libraryVersions.publishedByUserId))
    .where(options.where)
    .orderBy(...(options.orderBy ?? [schema.libraryItems.slug]))
    .limit(options.limit);
  return rows.map((row) => {
    const record = row as typeof row & Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(options.extra ?? {})) extra[key] = record[key];
    return {
      item: row.item,
      project: row.projectId && row.projectSlug ? { id: row.projectId, slug: row.projectSlug, name: row.projectName ?? row.projectSlug } : null,
      publisherId: row.publisherId ?? null,
      publisherName: row.publisherName ?? null,
      versionContentHash: row.versionContentHash ?? null,
      extra,
    };
  });
}

export type LibraryItemView = ReturnType<typeof serializeLibraryItem>;

export function serializeLibraryItem(row: Pick<SelectedItem, "item" | "project" | "publisherId" | "publisherName" | "versionContentHash">) {
  const { item, project } = row;
  return {
    ref: `${project ? project.slug : LIBRARY_ORG_SCOPE}/${item.slug}`,
    kind: item.kind,
    scope: project ? ("project" as const) : ("org" as const),
    project: project ? summarizeProject(project) : null,
    slug: item.slug,
    name: item.name,
    description: item.description,
    externalAllowed: item.externalAllowed,
    version: item.currentVersionNumber,
    contentHash: row.versionContentHash,
    publishedAt: iso(item.publishedAt),
    publishedBy: row.publisherId ? { name: row.publisherName } : null,
    archived: item.archivedAt !== null,
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function summarizeProject(project: ProjectSummary) {
  return { id: project.id, slug: project.slug, name: project.name };
}

export function searchColumns(search: ReturnType<typeof librarySearchParts>) {
  return {
    searchText: search.text,
    searchVector: sql`setweight(to_tsvector('simple', ${search.head}), 'A') || setweight(to_tsvector('simple', ${search.description}), 'B') || setweight(to_tsvector('simple', ${search.body}), 'C')`,
  } as unknown as { searchText: string; searchVector: string };
}

export function auditEvent(
  input: { workspace: LibraryWorkspace; actor: LibraryActor },
  event: {
    organizationId: string;
    projectId: string | null;
    itemId: string;
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  },
): typeof schema.auditEvents.$inferInsert {
  return {
    organizationId: event.organizationId,
    projectId: event.projectId,
    actorType: input.actor.surface === "cli" ? "cli" : "user",
    actorId: input.workspace.user.id,
    targetType: "library_item",
    targetId: event.itemId,
    action: event.action,
    requestId: input.actor.requestId,
    beforeJson: event.before ?? undefined,
    afterJson: event.after,
    metadataJson: {
      surface: input.actor.surface,
      ...(input.actor.localInstallationId ? { localInstallationId: input.actor.localInstallationId } : {}),
    },
  };
}

function clampLimit(limit: number | undefined) {
  if (!limit || !Number.isFinite(limit) || limit < 1) return LIBRARY_SEARCH_LIMIT_DEFAULT;
  return Math.min(Math.floor(limit), LIBRARY_SEARCH_LIMIT_MAX);
}

function roundScore(score: number) {
  return Math.round(score * 10_000) / 10_000;
}

export function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

export function notFound(message = "Not found in the Library.") {
  return cliApiError(404, "NOT_FOUND", message);
}

/**
 * A 409 `CONFLICT`. `reason` is the machine code; `conflict` repeats it, because
 * the OSS error envelope redacts `reason` as free text and keeps `conflict`.
 */
export function conflict(reason: string, message: string, details: Record<string, unknown> = {}) {
  return cliApiError(409, "CONFLICT", message, { reason, conflict: reason, ...details });
}

/**
 * Whether a writer's `baseVersion` is the item's current one. An archived item
 * has no version a client can read (show answers 404), so a client that read
 * nothing sends 0, and 0 matches it: the write restores the item.
 */
export function baseMatches(item: Pick<ItemRow, "currentVersionNumber" | "archivedAt"> | null, baseVersion: number) {
  const current = item?.currentVersionNumber ?? 0;
  return baseVersion === current || (Boolean(item?.archivedAt) && baseVersion === 0);
}

/**
 * Refuses a slug another scope of the organization holds: a kind's slug names
 * one item across the org and its projects, archived ones included. The
 * message names the holder (`org/<slug>`, or `<project>/<slug>` when the
 * caller can read that project) and what to do instead.
 */
export async function assertSlugFree(
  tx: Executor,
  workspace: LibraryWorkspace,
  input: { kind: LibraryKind; slug: string; project: ProjectSummary | null; sameSlug: readonly ItemRow[]; verb: "publish" | "propose" },
) {
  const { kind, slug, project, sameSlug, verb } = input;
  const noun = kindNoun(kind);
  // A project item clashes with the org's; projects may share a slug among themselves.
  const holder = sameSlug.find((item) => (project ? item.projectId === null : item.projectId !== null));
  if (!holder) return;
  const archived = Boolean(holder.archivedAt);
  const state = archived ? ", archived" : "";
  const Verb = verb === "propose" ? "Propose" : "Publish";
  const rule = `a slug names one ${noun} across the organization and its projects`;
  if (holder.projectId === null) {
    throw conflict(
      "slug_taken_in_org",
      `The organization already has a ${noun} named "${slug}" (org/${slug}${state}), and ${rule}. ${Verb} to org/${slug} instead (--scope org), or pick another slug.`,
      { ref: `org/${slug}`, scope: "org", archived },
    );
  }
  const [holderProject] = await tx
    .select({ id: schema.projects.id, slug: schema.projects.slug })
    .from(schema.projects)
    .where(eq(schema.projects.id, holder.projectId))
    .limit(1);
  if (holderProject && (await scopeRoles(workspace, holderProject.id)).canRead) {
    throw conflict(
      "slug_taken_in_project",
      `Project "${holderProject.slug}" already has a ${noun} named "${slug}" (${holderProject.slug}/${slug}${state}), and ${rule}. ` +
        `${Verb} to that project instead (--scope ${holderProject.slug}), or pick another slug.`,
      { ref: `${holderProject.slug}/${slug}`, scope: "project", project: holderProject.slug, archived },
    );
  }
  throw conflict("slug_taken_in_project", `A project you cannot read already has a ${noun} named "${slug}", and ${rule}. Pick another slug.`, {
    scope: "project",
    archived,
  });
}
