import { and, asc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import postgres from "postgres";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  createPageObjectStorageFromEnv,
  createPageUploadSession,
  finalizePageUploadSession,
  type PageObjectStorage,
  type PagePublishContext,
} from "@/server/console/pages/publish";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";
import { db, resolveDatabaseUrl, schema } from "@/server/db";

import { recordKnowledgeGapAnswered } from "./inbox";
import { readRouteMark, writeRouteMark, type KnowledgeMarkAudience } from "./marks";
import { capturePageRoute } from "./producers/page";
import { foldKnowledgeText } from "./text";

// The Console's own /faq page: every approved gap of a project, rendered from
// the database under a per-project session lock, published as a public route
// of the project's default site, captured right away (tier `approved` because
// the hash matches what we rendered) and marked `managedBy: "faq"` for the
// contacts that asked.

export const FAQ_PATH = "/faq";
/** Artifact slug the Console publishes /faq under; recognizes an unmarked /faq as ours. */
export const FAQ_ARTIFACT_SLUG = "knowledge-faq";
const FAQ_ANSWER_MAX_CHARS = 2000;
const FAQ_QUESTION_MAX_CHARS = 300;
const FAQ_ANCHOR_MAX_CHARS = 48;
const FAQ_LOCK_RETRY_MS = 500;
const FAQ_LOCK_TIMEOUT_MS = 30_000;

export type FaqEntry = { anchor: string; question: string; answer: string; updatedAt: string };

type CaptureFaqRoute = (
  input: { siteId: string; releaseId: string; routeId: string; requestId: string },
  options: { faqHtmlSha256: string; storage?: PageObjectStorage },
) => Promise<{ status: string; sourceId?: string; documentId?: string }>;

export type PublishFaqDeps = {
  storage?: PageObjectStorage;
  fetch?: typeof fetch;
  /** Runs `fn` while holding the project's /faq session lock. */
  withLock?: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  writeRoute?: typeof writeConsoleRenderedRoute;
  capture?: CaptureFaqRoute;
  writeMark?: typeof writeRouteMark;
  recordGapAnswered?: typeof recordKnowledgeGapAnswered;
  now?: () => Date;
};

