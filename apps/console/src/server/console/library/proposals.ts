// Library collaboration (phase 2): drafts and proposals of new versions,
// review comments anchored to file lines, publish or reject by a scope admin,
// and revert to an older version. See `.ravi/specs/console/library`.

import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { orgPath, orgSegment } from "@/lib/console-paths";
import { cliApiError } from "@/server/cli/errors";
import { recordAgentInboxItem } from "@/server/console/agent-inbox";
import { listAccessibleProjectRecords } from "@/server/console/project-access";
import { db, schema } from "@/server/db";

import { assertAgentSkillsInScope, isLibrarySlug, LIBRARY_LIMITS } from "./files";
import {
  assertScriptPublisher,
  assertSlugAllowed,
  compileKindFiles,
  isCompiledKind,
  kindSearchBody,
  kindText,
  LIBRARY_KINDS,
  prepareKindFiles,
} from "./kinds";
import { librarySearchParts } from "./search";
import {
  assertLibraryFeature,
  assertSlugFree,
  auditEvent,
  baseMatches,
  conflict,
  findProject,
  iso,
  itemKeyPredicate,
  LIBRARY_ORG_SCOPE,
  notFound,
  PROPOSING_ORG_ROLES,
  PUBLISHED_STATUSES,
  scopeRoles,
  searchColumns,
  selectItems,
  serializeLibraryItem,
  summarizeProject,
  type Executor,
  kindNoun,
  type ItemRow,
  type LibraryActor,
  type LibraryKind,
  type LibraryWorkspace,
  type ProjectSummary,
  type ScopeRoles,
} from "./service";

export const LIBRARY_COMMENT_MAX_LENGTH = 4000;
export const LIBRARY_REASON_MAX_LENGTH = 500;
const PROPOSAL_LIST_LIMIT = 100;
const OPEN_STATUSES = ["draft", "proposed"] as const;
const CLOSED_STATUSES = ["published", "superseded", "rejected", "withdrawn"] as const;

type VersionRow = typeof schema.libraryVersions.$inferSelect;
type ProposalStatus = VersionRow["status"];

export const agentSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const fileListSchema = z
  .array(z.object({ path: z.string().max(LIBRARY_LIMITS.maxPathLength), content: z.string() }).strict())
  .max(LIBRARY_LIMITS.maxFiles);

const contentFields = {
  name: z.string().trim().min(1).max(LIBRARY_LIMITS.maxNameLength).optional(),
  /** Required, except for themes and widgets, which fall back to their files. */
  description: z.string().trim().min(1).max(LIBRARY_LIMITS.maxDescriptionLength).optional(),
  externalAllowed: z.boolean().optional(),
  note: z.string().trim().max(LIBRARY_LIMITS.maxNoteLength).optional(),
  baseVersion: z.number().int().min(0).optional(),
  files: fileListSchema,
  submit: z.boolean().optional(),
  agent: agentSchema.optional(),
};

const createBodySchema = z
  .object({
    kind: z.enum(LIBRARY_KINDS).optional(),
    scope: z.enum(["org", "project"]),
    project: z.string().trim().min(1).max(200).optional(),
    slug: z.string(),
    ...contentFields,
  })
  .strict();

const updateBodySchema = z.object(contentFields).strict();

const decisionBodySchema = z.object({ agent: agentSchema.optional() }).strict();

const rejectBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(LIBRARY_REASON_MAX_LENGTH),
    agent: agentSchema.optional(),
  })
  .strict();

const commentBodySchema = z
  .object({
    body: z.string().trim().min(1).max(LIBRARY_COMMENT_MAX_LENGTH),
    path: z.string().max(LIBRARY_LIMITS.maxPathLength).optional(),
    line: z.number().int().min(1).optional(),
    parentId: z.string().uuid().optional(),
    agent: agentSchema.optional(),
  })
  .strict();

const authorAgentBodySchema = z.object({ agent: agentSchema.optional() }).strict();

// ---------------------------------------------------------------------------
// Roles in a scope

function canSeeProposal(version: VersionRow, roles: ScopeRoles, userId: string) {
  if (!roles.canRead) return false;
  if (version.status === "draft") return version.authorUserId === userId || roles.canReview;
  return true;
}

export function assertNotAgent(agent: unknown, verb: string) {
  if (agent) throw cliApiError(403, "ORG_ACCESS_DENIED", `Agents never ${verb} Library items; a person does it in the Console.`);
}

/** Skills and agents always send a description; themes and widgets may take theirs from their files. */
function assertDescription(kind: LibraryKind, description: string | undefined, what: string) {
  if (description === undefined && !isCompiledKind(kind)) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${what} request: description.`);
}

export function parseBody<T>(schemaToUse: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schemaToUse.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${what} request: ${fields.join(", ")}.`);
  }
  return parsed.data;
}

export function lockKey(organizationId: string, kind: LibraryKind, slug: string) {
  return sql`select pg_advisory_xact_lock(hashtext(${`library:${organizationId}:${kind}:${slug}`}))`;
}

// ---------------------------------------------------------------------------
// Items and proposals by reference

/** The organization whose Console URL links name; the slug when known, else its id. */
type LinkOrganization = { id: string; slug?: string | null };

type ItemContext = { item: ItemRow; project: ProjectSummary | null; roles: ScopeRoles; organization: LinkOrganization };

/** The item `<scope>/<slug>` names, published or not, when the caller reads its scope. */
export async function findItemForProposals(input: {
  workspace: LibraryWorkspace;
  kind: LibraryKind;
  scopeRef: string;
  slug: string;
}): Promise<ItemContext> {
  if (!isLibrarySlug(input.slug)) throw notFound();
  const project = input.scopeRef === LIBRARY_ORG_SCOPE ? null : await findProject(input.workspace, input.scopeRef, "read");
  if (input.scopeRef !== LIBRARY_ORG_SCOPE && !project) throw notFound();
  const [item] = await db
    .select()
    .from(schema.libraryItems)
    .where(itemKeyPredicate(input.workspace.organization.id, input.kind, project?.id ?? null, input.slug))
    .limit(1);
  if (!item) throw notFound();
  const roles = await scopeRoles(input.workspace, item.projectId);
  if (!roles.canRead) throw notFound();
  return { item, project: project ? summarizeProject(project) : null, roles, organization: input.workspace.organization };
}

