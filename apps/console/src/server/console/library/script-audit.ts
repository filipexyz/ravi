// `POST widgets/<scope>/<slug>/versions/<n>/audit` (Console only): stores the
// accessibility audit an organization owner or admin ran in the Console on a
// published widget version with `widget.js` (JS-CONTRACT section 6). The audit
// itself runs in the browser (axe-core in a sandboxed frame); the server
// checks who sends it, that it is about this version's script, and that its
// status follows from its violations. The page kit ships a widget with code
// only when its version's audit passed (`KIT_WIDGET_UNAUDITED` otherwise).

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";
import { auditStatusOf, readScriptAudit } from "@/shared/widgets/script/audit";
import { WIDGET_SCRIPT_FILE } from "@/shared/widgets/script/check";
import type { WidgetScriptAudit } from "@/shared/widgets/types";

import { SCRIPT_PUBLISHING_ORG_ROLES } from "./kinds";
import { findItemForProposals } from "./proposals";
import { assertLibraryFeature, auditEvent, conflict, notFound, PUBLISHED_STATUSES, type LibraryActor, type LibraryWorkspace } from "./service";

export const MAX_AUDIT_VIOLATIONS = 200;

const auditBodySchema = z
  .object({
    status: z.enum(["pass", "fail"]),
    violations: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            impact: z.enum(["minor", "moderate", "serious", "critical"]).nullable(),
            help: z.string().max(1000),
            nodes: z.number().int().min(0).max(100_000),
          })
          .strict(),
      )
      .max(MAX_AUDIT_VIOLATIONS),
    scriptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export async function recordWidgetScriptAudit(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  scopeRef: string;
  slug: string;
  version: number;
  body: unknown;
}): Promise<{ status: number; payload: { ref: string; version: number; audit: WidgetScriptAudit } }> {
  await assertLibraryFeature(input.workspace);
  // The audit runs in a Console screen; a CLI session cannot vouch for one.
  if (input.actor.surface !== "console") throw cliApiError(404, "NOT_FOUND", "Unknown library route.");
  const parsed = auditBodySchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid audit request: ${fields.join(", ")}.`);
  }
  const body = parsed.data;
  const context = await findItemForProposals({ workspace: input.workspace, kind: "widget", scopeRef: input.scopeRef, slug: input.slug });
  if (!SCRIPT_PUBLISHING_ORG_ROLES.has(input.workspace.membership.role)) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Only organization owners and admins audit widgets with widget.js.");
  }
  const status = auditStatusOf(body.violations);
  if (status !== body.status) {
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid audit request: status is ${status} for these violations (serious or critical fail).`);
  }

  const { item, project } = context;
  const [version] = await db
    .select()
    .from(schema.libraryVersions)
    .where(and(eq(schema.libraryVersions.itemId, item.id), eq(schema.libraryVersions.versionNumber, input.version), PUBLISHED_STATUSES))
    .limit(1);
  if (!version) throw notFound("That version does not exist.");
  const [script] = await db
    .select({ sha256: schema.libraryFiles.sha256 })
    .from(schema.libraryFiles)
    .where(and(eq(schema.libraryFiles.versionId, version.id), eq(schema.libraryFiles.path, WIDGET_SCRIPT_FILE)))
    .limit(1);
  if (!script) throw conflict("no_script", `Version ${input.version} has no widget.js; only widgets with code are audited.`);
  if (script.sha256 !== body.scriptSha256) {
    throw conflict("script_mismatch", `This audit ran on other code than version ${input.version}'s widget.js. Open the version again and rerun it.`, {
      scriptSha256: script.sha256,
    });
  }

  const audit: WidgetScriptAudit = {
    status,
    violations: body.violations,
    scriptSha256: script.sha256,
    auditedBy: input.workspace.user.id,
    auditedAt: new Date().toISOString(),
  };
  const before = readScriptAudit(version.scriptAudit);
  await db.transaction(async (tx) => {
    await tx
      .update(schema.libraryVersions)
      .set({ scriptAudit: audit, updatedAt: new Date() })
      .where(eq(schema.libraryVersions.id, version.id));
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId: item.organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: "library.widget.script_audited",
        before: before ? { version: input.version, status: before.status } : null,
        after: { version: input.version, status, violations: body.violations.length, scriptSha256: script.sha256 },
      }),
    );
  });
  return { status: 200, payload: { ref: `${project ? project.slug : "org"}/${item.slug}`, version: input.version, audit } };
}
