import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
// CLI envelope for Bases (`/api/cli/projects/<projectRef>/bases/...`): scope
// and feature checks, the CLI caller, and the ConsoleApiError -> CliApiError
// mapping. Routes and services are shared with the Console envelope.

import type { CliActorOptions, CliRequestAccess } from "@/server/cli/actor";
import type { CliAuthContext } from "@/server/cli/auth";
import { cliApiError, type CliApiError, type CliErrorCode } from "@/server/cli/errors";
import type { ConsoleApiError } from "@/server/console/api-error";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { parseConsoleRole } from "@/server/console/workspace";

import { basesCallerFromCliAuth } from "./context";
import { handleBasesRequest, type BasesHttpResult } from "./http";

export const BASES_CLI_READ_SCOPE = "console.bases.read";
export const BASES_CLI_WRITE_SCOPE = "console.bases.write";

/** POST paths (relative to `.../bases`, `*` = any one segment) that only read. */
const READ_POSTS: ReadonlyArray<readonly string[]> = [
  ["*", "rows", "query"],
  ["*", "rows", "aggregate"],
  ["*", "views", "*", "query"],
  ["*", "views", "*", "version"],
  ["*", "charts", "*", "data"],
];

/**
 * `read` for GET and for the POSTs that only read (row query and aggregate,
 * view query and version, chart data); `write` otherwise. Decides the CLI
 * scope and whether the delegated actor's request is audited as a write.
 */
export function basesCliAccess(method: string, segments: readonly string[]): CliRequestAccess {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") return "read";
  if (upper !== "POST") return "write";
  const reads = READ_POSTS.some(
    (pattern) => pattern.length === segments.length && pattern.every((part, index) => part === "*" || part === segments[index]),
  );
  return reads ? "read" : "write";
}

/**
 * How the Bases CLI route resolves the person of the turn: `basesCliAccess`
 * decides read or write, and a named person who cannot be resolved (not
 * linked, binding not approved by them, not a member, malformed contact) is
 * refused on reads too, so an unlinked person never reads as the operator.
 */
export function basesCliActorOptions(
  method: string,
  segments: readonly string[],
): Required<Pick<CliActorOptions, "access" | "unlinkedReads">> {
  return { access: basesCliAccess(method, segments), unlinkedReads: "refuse" };
}

/** `console.bases.read` for reads (`basesCliAccess`); `console.bases.write` otherwise. */
export function basesCliScopeFor(method: string, segments: readonly string[]) {
  return basesCliAccess(method, segments) === "read" ? BASES_CLI_READ_SCOPE : BASES_CLI_WRITE_SCOPE;
}

type BasesFeatureAccessLoader = typeof getConsoleFeatureAccessForOrganizationRole;

export type BasesCliRequest = {
  auth: CliAuthContext;
  requestId: string;
  method: string;
  projectRef: string;
  segments: readonly string[];
  body: unknown;
  searchParams: URLSearchParams;
  idempotencyKey: string | null;
};

export async function handleBasesCliRequest(
  request: BasesCliRequest,
  dependencies: { featureAccess?: BasesFeatureAccessLoader; handle?: typeof handleBasesRequest } = {},
): Promise<BasesHttpResult> {
  const { auth } = request;
  const scope = basesCliScopeFor(request.method, request.segments);
  if (!auth.scopes.includes(scope)) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", `This CLI session lacks the ${scope} scope. Log in again to grant it.`);
  }
  const role = parseConsoleRole(auth.membership.role);
  if (!role) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  const access = await (dependencies.featureAccess ?? getConsoleFeatureAccessForOrganizationRole)({
    organizationId: auth.organization.id,
    role: auth.membership.role,
  });
  const feature = access.byKey["console.bases"];
  if (!feature.available) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Bases are not available for this organization.", { error: "feature_unavailable" });
  }
  if (!feature.authorized) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Bases are not enabled for your role.", { error: "feature_forbidden" });
  }
  const clientHint =
    request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>).clientHint
      : undefined;
  return (dependencies.handle ?? handleBasesRequest)({
    caller: basesCallerFromCliAuth(auth, request.requestId, clientHint),
    workspace: { authorization: projectAuthorizationFromCli(auth), user: { id: auth.user.id }, organization: { id: auth.organization.id }, membership: { role } },
    method: request.method,
    projectRef: request.projectRef,
    segments: request.segments,
    body: request.body,
    searchParams: request.searchParams,
    idempotencyKey: request.idempotencyKey,
  });
}

function cliCodeFor(status: number, code: string): CliErrorCode {
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return code === "version_conflict" || code === "schema_version_conflict" ? "VERSION_CONFLICT" : "CONFLICT";
  if (status === 403) return code.startsWith("feature_") ? "ORG_ACCESS_DENIED" : "PROJECT_ACCESS_DENIED";
  if (status === 400 || status === 413 || status === 422) return "PAYLOAD_INVALID";
  return "SERVER_UNAVAILABLE";
}

/** Maps a Bases `ConsoleApiError` to the CLI envelope; the Bases error body is passed as `details`. */
export function basesCliError(error: ConsoleApiError): CliApiError {
  const payload = error.payload as Record<string, unknown>;
  const code = typeof payload.error === "string" ? payload.error : "error";
  const cliCode = cliCodeFor(error.status, code);
  const status = cliCode === "SERVER_UNAVAILABLE" ? 503 : error.status;
  const message = typeof payload.reason === "string" && payload.reason ? payload.reason : code.replace(/_/g, " ");
  return cliApiError(status, cliCode, message, payload);
}
