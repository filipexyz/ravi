// What every operation handler shares: the person's workspace, the project a
// call runs in (kept inside a cloud run's project), the Bases caller, the
// idempotency key and the mapping of service errors to operation errors.
// See `.ravi/specs/console/operations/SPEC.md`.

import { createHash } from "node:crypto";

import { ZodError } from "zod";

import type { ConsoleFeatureKey } from "@/features/console/types";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import type { BasesCaller } from "@/server/console/bases/context";
import { basesCallerForPagesViewer } from "@/server/console/bases/context";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";

import type { OperationActor } from "./types";

export const PROJECT_PROPERTY = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: "Project slug or id the call runs in. Use ravi.projects.list to find one.",
} as const;

export function workspaceOf(actor: OperationActor): ProjectAccessWorkspace {
  return {
    authorization: actor.authorization,
    user: { id: actor.userId },
    organization: { id: actor.organizationId },
    membership: { role: actor.orgRole ?? "guest" },
  };
}

/** Bases caller for the actor: the Pages viewer session in a Page chat, the person on MCP. */
export function basesCallerForActor(actor: OperationActor): BasesCaller {
  if (actor.surface === "page_chat" && actor.site && actor.pagesSessionId) {
    return basesCallerForPagesViewer({
      organizationId: actor.organizationId,
      userId: actor.userId,
      email: actor.email,
      pagesSessionId: actor.pagesSessionId,
      siteId: actor.site.id,
      orgRole: actor.orgRole,
      requestId: actor.requestId,
    });
  }
  return {
    authorization: actor.authorization,
    organizationId: actor.organizationId,
    user: { id: actor.userId, email: actor.email?.trim().toLowerCase() || null },
    orgRole: actor.orgRole,
    actorType: actor.authorization ? "cli" : "user",
    actorId: actor.userId,
    surface: actor.authorization ? "cli" : "console",
    requestId: actor.requestId,
    source: actor.authorization ? { kind: "local_installation", id: actor.authorization.installationId } : { kind: "user", id: actor.userId },
    pageSiteId: null,
    localInstallationId: actor.authorization?.installationId ?? null,
    clientHint: { sdk: actor.surface === "mcp" ? "mcp" : "page-chat" },
  };
}

export function outsideBoundProject() {
  return new ConsoleApiError(403, { error: "operation_forbidden", reason: "A cloud run works only in its own project." });
}

/** Refuses a project other than a cloud run's own; any project passes for a person. */
export function keepInBoundProject(actor: OperationActor, projectId: string) {
  if (actor.boundProjectId && projectId !== actor.boundProjectId) throw outsideBoundProject();
  return projectId;
}

/**
 * The id of the project a call names, which the person must be able to read
 * (or write), kept inside a cloud run's project. In a Page chat with no
 * project named, the site's project.
 */
export async function resolveOperationProject(
  actor: OperationActor,
  projectRef: string | null | undefined,
  options: { access?: "read" | "write"; findProject?: typeof findAccessibleProjectRecord } = {},
): Promise<{ id: string; slug: string }> {
  const findProject = options.findProject ?? findAccessibleProjectRecord;
  const ref = typeof projectRef === "string" && projectRef.trim() ? projectRef.trim() : (actor.site?.projectId ?? null);
  if (!ref) {
    throw new ConsoleApiError(400, { error: "payload_invalid", fieldErrors: { project: "Name the project (slug or id)." } });
  }
  const project = await findProject(workspaceOf(actor), ref, options.access ?? "read");
  if (!project) throw new ConsoleApiError(403, { error: "operation_forbidden" });
  keepInBoundProject(actor, project.id);
  return { id: project.id, slug: (project as { slug?: string }).slug ?? ref };
}

export function operationIdempotencyKey(actor: OperationActor, id: string, seed: string | undefined, body: Record<string, unknown>) {
  const material = seed ?? JSON.stringify(body);
  const hash = createHash("sha256").update(`${actor.surface}:${actor.userId}:${id}:${material}`).digest("hex").slice(0, 40);
  return `op:${hash}`;
}

export async function consoleFeatureEnabled(actor: OperationActor, key: ConsoleFeatureKey) {
  if (!actor.orgRole) return false;
  const access = await getConsoleFeatureAccessForOrganizationRole({ organizationId: actor.organizationId, role: actor.orgRole });
  const feature = access.byKey[key];
  return Boolean(feature?.available && feature.authorized);
}

export function operationForbidden(reason?: string) {
  return new ConsoleApiError(403, { error: "operation_forbidden", ...(reason ? { reason } : {}) });
}

export function operationInvalid(field: string, message: string) {
  return new ConsoleApiError(400, { error: "payload_invalid", fieldErrors: { [field]: message } });
}

/**
 * A service error as an operation error the MCP Worker can show: the CLI error
 * code (lowercase) with its message as `reason`, and Bases field errors kept.
 * Anything unexpected is `operation_unavailable`.
 */
export function operationErrorFrom(error: unknown): ConsoleApiError {
  if (error instanceof ConsoleApiError) return error;
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues.slice(0, 20)) fieldErrors[issue.path.join(".") || "input"] ??= issue.message;
    return new ConsoleApiError(400, { error: "payload_invalid", fieldErrors });
  }
  if (error instanceof CliApiError) {
    if (error.status >= 500) return new ConsoleApiError(503, { error: "operation_unavailable" });
    const fieldErrors = stringRecord(error.details?.fieldErrors);
    return new ConsoleApiError(error.status, {
      error: error.status === 403 ? "operation_forbidden" : error.code.toLowerCase(),
      reason: error.message,
      ...(fieldErrors ? { fieldErrors } : {}),
    });
  }
  return new ConsoleApiError(503, { error: "operation_unavailable" });
}

/** Runs `fn` and turns any service error into an operation error. */
export async function withOperationErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw operationErrorFrom(error);
  }
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) out[key] = String(item);
  return Object.keys(out).length > 0 ? out : null;
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function previewText(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