export async function publishFaqAnswer(
  input: {
    proposalId: string;
    answer: string;
    faqQuestion: string;
    actorUserId: string;
    requestId: string;
    /** Console origin for the card link in the inbox item; defaults to the configured Console URL. */
    origin?: string;
  },
  deps: PublishFaqDeps = {},
): Promise<{ url: string; anchor: string; documentId: string }> {
  const answer = input.answer.replace(/\r\n?/g, "\n").trim();
  const question = input.faqQuestion.replace(/\s+/g, " ").trim();
  if (!answer || answer.length > FAQ_ANSWER_MAX_CHARS) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { answer: `Write an answer of at most ${FAQ_ANSWER_MAX_CHARS} characters.` } });
  }
  if (!question || question.length > FAQ_QUESTION_MAX_CHARS) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { faqQuestion: `Write the question in at most ${FAQ_QUESTION_MAX_CHARS} characters.` },
    });
  }

  const now = deps.now ?? (() => new Date());
  const proposal = await loadPendingGap(input.proposalId, now());
  const [project] = await db
    .select({ id: schema.projects.id, organizationId: schema.projects.organizationId, name: schema.projects.name })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, proposal.projectId), eq(schema.projects.organizationId, proposal.organizationId)))
    .limit(1);
  if (!project) throw new ConsoleApiError(404, { error: "knowledge_proposal_not_found" });

  const site = await findFaqSite(project.id, project.organizationId);
  if (!site) throw new ConsoleApiError(409, { error: "faq_site_unavailable" });
  // A public route still takes a private site default, so clients could not open the link.
  if (site.defaultVisibility !== "public") throw new ConsoleApiError(409, { error: "faq_site_not_public" });

  const withLock = deps.withLock ?? withFaqLock;
  const writeRoute = deps.writeRoute ?? writeConsoleRenderedRoute;
  const capture: CaptureFaqRoute =
    deps.capture ??
    ((target, options) =>
      capturePageRoute({ ...target, trigger: "faq" }, { faqHtmlSha256: options.faqHtmlSha256, ...(options.storage ? { storage: options.storage } : {}) }));
  const writeMark = deps.writeMark ?? writeRouteMark;
  const storage = deps.storage;

  const outcome = await withLock(project.id, async () => {
    // Another click may have published this gap while we waited for the lock.
    const current = await loadPendingGap(input.proposalId, now());
    if (await faqRouteTaken(site.id)) throw new ConsoleApiError(409, { error: "faq_route_taken" });

    const approved = await listApprovedFaqGaps(project.id);
    const anchor = faqAnchor(question, new Set(approved.map((entry) => entry.anchor)));
    const decidedAt = now();
    const entries: FaqEntry[] = [
      ...approved.map(({ anchor: entryAnchor, question: entryQuestion, answer: entryAnswer, updatedAt }) => ({
        anchor: entryAnchor,
        question: entryQuestion,
        answer: entryAnswer,
        updatedAt,
      })),
      { anchor, question, answer, updatedAt: decidedAt.toISOString() },
    ];
    const html = renderFaqHtml(entries, { projectName: project.name });
    const htmlSha256 = sha256Hex(html);

    const written = await writeRoute(
      { projectId: project.id, path: FAQ_PATH, html, reason: "knowledge.faq", actorUserId: input.actorUserId, requestId: input.requestId },
      { ...(storage ? { storage } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) },
    );
    const captured = await capture(
      { siteId: written.siteId, releaseId: written.releaseId, routeId: written.routeId, requestId: input.requestId },
      { faqHtmlSha256: htmlSha256, ...(storage ? { storage } : {}) },
    );
    if ((captured.status !== "ingested" && captured.status !== "unchanged") || !captured.documentId) {
      throw new ConsoleApiError(409, { error: "knowledge_route_not_captured" });
    }

    const audiences = unionContactsAudiences([...approved.map((entry) => entry.audience), contactsAudience(current.requestedAudienceJson, current.localInstallationId)]);
    await writeMark({
      routeId: written.routeId,
      action: "mark",
      audiences,
      actorUserId: input.actorUserId,
      managedBy: "faq",
      faqHtmlSha256: htmlSha256,
      // Pin exactly what was just rendered and captured, never a version written meanwhile.
      expectedDocumentId: captured.documentId,
      requestId: input.requestId,
    });

    const url = `https://${written.host}${FAQ_PATH}`;
    const updated = await db
      .update(schema.knowledgeProposals)
      .set({
        status: "approved",
        answerText: answer,
        faqQuestion: question,
        resultJson: { anchor, url, releaseId: written.releaseId, routeId: written.routeId, documentId: captured.documentId },
        resultSourceId: captured.sourceId ?? null,
        decidedByUserId: input.actorUserId,
        decidedAt,
        updatedAt: decidedAt,
      })
      .where(and(eq(schema.knowledgeProposals.id, current.id), eq(schema.knowledgeProposals.status, "pending")))
      .returning({ id: schema.knowledgeProposals.id });
    if (updated.length === 0) throw new ConsoleApiError(409, { error: "knowledge_proposal_closed" });

    await db.insert(schema.auditEvents).values({
      organizationId: project.organizationId,
      projectId: project.id,
      actorType: "user",
      actorId: input.actorUserId,
      targetType: "knowledge_proposal",
      targetId: current.id,
      action: "knowledge_proposal.approved",
      requestId: input.requestId,
      metadataJson: {
        proposalId: current.id,
        kind: "gap",
        decision: "publish",
        siteId: written.siteId,
        releaseId: written.releaseId,
        routeId: written.routeId,
        documentId: captured.documentId,
        audienceCount: audiences.length,
      },
    });
    return { url, anchor, documentId: captured.documentId };
  });

  const record = deps.recordGapAnswered ?? recordKnowledgeGapAnswered;
  try {
    await record({ proposalId: input.proposalId, origin: input.origin ?? defaultConsoleOrigin() });
  } catch {
    // The answer is published; the daemon also finds it on its next digest.
    console.warn("[knowledge] gap-answered inbox item was not recorded", { proposalId: input.proposalId });
  }
  return outcome;
}