async function findProposal(input: {
  workspace: LibraryWorkspace;
  kind: LibraryKind;
  scopeRef: string;
  slug: string;
  number: number;
}) {
  const context = await findItemForProposals(input);
  const [version] = await db
    .select()
    .from(schema.libraryVersions)
    .where(and(eq(schema.libraryVersions.itemId, context.item.id), eq(schema.libraryVersions.proposalNumber, input.number)))
    .limit(1);
  if (!version || !canSeeProposal(version, context.roles, input.workspace.user.id)) throw notFound("Proposal not found.");
  return { ...context, version };
}

// ---------------------------------------------------------------------------
// Serialization

type ProposalNames = { authorName: string | null; deciderName: string | null; openComments: number };

function serializeProposal(
  context: ItemContext,
  version: VersionRow,
  names: ProposalNames,
  userId: string,
) {
  const { item, project, roles } = context;
  const currentVersion = item.currentVersionNumber ?? 0;
  const open = version.status === "draft" || version.status === "proposed";
  const stale = open && (version.baseVersionNumber ?? 0) !== currentVersion;
  const isAuthor = version.authorUserId === userId;
  return {
    ref: `${project ? project.slug : LIBRARY_ORG_SCOPE}/${item.slug}`,
    number: version.proposalNumber,
    status: version.status,
    round: version.round,
    baseVersion: version.baseVersionNumber ?? 0,
    currentVersion,
    stale,
    publishedVersion: version.versionNumber,
    name: version.name ?? item.name,
    description: version.description ?? item.description,
    externalAllowed: version.externalAllowed ?? item.externalAllowed,
    note: version.note,
    contentHash: version.contentHash,
    fileCount: version.fileCount,
    totalBytes: version.totalBytes,
    author: { name: names.authorName, agentId: version.authorAgentId, self: isAuthor },
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    proposedAt: iso(version.proposedAt),
    decidedAt: iso(version.decidedAt),
    decidedBy: version.decidedByUserId ? { name: names.deciderName } : null,
    decisionReason: version.decisionReason,
    openComments: names.openComments,
    reviewPath: libraryProposalPath(context.organization, project, item.slug, version.proposalNumber ?? 0, item.kind),
    can: {
      edit: isAuthor && open,
      submit: isAuthor && version.status === "draft",
      withdraw: isAuthor && open,
      publish: roles.canReview && !stale && (version.status === "proposed" || (version.status === "draft" && isAuthor)),
      reject: roles.canReview && version.status === "proposed",
    },
  };
}

export type LibraryProposalView = ReturnType<typeof serializeProposal>;

async function proposalNames(versions: readonly VersionRow[]): Promise<Map<string, ProposalNames>> {
  const result = new Map<string, ProposalNames>();
  if (versions.length === 0) return result;
  const userIds = [
    ...new Set(versions.flatMap((v) => [v.authorUserId, v.decidedByUserId]).filter((id): id is string => Boolean(id))),
  ];
  const users = userIds.length
    ? await db
        .select({ id: schema.users.id, name: schema.users.displayName })
        .from(schema.users)
        .where(inArray(schema.users.id, userIds))
    : [];
  const nameById = new Map(users.map((user) => [user.id, user.name]));
  const counts = await db
    .select({ versionId: schema.libraryComments.versionId, open: count() })
    .from(schema.libraryComments)
    .where(
      and(
        inArray(
          schema.libraryComments.versionId,
          versions.map((v) => v.id),
        ),
        isNull(schema.libraryComments.parentId),
        isNull(schema.libraryComments.resolvedAt),
      ),
    )
    .groupBy(schema.libraryComments.versionId);
  const openById = new Map(counts.map((row) => [row.versionId, Number(row.open)]));
  for (const version of versions) {
    result.set(version.id, {
      authorName: version.authorUserId ? (nameById.get(version.authorUserId) ?? null) : null,
      deciderName: version.decidedByUserId ? (nameById.get(version.decidedByUserId) ?? null) : null,
      openComments: openById.get(version.id) ?? 0,
    });
  }
  return result;
}

async function serializeOne(context: ItemContext, version: VersionRow, userId: string) {
  const names = await proposalNames([version]);
  return serializeProposal(context, version, names.get(version.id)!, userId);
}

async function filesOf(versionId: string, executor: Executor = db) {
  return executor
    .select({
      path: schema.libraryFiles.path,
      content: schema.libraryFiles.content,
      bytes: schema.libraryFiles.bytes,
      sha256: schema.libraryFiles.sha256,
    })
    .from(schema.libraryFiles)
    .where(eq(schema.libraryFiles.versionId, versionId))
    .orderBy(schema.libraryFiles.path);
}

async function itemView(item: ItemRow) {
  const [row] = await selectItems(db, { where: eq(schema.libraryItems.id, item.id), limit: 1 });
  if (!row) throw notFound();
  return serializeLibraryItem(row);
}

// ---------------------------------------------------------------------------
// Reads

