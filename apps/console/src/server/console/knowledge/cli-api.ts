import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { authenticateCliRequest, type CliAuthContext } from "@/server/cli/auth";
import { cliApiError, type CliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { parseConsoleRole } from "@/server/console/workspace";

import {
  createKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeSources,
} from "../knowledge";
import { ingestKnowledgeSource } from "./ingestion";
import { retrieveKnowledge } from "./retrieval";

// Project-scoped Knowledge CLI routes (`/api/cli/projects/:ref/knowledge/*`).
// Scope, then the role-based `console.knowledge` gate, then the service. The
// legacy DELETE is gone (sources are deleted from the Console UI).

type KnowledgeCliWorkspace = {
  authorization?: import("../authorization/identity").AuthorizationActor["delegation"];
  mode: "workos";
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
};

type KnowledgeCliServices = {
  createSource: (input: Parameters<typeof createKnowledgeSource>[0]) => Promise<unknown>;
  getSource: (input: Parameters<typeof getKnowledgeSource>[0]) => Promise<unknown>;
  ingestSource: (input: Parameters<typeof ingestKnowledgeSource>[0]) => Promise<unknown>;
  listSources: (input: Parameters<typeof listKnowledgeSources>[0]) => Promise<unknown>;
  retrieve: (input: Parameters<typeof retrieveKnowledge>[0]) => Promise<unknown>;
  featureAccess: typeof getConsoleFeatureAccessForOrganizationRole;
};

type KnowledgeCliResult = {
  payload: unknown;
  status: number;
};

const READ_SCOPE = "console.knowledge.read";
const WRITE_SCOPE = "console.knowledge.write";
export const MAX_KNOWLEDGE_CLI_BODY_BYTES = 600 * 1024;

// English messages for the 409 codes Knowledge services throw (CONTRACT §5.1).
// The default CONFLICT message is about contact linking, so never fall back to it.
const CONFLICT_MESSAGES: Readonly<Record<string, string>> = {
  knowledge_ingestion_in_progress: "A knowledge ingestion with this idempotency key is still running.",
  knowledge_route_not_captured: "This page has not been read yet; try again in a minute.",
  faq_site_unavailable: "This project has no Pages host yet.",
  faq_site_not_public:
    "This project's Pages host is private, so clients could not open /faq. Make the host public first, then publish again.",
  faq_route_taken: "This project already has its own /faq page.",
  faq_busy: "Another /faq update is running; try again in a moment.",
  knowledge_proposal_closed: "This proposal was already decided, withdrawn or expired.",
};

const defaultServices: KnowledgeCliServices = {
  createSource: createKnowledgeSource,
  getSource: getKnowledgeSource,
  ingestSource: ingestKnowledgeSource,
  listSources: listKnowledgeSources,
  retrieve: retrieveKnowledge,
  featureAccess: getConsoleFeatureAccessForOrganizationRole,
};

export function knowledgeConflictMessage(code: string): string | null {
  return Object.hasOwn(CONFLICT_MESSAGES, code) ? CONFLICT_MESSAGES[code]! : null;
}

export async function handleKnowledgeCliGet({
  auth,
  projectRef,
  segments,
  services = defaultServices,
}: {
  auth: CliAuthContext;
  projectRef: string;
  segments: string[];
  services?: Partial<KnowledgeCliServices>;
}): Promise<KnowledgeCliResult> {
  requireScope(auth, READ_SCOPE);
  const workspace = workspaceFromCliAuth(auth);
  const resolved = { ...defaultServices, ...services };
  await assertKnowledgeFeatureForProject(auth, resolved.featureAccess);

  if (matches(segments, "sources")) {
    return {
      payload: await resolved.listSources({ projectRef, workspace }),
      status: 200,
    };
  }

  if (matches(segments, "sources", ":sourceId")) {
    return {
      payload: await resolved.getSource({
        projectRef,
        sourceId: segments[1]!,
        workspace,
      }),
      status: 200,
    };
  }

  throw unknownKnowledgeRoute();
}

export async function handleKnowledgeCliPost({
  auth,
  body,
  projectRef,
  requestId,
  segments,
  services = defaultServices,
}: {
  auth: CliAuthContext;
  body: unknown;
  projectRef: string;
  requestId: string;
  segments: string[];
  services?: Partial<KnowledgeCliServices>;
}): Promise<KnowledgeCliResult> {
  const workspace = workspaceFromCliAuth(auth);
  const resolved = { ...defaultServices, ...services };

  if (matches(segments, "sources")) {
    requireScope(auth, WRITE_SCOPE);
    await assertKnowledgeFeatureForProject(auth, resolved.featureAccess);
    return {
      payload: await resolved.createSource({
        body,
        projectRef,
        requestId,
        workspace,
      }),
      status: 201,
    };
  }

  if (matches(segments, "sources", ":sourceId", "ingestions")) {
    requireScope(auth, WRITE_SCOPE);
    await assertKnowledgeFeatureForProject(auth, resolved.featureAccess);
    return {
      payload: await resolved.ingestSource({
        body,
        projectRef,
        requestId,
        sourceId: segments[1]!,
        workspace,
      }),
      status: 201,
    };
  }

  if (matches(segments, "retrieval-runs")) {
    requireScope(auth, READ_SCOPE);
    await assertKnowledgeFeatureForProject(auth, resolved.featureAccess);
    return {
      payload: await resolved.retrieve({
        body,
        projectRef,
        requestId,
        surface: "cli",
        workspace,
      }),
      status: 201,
    };
  }

  throw unknownKnowledgeRoute();
}

export function knowledgeCliError(error: ConsoleApiError): CliApiError {
  const code = error.payload.error;
  const conflict = knowledgeConflictMessage(code);
  if (conflict) return cliApiError(409, "CONFLICT", conflict, { reason: code, code });

  if (code === "payload_too_large" || error.status === 413) {
    return cliApiError(413, "PAYLOAD_INVALID", "Request body is too large.");
  }
  if (code === "invalid_request" || code === "validation_failed") {
    return cliApiError(
      400,
      "PAYLOAD_INVALID",
      undefined,
      error.payload.fieldErrors ? { fieldErrors: error.payload.fieldErrors } : undefined,
    );
  }

  if (
    code === "forbidden" ||
    code === "feature_forbidden" ||
    code === "feature_unavailable" ||
    code === "project_forbidden" ||
    code === "project_not_found" ||
    code === "knowledge_source_not_found"
  ) {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return cliApiError(503, "SERVER_UNAVAILABLE", "Knowledge is temporarily unavailable.");
}

/** The whole project route: auth, body, dispatch and the error envelope, all with `cache-control: no-store`. */
export async function respondKnowledgeProjectCli(
  request: Request,
  params: { projectRef: string; segments: string[] },
  method: "GET" | "POST",
  deps: { authenticate?: typeof authenticateCliRequest; services?: Partial<KnowledgeCliServices> } = {},
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const auth = await (deps.authenticate ?? authenticateCliRequest)(request, requestId, { actor: "executor" });
    const result =
      method === "GET"
        ? await handleKnowledgeCliGet({ auth, projectRef: params.projectRef, segments: params.segments, services: deps.services })
        : await handleKnowledgeCliPost({
            auth,
            body: await readJsonBody(request, requestId, { maxBytes: MAX_KNOWLEDGE_CLI_BODY_BYTES }),
            projectRef: params.projectRef,
            requestId,
            segments: params.segments,
            services: deps.services,
          });
    return cliSuccess(result.payload, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = cliFailure(error instanceof ConsoleApiError ? knowledgeCliError(error) : error, requestId);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}

/** Role-based gate (never `assertConsoleFeatureAccess`: CLI handlers hold no full workspace). */
async function assertKnowledgeFeatureForProject(
  auth: CliAuthContext,
  featureAccess: typeof getConsoleFeatureAccessForOrganizationRole,
) {
  const access = await featureAccess({ organizationId: auth.organization.id, role: auth.membership.role });
  const feature = access.byKey["console.knowledge"];
  if (!feature?.available) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", "Knowledge is not enabled for this organization.", {
      reason: "feature_unavailable",
    });
  }
  if (!feature.authorized) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", "Knowledge is not enabled for your role.", {
      reason: "feature_forbidden",
    });
  }
}

function workspaceFromCliAuth(auth: CliAuthContext): KnowledgeCliWorkspace {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return {
    authorization: projectAuthorizationFromCli(auth),
    mode: "workos",
    user: { id: auth.user.id },
    organization: { id: auth.organization.id },
    membership: { role },
  };
}

function requireScope(auth: CliAuthContext, scope: string) {
  if (!auth.scopes.includes(scope)) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
}

function unknownKnowledgeRoute() {
  return cliApiError(404, "PAYLOAD_INVALID", "Unknown Knowledge CLI route.");
}

function matches(segments: string[], ...pattern: string[]) {
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}