/** A minimal, semantic PT-BR page. Everything is escaped; no script and no external asset. */
export function renderFaqHtml(
  entries: ReadonlyArray<{ anchor: string; question: string; answer: string; updatedAt: string }>,
  meta: { projectName: string },
): string {
  const sections = entries
    .map((entry) => {
      const paragraphs = entry.answer
        .replace(/\r\n?/g, "\n")
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`)
        .join("");
      const updated = formatPtBrDate(entry.updatedAt);
      return [
        "<section>",
        `<h2 id="${escapeHtml(entry.anchor)}">${escapeHtml(entry.question)}</h2>`,
        paragraphs,
        updated ? `<p class="updated">Atualizado em <time datetime="${escapeHtml(entry.updatedAt)}">${updated}</time></p>` : "",
        "</section>",
      ].join("");
    })
    .join("\n");
  return [
    "<!doctype html>",
    '<html lang="pt-BR">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Perguntas frequentes</title>",
    "<style>",
    "body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.6;color:#1f2328;background:#fff}",
    "main{max-width:42rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}",
    "h1{font-size:1.75rem;margin:0 0 .25rem}",
    ".project{color:#59636e;margin:0 0 2rem}",
    "section{border-top:1px solid #d1d9e0;padding:1.25rem 0}",
    "h2{font-size:1.15rem;margin:0 0 .5rem}",
    "h2:target{scroll-margin-top:1rem}",
    ".updated{color:#59636e;font-size:.85rem}",
    "@media (prefers-color-scheme:dark){body{color:#f0f6fc;background:#0d1117}.project,.updated{color:#9198a1}section{border-color:#3d444d}}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>Perguntas frequentes</h1>",
    `<p class="project">${escapeHtml(meta.projectName)}</p>`,
    sections,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * Publishes one Console-rendered HTML page as a public route of the project's
 * default site: an upload session, a server-side PUT of `index.html`, then
 * finalize with the route. The Console acts as the organization (`system`
 * actor with the owner role), so the operator's own role is checked by the
 * caller, not here.
 */
export async function writeConsoleRenderedRoute(
  input: { projectId: string; path: string; html: string; reason: string; actorUserId: string; requestId: string },
  deps: { storage?: PageObjectStorage; fetch?: typeof fetch } = {},
): Promise<{ siteId: string; releaseId: string; routeId: string; host: string }> {
  const [project] = await db
    .select({ id: schema.projects.id, organizationId: schema.projects.organizationId })
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .limit(1);
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  const site = await findFaqSite(project.id, project.organizationId);
  if (!site) throw new ConsoleApiError(409, { error: "faq_site_unavailable" });

  const storage = deps.storage ?? createPageObjectStorageFromEnv();
  const fetchImpl = deps.fetch ?? fetch;
  const context: PagePublishContext = {
    actorId: input.actorUserId,
    actorType: "system",
    membershipRole: "owner",
    organizationId: project.organizationId,
  };
  const body = Buffer.from(input.html, "utf8");
  const packageManifest = {
    entrypoint: "index.html",
    files: [{ path: "index.html", sha256: sha256Hex(input.html), sizeBytes: body.byteLength, contentType: "text/html; charset=utf-8" }],
  };

  const session = await createPageUploadSession({
    context,
    input: { projectRef: project.id, siteRef: site.id, packageManifest },
    requestId: input.requestId,
    storage,
  });
  for (const file of uploadPolicyFiles(session.uploadPolicy)) {
    // The metadata-only driver (local development) keeps no bytes.
    if (file.method !== "PUT" || !file.url) continue;
    const response = await fetchImpl(file.url, { method: "PUT", headers: file.headers, body });
    if (!response.ok) throw new ConsoleApiError(502, { error: "publish_storage_failed" });
  }

  const result = await finalizePageUploadSession({
    context,
    input: {
      uploadSessionId: session.uploadSession.id,
      packageManifest,
      artifact: { slug: FAQ_ARTIFACT_SLUG, name: "FAQ" },
      publish: {
        siteRef: site.id,
        route: { path: input.path, visibility: "public" },
        replaceRelease: false,
        reason: input.reason,
      },
    },
    requestId: input.requestId,
    storage,
  });
  const route = result.routes.find((candidate) => candidate.path === input.path);
  if (!result.release || !route) throw new ConsoleApiError(502, { error: "publish_storage_failed" });
  return { siteId: site.id, releaseId: result.release.id, routeId: route.routeId, host: site.defaultHostname };
}

/**
 * Holds `pg_try_advisory_lock(hashtext('knowledge_faq:' || projectId))` on a
 * dedicated single connection (a session lock cannot live on the pooled
 * runtime URL), retrying every 500 ms for up to 30 s, else 409 `faq_busy`.
 */
export async function withFaqLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; retryMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? FAQ_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? FAQ_LOCK_RETRY_MS;
  const key = `knowledge_faq:${projectId}`;
  const connection = postgres(resolveDatabaseUrl({ purpose: "migration" }).url, { max: 1, prepare: false });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await connection<Array<{ locked: boolean }>>`select pg_try_advisory_lock(hashtext(${key})) as locked`;
      if (row?.locked) break;
      if (Date.now() + retryMs > deadline) throw new ConsoleApiError(409, { error: "faq_busy" });
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    try {
      return await fn();
    } finally {
      await connection`select pg_advisory_unlock(hashtext(${key}))`.catch(() => undefined);
    }
  } finally {
    await connection.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** `slug(fold(question))`, at most 48 chars, `-2`, `-3`… on collision. */
export function faqAnchor(question: string, taken: ReadonlySet<string>): string {
  const base =
    foldKnowledgeText(question)
      .replace(/\s+/g, "-")
      .slice(0, FAQ_ANCHOR_MAX_CHARS)
      .replace(/-+$/g, "") || "pergunta";
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, FAQ_ANCHOR_MAX_CHARS - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A route is public only when it is public and the site's default is public too. */
export function isEffectivelyPublic(siteDefaultVisibility: string, routeVisibility: string): boolean {
  return siteDefaultVisibility === "public" && routeVisibility === "public";
}

type PendingGap = {
  id: string;
  organizationId: string;
  projectId: string;
  requestedAudienceJson: Record<string, unknown>;
  localInstallationId: string | null;
};

async function loadPendingGap(proposalId: string, now: Date): Promise<PendingGap> {
  const [proposal] = await db
    .select({
      id: schema.knowledgeProposals.id,
      organizationId: schema.knowledgeProposals.organizationId,
      projectId: schema.knowledgeProposals.projectId,
      kind: schema.knowledgeProposals.kind,
      status: schema.knowledgeProposals.status,
      expiresAt: schema.knowledgeProposals.expiresAt,
      requestedAudienceJson: schema.knowledgeProposals.requestedAudienceJson,
      localInstallationId: schema.knowledgeProposals.localInstallationId,
    })
    .from(schema.knowledgeProposals)
    .where(eq(schema.knowledgeProposals.id, proposalId))
    .limit(1);
  if (!proposal || proposal.kind !== "gap" || !proposal.projectId) {
    throw new ConsoleApiError(404, { error: "knowledge_proposal_not_found" });
  }
  if (proposal.status !== "pending" || proposal.expiresAt <= now) {
    throw new ConsoleApiError(409, { error: "knowledge_proposal_closed" });
  }
  return { ...proposal, projectId: proposal.projectId };
}

async function findFaqSite(projectId: string, organizationId: string) {
  const [site] = await db
    .select({
      id: schema.pageSites.id,
      defaultHostname: schema.pageSites.defaultHostname,
      defaultVisibility: schema.pageSites.defaultVisibility,
      activeReleaseId: schema.pageSites.activeReleaseId,
    })
    .from(schema.pageSites)
    .where(
      and(
        eq(schema.pageSites.projectId, projectId),
        eq(schema.pageSites.organizationId, organizationId),
        eq(schema.pageSites.isDefault, true),
        eq(schema.pageSites.status, "active"),
      ),
    )
    .limit(1);
  return site ?? null;
}

/**
 * True when the active release serves /faq from a page someone else published:
 * its route has no `managedBy: "faq"` mark (or that mark was suspended because
 * a different page replaced ours) and it is not our artifact.
 */
async function faqRouteTaken(siteId: string): Promise<boolean> {
  const rows = await db
    .select({ routeConfigJson: schema.pageRoutes.routeConfigJson, artifactSlug: schema.artifacts.slug })
    .from(schema.pageReleaseRoutes)
    .innerJoin(schema.pageSites, eq(schema.pageSites.activeReleaseId, schema.pageReleaseRoutes.releaseId))
    .innerJoin(schema.pageRoutes, eq(schema.pageRoutes.id, schema.pageReleaseRoutes.routeId))
    .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.pageReleaseRoutes.artifactId))
    .where(and(eq(schema.pageSites.id, siteId), eq(schema.pageReleaseRoutes.path, FAQ_PATH)));
  return rows.some((row) => {
    const mark = readRouteMark(row.routeConfigJson);
    if (mark) return mark.managedBy !== "faq" || mark.suspendedReason === "new_version";
    return row.artifactSlug !== FAQ_ARTIFACT_SLUG;
  });
}

async function listApprovedFaqGaps(projectId: string) {
  const rows = await db
    .select({
      answerText: schema.knowledgeProposals.answerText,
      faqQuestion: schema.knowledgeProposals.faqQuestion,
      resultJson: schema.knowledgeProposals.resultJson,
      requestedAudienceJson: schema.knowledgeProposals.requestedAudienceJson,
      localInstallationId: schema.knowledgeProposals.localInstallationId,
      decidedAt: schema.knowledgeProposals.decidedAt,
      createdAt: schema.knowledgeProposals.createdAt,
    })
    .from(schema.knowledgeProposals)
    .where(
      and(
        eq(schema.knowledgeProposals.projectId, projectId),
        eq(schema.knowledgeProposals.kind, "gap"),
        eq(schema.knowledgeProposals.status, "approved"),
        sql`${schema.knowledgeProposals.resultJson} ? 'anchor'`,
      ),
    )
    .orderBy(asc(schema.knowledgeProposals.decidedAt), asc(schema.knowledgeProposals.createdAt));
  return rows.flatMap((row) => {
    const anchor = typeof row.resultJson.anchor === "string" ? row.resultJson.anchor : null;
    if (!anchor || !row.answerText || !row.faqQuestion) return [];
    return [
      {
        anchor,
        question: row.faqQuestion,
        answer: row.answerText,
        updatedAt: (row.decidedAt ?? row.createdAt).toISOString(),
        audience: contactsAudience(row.requestedAudienceJson, row.localInstallationId),
      },
    ];
  });
}

function contactsAudience(requested: Record<string, unknown>, localInstallationId: string | null): KnowledgeMarkAudience | null {
  if (requested.kind !== "contacts") return null;
  const installation = typeof requested.localInstallationId === "string" ? requested.localInstallationId : localInstallationId;
  const instanceId = typeof requested.instanceId === "string" ? requested.instanceId : null;
  if (!installation || !instanceId) return null;
  const label = typeof requested.label === "string" && requested.label.trim() ? requested.label.trim().slice(0, 200) : instanceId;
  return { kind: "contacts", localInstallationId: installation, instanceId, label };
}

function unionContactsAudiences(audiences: ReadonlyArray<KnowledgeMarkAudience | null>): KnowledgeMarkAudience[] {
  const seen = new Map<string, KnowledgeMarkAudience>();
  for (const audience of audiences) {
    if (!audience || audience.kind !== "contacts") continue;
    const key = `${audience.localInstallationId}:${audience.instanceId}`;
    if (!seen.has(key)) seen.set(key, audience);
  }
  return [...seen.values()];
}

function uploadPolicyFiles(policy: Record<string, unknown>) {
  const files = Array.isArray(policy.files) ? policy.files : [];
  return files.flatMap((file) => {
    if (!file || typeof file !== "object") return [];
    const record = file as Record<string, unknown>;
    const headers =
      record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
        ? Object.fromEntries(Object.entries(record.headers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {};
    return [{ method: typeof record.method === "string" ? record.method : null, url: typeof record.url === "string" ? record.url : null, headers }];
  });
}

function formatPtBrDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function defaultConsoleOrigin() {
  return raviLinkConsoleOrigin("https://console.ravi.bot/");
}