/** Proposals the caller can see: org items' and those of the projects they read (only `projectRef`'s when given). */
export async function listLibraryProposals(input: {
  workspace: LibraryWorkspace;
  kind: LibraryKind;
  projectRef: string | null;
  state: "open" | "closed" | "all";
  mine: boolean;
}) {
  await assertLibraryFeature(input.workspace);
  const { workspace } = input;
  let projectIds: string[];
  if (input.projectRef) {
    const project = await findProject(workspace, input.projectRef, "read");
    if (!project) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
    projectIds = [project.id];
  } else {
    projectIds = (await listAccessibleProjectRecords(workspace)).map((project) => project.id);
  }
  const statuses =
    input.state === "open" ? [...OPEN_STATUSES] : input.state === "closed" ? [...CLOSED_STATUSES] : [...OPEN_STATUSES, ...CLOSED_STATUSES];
  const rows = await db
    .select({ version: schema.libraryVersions, item: schema.libraryItems, project: schema.projects })
    .from(schema.libraryVersions)
    .innerJoin(schema.libraryItems, eq(schema.libraryItems.id, schema.libraryVersions.itemId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.libraryItems.projectId))
    .where(
      and(
        eq(schema.libraryItems.organizationId, workspace.organization.id),
        eq(schema.libraryItems.kind, input.kind),
        sql`${schema.libraryVersions.proposalNumber} IS NOT NULL`,
        inArray(schema.libraryVersions.status, statuses),
        projectIds.length
          ? or(isNull(schema.libraryItems.projectId), inArray(schema.libraryItems.projectId, projectIds))
          : isNull(schema.libraryItems.projectId),
        input.mine ? eq(schema.libraryVersions.authorUserId, workspace.user.id) : undefined,
      ),
    )
    .orderBy(desc(sql`coalesce(${schema.libraryVersions.proposedAt}, ${schema.libraryVersions.updatedAt})`))
    .limit(PROPOSAL_LIST_LIMIT);
  const rolesByScope = new Map<string, ScopeRoles>();
  const visible: { context: ItemContext; version: VersionRow }[] = [];
  for (const row of rows) {
    const key = row.item.projectId ?? LIBRARY_ORG_SCOPE;
    let roles = rolesByScope.get(key);
    if (!roles) {
      roles = await scopeRoles(workspace, row.item.projectId);
      rolesByScope.set(key, roles);
    }
    if (!canSeeProposal(row.version, roles, workspace.user.id)) continue;
    const project = row.project ? summarizeProject(row.project) : null;
    visible.push({ context: { item: row.item, project, roles, organization: workspace.organization }, version: row.version });
  }
  const names = await proposalNames(visible.map((entry) => entry.version));
  return {
    proposals: visible.map(({ context, version }) => serializeProposal(context, version, names.get(version.id)!, workspace.user.id)),
    state: input.state,
    project: input.projectRef,
  };
}

export async function listItemProposals(input: { workspace: LibraryWorkspace; kind: LibraryKind; scopeRef: string; slug: string }) {
  await assertLibraryFeature(input.workspace);
  const context = await findItemForProposals(input);
  const versions = await db
    .select()
    .from(schema.libraryVersions)
    .where(and(eq(schema.libraryVersions.itemId, context.item.id), sql`${schema.libraryVersions.proposalNumber} IS NOT NULL`))
    .orderBy(desc(schema.libraryVersions.proposalNumber));
  const visible = versions.filter((version) => canSeeProposal(version, context.roles, input.workspace.user.id));
  const names = await proposalNames(visible);
  return {
    item: await itemView(context.item),
    can: { propose: context.roles.canPropose, review: context.roles.canReview },
    proposals: visible.map((version) => serializeProposal(context, version, names.get(version.id)!, input.workspace.user.id)),
  };
}

export async function showLibraryProposal(input: {
  workspace: LibraryWorkspace;
  kind: LibraryKind;
  scopeRef: string;
  slug: string;
  number: number;
}) {
  await assertLibraryFeature(input.workspace);
  const found = await findProposal(input);
  const { version, item } = found;
  const [files, base, comments, view] = await Promise.all([
    filesOf(version.id),
    loadBase(item.id, version.baseVersionNumber ?? 0),
    loadComments(found, version, input.workspace.user.id),
    itemView(item),
  ]);
  return {
    item: view,
    proposal: await serializeOne(found, version, input.workspace.user.id),
    files,
    base,
    comments,
  };
}

async function loadBase(itemId: string, number: number) {
  if (!number) return null;
  const [base] = await db
    .select({ id: schema.libraryVersions.id })
    .from(schema.libraryVersions)
    .where(and(eq(schema.libraryVersions.itemId, itemId), eq(schema.libraryVersions.versionNumber, number), PUBLISHED_STATUSES))
    .limit(1);
  if (!base) return null;
  return { number, files: await filesOf(base.id) };
}

async function loadComments(context: ItemContext, version: VersionRow, userId: string) {
  const author = alias(schema.users, "library_comment_author");
  const resolver = alias(schema.users, "library_comment_resolver");
  const rows = await db
    .select({ comment: schema.libraryComments, authorName: author.displayName, resolverName: resolver.displayName })
    .from(schema.libraryComments)
    .leftJoin(author, eq(author.id, schema.libraryComments.authorUserId))
    .leftJoin(resolver, eq(resolver.id, schema.libraryComments.resolvedByUserId))
    .where(eq(schema.libraryComments.versionId, version.id))
    .orderBy(asc(schema.libraryComments.createdAt));
  return rows.map(({ comment, authorName, resolverName }) => ({
    id: comment.id,
    parentId: comment.parentId,
    path: comment.path,
    line: comment.line,
    round: comment.round,
    outdated: comment.round < version.round,
    body: comment.body,
    author: { name: authorName ?? null, agentId: comment.authorAgentId, self: comment.authorUserId === userId },
    createdAt: comment.createdAt.toISOString(),
    resolvedAt: iso(comment.resolvedAt),
    resolvedBy: comment.resolvedByUserId ? { name: resolverName ?? null } : null,
    can: { resolve: comment.parentId === null && canResolve(context, version, comment.authorUserId, userId) },
  }));
}

function canResolve(context: ItemContext, version: VersionRow, commentAuthorId: string | null, userId: string) {
  return commentAuthorId === userId || version.authorUserId === userId || context.roles.canReview;
}

// ---------------------------------------------------------------------------
// Writes by the author

export async function createLibraryProposal(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  kind?: LibraryKind;
  body: unknown;
}) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(createBodySchema, input.body, "proposal");
  const kind: LibraryKind = input.kind ?? "skill";
  if (body.kind && body.kind !== kind) throw cliApiError(400, "PAYLOAD_INVALID", `This route proposes ${kindNoun(kind)}s.`);
  assertDescription(kind, body.description, "proposal");
  const { workspace } = input;
  if (!isLibrarySlug(body.slug)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "A slug is 1-64 characters of a-z, 0-9 and -, starting and ending with a letter or digit.");
  }
  assertSlugAllowed(kind, body.slug);
  const project = await resolveProposeScope(workspace, body.scope, body.project, kind);
  const prepared = prepareKindFiles(kind, body.files);
  assertAgentSkillsInScope(prepared.manifest, project?.slug ?? null);
  const { name, description } = kindText({
    kind,
    name: body.name,
    description: body.description,
    meta: prepared.meta,
    fallbackName: body.slug,
    what: "proposal",
  });
  const externalAllowed = body.externalAllowed ?? false;
  const organizationId = workspace.organization.id;
  const submit = body.submit === true;
  const now = new Date();

  const created = await db.transaction(async (tx) => {
    await tx.execute(lockKey(organizationId, kind, body.slug));
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
    await assertSlugFree(tx, workspace, { kind, slug: body.slug, project, sameSlug, verb: "propose" });
    let item = sameSlug.find((row) => (project ? row.projectId === project.id : row.projectId === null)) ?? null;
    const currentVersion = item?.currentVersionNumber ?? 0;
    if (body.baseVersion !== undefined && !baseMatches(item, body.baseVersion)) {
      throw staleBase(currentVersion, body.baseVersion);
    }
    if (item) await assertChanges(tx, item, { contentHash: prepared.contentHash, name, description, externalAllowed });
    if (!item) {
      const [inserted] = await tx
        .insert(schema.libraryItems)
        .values({
          organizationId,
          projectId: project?.id ?? null,
          kind,
          slug: body.slug,
          name,
          description,
          externalAllowed,
          createdByUserId: workspace.user.id,
        })
        .returning();
      if (!inserted) throw new Error("library_items insert returned no row");
      item = inserted;
    }
    const [maxRow] = await tx
      .select({ maxNumber: sql<number>`coalesce(max(${schema.libraryVersions.proposalNumber}), 0)::int` })
      .from(schema.libraryVersions)
      .where(eq(schema.libraryVersions.itemId, item.id));
    const proposalNumber = Number(maxRow?.maxNumber ?? 0) + 1;
    const [version] = await tx
      .insert(schema.libraryVersions)
      .values({
        itemId: item.id,
        organizationId,
        versionNumber: null,
        proposalNumber,
        baseVersionNumber: currentVersion,
        round: 1,
        status: submit ? "proposed" : "draft",
        name,
        description,
        externalAllowed,
        contentHash: prepared.contentHash,
        fileCount: prepared.files.length,
        totalBytes: prepared.totalBytes,
        note: body.note || null,
        authorType: body.agent ? "agent" : "user",
        authorUserId: workspace.user.id,
        authorAgentId: body.agent?.id ?? null,
        localInstallationId: input.actor.localInstallationId,
        proposedAt: submit ? now : null,
      })
      .returning();
    if (!version) throw new Error("library_versions insert returned no row");
    await tx.insert(schema.libraryFiles).values(prepared.files.map((file) => ({ versionId: version.id, ...file })));
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: submit ? `library.${item.kind}.proposed` : `library.${item.kind}.proposal_created`,
        before: null,
        after: proposalAudit(version),
      }),
    );
    if (submit) await notifyProposal(tx, { item, project, version, event: "proposed", actor: input.actor, userId: workspace.user.id, organization: workspace.organization });
    return { item, version };
  });

  const roles = await scopeRoles(workspace, created.item.projectId);
  return {
    status: 201,
    payload: {
      proposal: await serializeOne({ item: created.item, project, roles, organization: workspace.organization }, created.version, workspace.user.id),
      ...(isCompiledKind(kind) ? { diagnostics: prepared.diagnostics } : {}),
    },
  };
}

export async function updateLibraryProposal(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  kind: LibraryKind;
  scopeRef: string;
  slug: string;
  number: number;
  body: unknown;
}) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(updateBodySchema, input.body, "proposal update");
  assertDescription(input.kind, body.description, "proposal update");
  const found = await findProposal(input);
  assertAuthor(found.version, input.workspace.user.id);
  const prepared = prepareKindFiles(found.item.kind, body.files);
  assertAgentSkillsInScope(prepared.manifest, found.project?.slug ?? null);
  const { name, description } = kindText({
    kind: found.item.kind,
    name: body.name,
    description: body.description,
    meta: prepared.meta,
    fallbackName: found.version.name ?? found.item.name,
    what: "proposal update",
  });
  const externalAllowed = body.externalAllowed ?? found.version.externalAllowed ?? false;
  const now = new Date();

  const updated = await db.transaction(async (tx) => {
    await tx.execute(lockKey(found.item.organizationId, input.kind, found.item.slug));
    const { item, version } = await reload(tx, found.item.id, found.version.id);
    assertOpen(version);
    const currentVersion = item.currentVersionNumber ?? 0;
    if (body.baseVersion !== undefined && !baseMatches(item, body.baseVersion)) throw staleBase(currentVersion, body.baseVersion);
    await assertChanges(tx, item, { contentHash: prepared.contentHash, name, description, externalAllowed });
    const submitting = body.submit === true && version.status === "draft";
    const status: ProposalStatus = submitting ? "proposed" : version.status;
    const [next] = await tx
      .update(schema.libraryVersions)
      .set({
        name,
        description,
        externalAllowed,
        note: body.note === undefined ? version.note : body.note || null,
        baseVersionNumber: body.baseVersion === undefined ? version.baseVersionNumber : currentVersion,
        contentHash: prepared.contentHash,
        fileCount: prepared.files.length,
        totalBytes: prepared.totalBytes,
        round: version.status === "proposed" ? version.round + 1 : version.round,
        status,
        proposedAt: submitting ? now : version.proposedAt,
        updatedAt: now,
      })
      .where(eq(schema.libraryVersions.id, version.id))
      .returning();
    if (!next) throw notFound("Proposal not found.");
    await tx.delete(schema.libraryFiles).where(eq(schema.libraryFiles.versionId, version.id));
    await tx.insert(schema.libraryFiles).values(prepared.files.map((file) => ({ versionId: version.id, ...file })));
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId: item.organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: submitting ? `library.${item.kind}.proposed` : `library.${item.kind}.proposal_updated`,
        before: proposalAudit(version),
        after: proposalAudit(next),
      }),
    );
    if (submitting) {
      await notifyProposal(tx, { item, project: found.project, version: next, event: "proposed", actor: input.actor, userId: input.workspace.user.id, organization: input.workspace.organization });
    }
    return { item, version: next };
  });
  return {
    status: 200,
    payload: {
      proposal: await serializeOne({ ...found, item: updated.item }, updated.version, input.workspace.user.id),
      ...(isCompiledKind(found.item.kind) ? { diagnostics: prepared.diagnostics } : {}),
    },
  };
}

export async function submitLibraryProposal(input: ProposalActionInput) {
  await assertLibraryFeature(input.workspace);
  parseBody(authorAgentBodySchema, input.body, "submit");
  const found = await findProposal(input);
  assertAuthor(found.version, input.workspace.user.id);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    await tx.execute(lockKey(found.item.organizationId, input.kind, found.item.slug));
    const { item, version } = await reload(tx, found.item.id, found.version.id);
    if (version.status === "proposed") return { item, version };
    if (version.status !== "draft") throw notOpen(version);
    const [next] = await tx
      .update(schema.libraryVersions)
      .set({ status: "proposed", proposedAt: now, updatedAt: now })
      .where(eq(schema.libraryVersions.id, version.id))
      .returning();
    if (!next) throw notFound("Proposal not found.");
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId: item.organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: `library.${item.kind}.proposed`,
        before: proposalAudit(version),
        after: proposalAudit(next),
      }),
    );
    await notifyProposal(tx, { item, project: found.project, version: next, event: "proposed", actor: input.actor, userId: input.workspace.user.id, organization: input.workspace.organization });
    return { item, version: next };
  });
  return { status: 200, payload: { proposal: await serializeOne({ ...found, item: result.item }, result.version, input.workspace.user.id) } };
}

/** Deletes a draft (and an item left with no versions) or marks a proposal withdrawn. */
export async function withdrawLibraryProposal(input: ProposalActionInput) {
  await assertLibraryFeature(input.workspace);
  parseBody(authorAgentBodySchema, input.body, "withdraw");
  const found = await findProposal(input);
  assertAuthor(found.version, input.workspace.user.id);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    await tx.execute(lockKey(found.item.organizationId, input.kind, found.item.slug));
    const { item, version } = await reload(tx, found.item.id, found.version.id);
    assertOpen(version);
    if (version.status === "draft") {
      await tx.delete(schema.libraryVersions).where(eq(schema.libraryVersions.id, version.id));
      const [left] = await tx
        .select({ total: count() })
        .from(schema.libraryVersions)
        .where(eq(schema.libraryVersions.itemId, item.id));
      const itemDeleted = Number(left?.total ?? 0) === 0 && item.currentVersionId === null;
      if (itemDeleted) await tx.delete(schema.libraryItems).where(eq(schema.libraryItems.id, item.id));
      await tx.insert(schema.auditEvents).values(
        auditEvent(input, {
          organizationId: item.organizationId,
          projectId: item.projectId,
          itemId: item.id,
          action: `library.${item.kind}.proposal_withdrawn`,
          before: proposalAudit(version),
          after: { status: "deleted", itemDeleted },
        }),
      );
      return { deleted: true as const, itemDeleted, item, version };
    }
    const [next] = await tx
      .update(schema.libraryVersions)
      .set({ status: "withdrawn", decidedAt: now, decidedByUserId: input.workspace.user.id, updatedAt: now })
      .where(eq(schema.libraryVersions.id, version.id))
      .returning();
    if (!next) throw notFound("Proposal not found.");
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId: item.organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: `library.${item.kind}.proposal_withdrawn`,
        before: proposalAudit(version),
        after: proposalAudit(next),
      }),
    );
    return { deleted: false as const, itemDeleted: false, item, version: next };
  });
  if (result.deleted) {
    return { status: 200, payload: { deleted: true, itemDeleted: result.itemDeleted, number: input.number, proposal: null } };
  }
  return {
    status: 200,
    payload: {
      deleted: false,
      itemDeleted: false,
      number: input.number,
      proposal: await serializeOne({ ...found, item: result.item }, result.version, input.workspace.user.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Decisions by a reviewer

type ProposalActionInput = {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  kind: LibraryKind;
  scopeRef: string;
  slug: string;
  number: number;
  body: unknown;
};

export async function publishLibraryProposal(input: ProposalActionInput) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(decisionBodySchema, input.body, "publish");
  assertNotAgent(body.agent, "publish");
  const found = await findProposal(input);
  assertReviewer(found.roles, found.item.kind);
  const userId = input.workspace.user.id;
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(lockKey(found.item.organizationId, input.kind, found.item.slug));
    const { item, version } = await reload(tx, found.item.id, found.version.id);
    if (version.status === "draft" && version.authorUserId !== userId) {
      throw cliApiError(409, "CONFLICT", "This proposal is still a draft. Its author proposes it before a reviewer publishes it.", {
        reason: "not_proposed",
        conflict: "not_proposed",
      });
    }
    assertOpen(version);
    const currentVersion = item.currentVersionNumber ?? 0;
    if ((version.baseVersionNumber ?? 0) !== currentVersion) {
      throw conflict(
        "stale_base",
        `Version ${currentVersion} was published after this proposal was written against version ${version.baseVersionNumber ?? 0}. Its author updates it first.`,
        { currentVersion, baseVersion: version.baseVersionNumber ?? 0 },
      );
    }
    // Themes and widgets compile again with the current engine before they reach a page.
    const files = await filesOf(version.id, tx);
    assertScriptPublisher(input.workspace.membership.role, item.kind, files);
    const { diagnostics } = compileKindFiles(item.kind, files);
    const versionNumber = await nextVersionNumber(tx, item.id);
    await supersedeCurrent(tx, item.id, now);
    const [next] = await tx
      .update(schema.libraryVersions)
      .set({
        status: "published",
        versionNumber,
        publishedAt: now,
        publishedByUserId: userId,
        decidedAt: now,
        decidedByUserId: userId,
        updatedAt: now,
      })
      .where(eq(schema.libraryVersions.id, version.id))
      .returning();
    if (!next) throw notFound("Proposal not found.");
    const name = version.name ?? item.name;
    const description = version.description ?? item.description;
    const externalAllowed = version.externalAllowed ?? item.externalAllowed;
    const [nextItem] = await tx
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
        ...searchColumns(librarySearchParts({ slug: item.slug, name, description, body: kindSearchBody(item.kind, files) })),
        updatedAt: now,
      })
      .where(eq(schema.libraryItems.id, item.id))
      .returning();
    if (!nextItem) throw notFound();
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId: item.organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: `library.${item.kind}.published`,
        before: { version: currentVersion, archived: Boolean(item.archivedAt) },
        after: { version: versionNumber, proposalNumber: version.proposalNumber, contentHash: version.contentHash, fileCount: version.fileCount },
      }),
    );
    const ownDraft = version.status === "draft";
    if (!ownDraft) await notifyProposal(tx, { item: nextItem, project: found.project, version: next, event: "published", actor: input.actor, userId, organization: input.workspace.organization });
    return { item: nextItem, version: next, diagnostics };
  });
  return {
    status: 200,
    payload: {
      proposal: await serializeOne({ ...found, item: result.item }, result.version, userId),
      item: await itemView(result.item),
      ...(isCompiledKind(result.item.kind) ? { diagnostics: result.diagnostics } : {}),
    },
  };
}

export async function rejectLibraryProposal(input: ProposalActionInput) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(rejectBodySchema, input.body, "reject");
  assertNotAgent(body.agent, "reject");
  const found = await findProposal(input);
  assertReviewer(found.roles, found.item.kind);
  const userId = input.workspace.user.id;
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    await tx.execute(lockKey(found.item.organizationId, input.kind, found.item.slug));
    const { item, version } = await reload(tx, found.item.id, found.version.id);
    if (version.status !== "proposed") throw notOpen(version, "Only a proposed version can be rejected.");
    const [next] = await tx
      .update(schema.libraryVersions)
      .set({ status: "rejected", decidedAt: now, decidedByUserId: userId, decisionReason: body.reason, updatedAt: now })
      .where(eq(schema.libraryVersions.id, version.id))
      .returning();
    if (!next) throw notFound("Proposal not found.");
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId: item.organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: `library.${item.kind}.proposal_rejected`,
        before: proposalAudit(version),
        after: { ...proposalAudit(next), reason: body.reason },
      }),
    );
    await notifyProposal(tx, { item, project: found.project, version: next, event: "rejected", actor: input.actor, userId, organization: input.workspace.organization });
    return { item, version: next };
  });
  return { status: 200, payload: { proposal: await serializeOne({ ...found, item: result.item }, result.version, userId) } };
}

/** Publishes an older version's files again as a new version, with the item's current metadata. */
export async function revertLibraryItem(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  kind: LibraryKind;
  scopeRef: string;
  slug: string;
  version: number;
  body: unknown;
}) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(decisionBodySchema, input.body, "revert");
  assertNotAgent(body.agent, "revert");
  const context = await findItemForProposals(input);
  assertReviewer(context.roles, context.item.kind);
  const userId = input.workspace.user.id;
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(lockKey(context.item.organizationId, input.kind, context.item.slug));
    const [item] = await tx.select().from(schema.libraryItems).where(eq(schema.libraryItems.id, context.item.id)).limit(1);
    if (!item) throw notFound();
    const [source] = await tx
      .select()
      .from(schema.libraryVersions)
      .where(
        and(eq(schema.libraryVersions.itemId, item.id), eq(schema.libraryVersions.versionNumber, input.version), PUBLISHED_STATUSES),
      )
      .limit(1);
    if (!source) throw notFound("That version does not exist.");
    if (input.version === item.currentVersionNumber) {
      throw conflict("unchanged", `Version ${input.version} is already the current version.`);
    }
    const files = await tx
      .select({ path: schema.libraryFiles.path, content: schema.libraryFiles.content, bytes: schema.libraryFiles.bytes, sha256: schema.libraryFiles.sha256 })
      .from(schema.libraryFiles)
      .where(eq(schema.libraryFiles.versionId, source.id));
    assertScriptPublisher(input.workspace.membership.role, item.kind, files);
    // An old theme or widget version must still compile with the current engine.
    const { diagnostics } = compileKindFiles(item.kind, files);
    const versionNumber = await nextVersionNumber(tx, item.id);
    await supersedeCurrent(tx, item.id, now);
    const [version] = await tx
      .insert(schema.libraryVersions)
      .values({
        itemId: item.id,
        organizationId: item.organizationId,
        versionNumber,
        status: "published",
        name: item.name,
        description: item.description,
        externalAllowed: item.externalAllowed,
        contentHash: source.contentHash,
        fileCount: source.fileCount,
        totalBytes: source.totalBytes,
        note: `Reverted to version ${input.version}.`,
        authorType: "user",
        authorUserId: userId,
        localInstallationId: input.actor.localInstallationId,
        publishedAt: now,
        publishedByUserId: userId,
      })
      .returning();
    if (!version) throw new Error("library_versions insert returned no row");
    await tx.insert(schema.libraryFiles).values(files.map((file) => ({ versionId: version.id, ...file })));
    const [nextItem] = await tx
      .update(schema.libraryItems)
      .set({
        currentVersionId: version.id,
        currentVersionNumber: versionNumber,
        publishedAt: now,
        archivedAt: null,
        archivedByUserId: null,
        ...searchColumns(
          librarySearchParts({ slug: item.slug, name: item.name, description: item.description, body: kindSearchBody(item.kind, files) }),
        ),
        updatedAt: now,
      })
      .where(eq(schema.libraryItems.id, item.id))
      .returning();
    if (!nextItem) throw notFound();
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId: item.organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: `library.${item.kind}.reverted`,
        before: { version: item.currentVersionNumber },
        after: { version: versionNumber, revertedTo: input.version, contentHash: source.contentHash },
      }),
    );
    return { item: nextItem, versionNumber, contentHash: source.contentHash, diagnostics };
  });
  return {
    status: 201,
    payload: {
      item: await itemView(result.item),
      version: { number: result.versionNumber, contentHash: result.contentHash },
      revertedTo: input.version,
      ...(isCompiledKind(result.item.kind) ? { diagnostics: result.diagnostics } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Comments

export async function commentOnLibraryProposal(input: ProposalActionInput) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(commentBodySchema, input.body, "comment");
  const found = await findProposal(input);
  const { version, item } = found;
  if (body.line !== undefined && body.path === undefined) {
    throw cliApiError(400, "PAYLOAD_INVALID", "A comment on a line also names its file (path).");
  }
  let parentId: string | null = null;
  if (body.parentId) {
    const [parent] = await db
      .select({ id: schema.libraryComments.id, parentId: schema.libraryComments.parentId })
      .from(schema.libraryComments)
      .where(and(eq(schema.libraryComments.id, body.parentId), eq(schema.libraryComments.versionId, version.id)))
      .limit(1);
    if (!parent) throw notFound("Comment not found.");
    parentId = parent.parentId ?? parent.id;
  }
  if (body.path !== undefined && !parentId) {
    const known = await db
      .select({ path: schema.libraryFiles.path })
      .from(schema.libraryFiles)
      .where(eq(schema.libraryFiles.versionId, version.id));
    const base = await loadBase(item.id, version.baseVersionNumber ?? 0);
    const paths = new Set([...known.map((file) => file.path), ...(base?.files.map((file) => file.path) ?? [])]);
    if (!paths.has(body.path)) throw cliApiError(400, "PAYLOAD_INVALID", `This proposal has no file ${body.path}.`);
  }
  const [comment] = await db
    .insert(schema.libraryComments)
    .values({
      organizationId: item.organizationId,
      itemId: item.id,
      versionId: version.id,
      parentId,
      path: parentId ? null : (body.path ?? null),
      line: parentId ? null : (body.line ?? null),
      round: version.round,
      body: body.body,
      authorUserId: input.workspace.user.id,
      authorAgentId: body.agent?.id ?? null,
    })
    .returning({ id: schema.libraryComments.id });
  if (!comment) throw new Error("library_comments insert returned no row");
  const comments = await loadComments(found, version, input.workspace.user.id);
  return { status: 201, payload: { comment: comments.find((entry) => entry.id === comment.id) ?? null, comments } };
}

export async function setLibraryCommentResolved(input: ProposalActionInput & { commentId: string; resolved: boolean }) {
  await assertLibraryFeature(input.workspace);
  parseBody(authorAgentBodySchema, input.body, input.resolved ? "resolve" : "reopen");
  const found = await findProposal(input);
  if (!z.string().uuid().safeParse(input.commentId).success) throw notFound("Comment not found.");
  const [comment] = await db
    .select()
    .from(schema.libraryComments)
    .where(and(eq(schema.libraryComments.id, input.commentId), eq(schema.libraryComments.versionId, found.version.id)))
    .limit(1);
  if (!comment || comment.parentId !== null) throw notFound("Comment not found.");
  if (!canResolve(found, found.version, comment.authorUserId, input.workspace.user.id)) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "The comment's author, the proposal's author or a reviewer resolves it.");
  }
  const now = new Date();
  await db
    .update(schema.libraryComments)
    .set(input.resolved ? { resolvedAt: now, resolvedByUserId: input.workspace.user.id, updatedAt: now } : { resolvedAt: null, resolvedByUserId: null, updatedAt: now })
    .where(eq(schema.libraryComments.id, comment.id));
  const comments = await loadComments(found, found.version, input.workspace.user.id);
  return { status: 200, payload: { comment: comments.find((entry) => entry.id === comment.id) ?? null, comments } };
}

// ---------------------------------------------------------------------------
// Helpers

async function resolveProposeScope(workspace: LibraryWorkspace, scope: "org" | "project", projectRef: string | undefined, kind: LibraryKind) {
  if (scope === "org") {
    if (projectRef) throw cliApiError(400, "PAYLOAD_INVALID", "An org item takes no project.");
    if (!PROPOSING_ORG_ROLES.has(workspace.membership.role)) {
      throw cliApiError(403, "ORG_ACCESS_DENIED", `Organization owners, admins and developers propose org ${kindNoun(kind)}s.`);
    }
    return null;
  }
  if (!projectRef) throw cliApiError(400, "PAYLOAD_INVALID", "A project item needs project.");
  const project = await findProject(workspace, projectRef, "write");
  if (!project) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", `Only the project's developers and admins propose its ${kindNoun(kind)}s.`);
  }
  return summarizeProject(project);
}

function assertAuthor(version: VersionRow, userId: string) {
  if (version.authorUserId !== userId) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Only the proposal's author changes it. Comment on it instead.");
  }
}

function assertReviewer(roles: ScopeRoles, kind: LibraryKind) {
  if (!roles.canReview) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", `Only the scope's admins publish, reject or revert its ${kindNoun(kind)}s.`);
  }
}

function assertOpen(version: VersionRow) {
  if (version.status !== "draft" && version.status !== "proposed") throw notOpen(version);
}

function notOpen(version: VersionRow, message = "This proposal is closed.") {
  return cliApiError(409, "CONFLICT", message, { reason: "proposal_closed", conflict: "proposal_closed", status: version.status });
}

function staleBase(currentVersion: number, baseVersion: number) {
  return conflict("stale_base", `The published version is ${currentVersion}, not ${baseVersion}. Start from version ${currentVersion}.`, {
    currentVersion,
    baseVersion,
  });
}

async function reload(tx: Executor, itemId: string, versionId: string) {
  const [item] = await tx.select().from(schema.libraryItems).where(eq(schema.libraryItems.id, itemId)).limit(1);
  const [version] = await tx.select().from(schema.libraryVersions).where(eq(schema.libraryVersions.id, versionId)).limit(1);
  if (!item || !version) throw notFound("Proposal not found.");
  return { item, version };
}

/** Refuses a proposal that would publish exactly what is already current. */
async function assertChanges(
  tx: Executor,
  item: ItemRow,
  next: { contentHash: string; name: string; description: string; externalAllowed: boolean },
) {
  // Publishing a proposal restores an archived item, so even its own files are a change.
  if (!item.currentVersionId || item.archivedAt) return;
  const [current] = await tx
    .select({ contentHash: schema.libraryVersions.contentHash })
    .from(schema.libraryVersions)
    .where(eq(schema.libraryVersions.id, item.currentVersionId))
    .limit(1);
  if (
    current?.contentHash === next.contentHash &&
    item.name === next.name &&
    item.description === next.description &&
    item.externalAllowed === next.externalAllowed
  ) {
    throw conflict("unchanged", `This is exactly version ${item.currentVersionNumber}. Change a file or the description first.`);
  }
}

async function nextVersionNumber(tx: Executor, itemId: string) {
  const [maxRow] = await tx
    .select({ maxNumber: sql<number>`coalesce(max(${schema.libraryVersions.versionNumber}), 0)::int` })
    .from(schema.libraryVersions)
    .where(eq(schema.libraryVersions.itemId, itemId));
  return Number(maxRow?.maxNumber ?? 0) + 1;
}

async function supersedeCurrent(tx: Executor, itemId: string, now: Date) {
  await tx
    .update(schema.libraryVersions)
    .set({ status: "superseded", updatedAt: now })
    .where(and(eq(schema.libraryVersions.itemId, itemId), eq(schema.libraryVersions.status, "published")));
}

function proposalAudit(version: VersionRow): Record<string, unknown> {
  return {
    proposalNumber: version.proposalNumber,
    status: version.status,
    round: version.round,
    baseVersion: version.baseVersionNumber,
    contentHash: version.contentHash,
    fileCount: version.fileCount,
    ...(version.authorAgentId ? { agentId: version.authorAgentId } : {}),
  };
}

type NotifyEvent = "proposed" | "published" | "rejected";

const NOTIFY_NOUNS: Record<LibraryKind, string> = { skill: "A skill", agent: "An agent", theme: "A theme", widget: "A widget" };

function notifyConfig(kind: LibraryKind, event: NotifyEvent): { eventType: string; severity: "action_required" | "info"; title: string } {
  const noun = NOTIFY_NOUNS[kind];
  switch (event) {
    case "proposed":
      return { eventType: `library.${kind}.proposed`, severity: "action_required", title: `${noun} change is waiting for review` };
    case "published":
      return { eventType: `library.${kind}.proposal_published`, severity: "info", title: `${noun} proposal was published` };
    case "rejected":
      return { eventType: `library.${kind}.proposal_rejected`, severity: "info", title: `${noun} proposal was rejected` };
  }
}

async function notifyProposal(
  tx: Executor,
  input: {
    item: ItemRow;
    project: ProjectSummary | null;
    version: VersionRow;
    event: NotifyEvent;
    actor: LibraryActor;
    userId: string;
    organization: LinkOrganization;
  },
) {
  const { item, project, version, event } = input;
  const ref = `${project ? project.slug : LIBRARY_ORG_SCOPE}/${item.slug}`;
  const config = notifyConfig(item.kind, event);
  const [author] = version.authorUserId
    ? await tx.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, version.authorUserId)).limit(1)
    : [];
  const authorName = author?.name ?? null;
  const reviewUrl = libraryProposalUrl(input.actor.origin, input.organization, project, item.slug, version.proposalNumber ?? 0, item.kind);
  const who = version.authorAgentId ? `Agent ${version.authorAgentId} for ${authorName ?? "a member"}` : (authorName ?? "A member");
  const summary =
    event === "proposed"
      ? `${who} proposed a change to ${ref} (proposal ${version.proposalNumber}).${version.note ? ` Note: ${version.note}` : ""} Review it: ${reviewUrl}`
      : event === "published"
        ? `Proposal ${version.proposalNumber} to ${ref} was published as version ${version.versionNumber}.`
        : `Proposal ${version.proposalNumber} to ${ref} was rejected: ${version.decisionReason ?? ""}`;
  await recordAgentInboxItem(
    {
      actorId: input.userId,
      actorType: "user",
      category: "library",
      dedupeKey: `library:proposal:${version.id}:${event}`,
      eventType: config.eventType,
      linksJson: { reviewUrl },
      occurredAt: new Date(),
      organizationId: item.organizationId,
      payloadJson: {
        ref,
        proposalNumber: version.proposalNumber,
        baseVersion: version.baseVersionNumber ?? 0,
        version: version.versionNumber,
        author: { name: authorName, agentId: version.authorAgentId },
        note: version.note,
        reason: event === "rejected" ? version.decisionReason : null,
        requestId: input.actor.requestId,
      },
      projectId: item.projectId,
      sensitivity: "metadata",
      severity: config.severity,
      sourceId: version.id,
      sourceType: "library_proposal",
      summary,
      targetId: item.id,
      targetType: "library_item",
      title: config.title,
    },
    tx,
  );
}

/** The item's Console page (its current version); kinds other than skills carry `?kind=`. */
export function libraryItemPath(project: Pick<ProjectSummary, "id" | "slug"> | null, slug: string, kind: LibraryKind = "skill") {
  const base = project ? `/p/${project.id}/library/${encodeURIComponent(project.slug)}` : `/org/library/${LIBRARY_ORG_SCOPE}`;
  return `${base}/${encodeURIComponent(slug)}${kind === "skill" ? "" : `?kind=${kind}`}`;
}

/** The proposal's Console page; kinds other than skills carry `?kind=` like every Library screen link. */
export function libraryProposalPath(
  organization: LinkOrganization,
  project: ProjectSummary | null,
  slug: string,
  number: number,
  kind: LibraryKind = "skill",
) {
  const base = project ? `/p/${project.id}/library/${encodeURIComponent(project.slug)}` : `/org/library/${LIBRARY_ORG_SCOPE}`;
  return orgPath(orgSegment(organization), `${base}/${encodeURIComponent(slug)}/proposals/${number}${kind === "skill" ? "" : `?kind=${kind}`}`);
}

export function libraryProposalUrl(
  origin: string,
  organization: LinkOrganization,
  project: ProjectSummary | null,
  slug: string,
  number: number,
  kind: LibraryKind = "skill",
) {
  return `${origin}${libraryProposalPath(organization, project, slug, number, kind)}`;
}

