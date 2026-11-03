import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { authenticateCliRequest, type CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliNoContent, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { parseConsoleRole } from "@/server/console/workspace";
import {
  createConsoleWatch,
  deleteConsoleWatch,
  getConsoleWatch,
  getConsoleWatchStatus,
  listConsoleWatches,
  listGithubInstallationRepos,
  listGithubInstallations,
  listWatchCapabilities,
  setConsoleWatchEnabled,
  updateConsoleWatch,
  type ConsoleWatchWorkspace,
} from "@/server/console/watches";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

const jsonRecordSchema = z.record(z.string(), z.unknown());

const createWatchBodySchema = z.object({
  clientRequestId: z.string().min(1).max(160).optional(),
  delivery: jsonRecordSchema.optional(),
  description: z.string().max(500).optional(),
  eventTypes: z.array(z.string().min(1)).min(1),
  filters: jsonRecordSchema.optional(),
  name: z.string().max(160).optional(),
  owner: z.string().min(1).max(160).optional(),
  placement: z.enum(["auto", "console", "local"]).optional(),
  projectId: z.string().min(1).max(240).optional(),
  projectRef: z.string().min(1).max(240).optional(),
  provider: z.string().min(1).max(80),
  providerConnectionId: z.string().min(1).max(160).optional(),
  providerInstallationId: z.string().min(1).max(160).optional(),
  providerResource: z.object({
    fullName: z.string().min(1).max(260).optional(),
    owner: z.string().min(1).max(160).optional(),
    ref: z.string().min(1).max(260).optional(),
    repo: z.string().min(1).max(160).optional(),
    resourceRef: z.string().min(1).max(260).optional(),
  }).optional(),
  providerResourceId: z.string().min(1).max(240).optional(),
  repo: z.string().min(1).max(160).optional(),
  resourceRef: z.string().min(1).max(260).optional(),
  idempotencyKey: z.string().min(1).max(160).optional(),
});

const updateWatchBodySchema = z.object({
  delivery: jsonRecordSchema.optional(),
  description: z.string().max(500).nullable().optional(),
  eventTypes: z.array(z.string().min(1)).min(1).optional(),
  filters: jsonRecordSchema.optional(),
  name: z.string().max(160).nullable().optional(),
});

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const workspace = workspaceFromCliAuth(auth);
    const searchParams = new URL(request.url).searchParams;

    if (matches(segments, "capabilities")) {
      requireScope(auth, "console.watches.read");
      return cliSuccess(
        await listWatchCapabilities({
          eventTypes: parseEventTypes(searchParams),
          projectRef: searchParams.get("projectRef"),
          provider: searchParams.get("provider"),
          workspace,
        }),
      );
    }

    if (matches(segments, "providers", "github", "installations")) {
      requireScope(auth, "console.watches.read");
      return cliSuccess(
        await listGithubInstallations({
          projectRef: searchParams.get("projectRef"),
          workspace,
        }),
      );
    }

    if (matches(segments, "providers", "github", "installations", ":installationId", "repos")) {
      requireScope(auth, "console.watches.read");
      return cliSuccess(
        await listGithubInstallationRepos({
          installationId: segments[3]!,
          projectRef: searchParams.get("projectRef"),
          workspace,
        }),
      );
    }

    if (segments.length === 0) {
      requireScope(auth, "console.watches.read");
      return cliSuccess(
        await listConsoleWatches({
          projectRef: searchParams.get("projectRef"),
          provider: searchParams.get("provider"),
          status: searchParams.get("status"),
          workspace,
        }),
      );
    }

    if (segments.length === 1) {
      requireScope(auth, "console.watches.read");
      return cliSuccess(await getConsoleWatch({ watchId: segments[0]!, workspace }));
    }

    if (matches(segments, ":watchId", "status")) {
      requireScope(auth, "console.watches.read");
      return cliSuccess(await getConsoleWatchStatus({ watchId: segments[0]!, workspace }));
    }

    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown watches CLI route.");
  } catch (error) {
    return cliFailure(watchCliError(error), requestId);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const workspace = workspaceFromCliAuth(auth);
    requireScope(auth, "console.watches.write");

    if (segments.length === 0) {
      const body = createWatchBodySchema.parse(await readJsonBody(request, requestId));
      return cliSuccess(
        await createConsoleWatch({
          body: {
            ...body,
            clientRequestId: body.clientRequestId ?? body.idempotencyKey ?? request.headers.get("idempotency-key"),
          },
          requestId,
          workspace,
        }),
        { status: 201 },
      );
    }

    if (matches(segments, ":watchId", "enable")) {
      return cliSuccess(
        await setConsoleWatchEnabled({
          enabled: true,
          requestId,
          watchId: segments[0]!,
          workspace,
        }),
      );
    }

    if (matches(segments, ":watchId", "disable")) {
      return cliSuccess(
        await setConsoleWatchEnabled({
          enabled: false,
          requestId,
          watchId: segments[0]!,
          workspace,
        }),
      );
    }

    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown watches CLI route.");
  } catch (error) {
    return cliFailure(watchCliError(error), requestId);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    if (segments.length !== 1) {
      throw cliApiError(404, "PAYLOAD_INVALID", "Unknown watches CLI route.");
    }

    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    requireScope(auth, "console.watches.write");
    const workspace = workspaceFromCliAuth(auth);
    const body = updateWatchBodySchema.parse(await readJsonBody(request, requestId));

    return cliSuccess(
      await updateConsoleWatch({
        body,
        requestId,
        watchId: segments[0]!,
        workspace,
      }),
    );
  } catch (error) {
    return cliFailure(watchCliError(error), requestId);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    if (segments.length !== 1) {
      throw cliApiError(404, "PAYLOAD_INVALID", "Unknown watches CLI route.");
    }

    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    requireScope(auth, "console.watches.write");
    const workspace = workspaceFromCliAuth(auth);
    await deleteConsoleWatch({ requestId, watchId: segments[0]!, workspace });
    return cliNoContent();
  } catch (error) {
    return cliFailure(watchCliError(error), requestId);
  }
}

function workspaceFromCliAuth(auth: CliAuthContext): ConsoleWatchWorkspace {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return {
    authorization: projectAuthorizationFromCli(auth),
    user: { id: auth.user.id },
    organization: {
      id: auth.organization.id,
      name: auth.organization.name,
      slug: auth.organization.slug,
    },
    membership: { role },
    localInstallation: {
      id: auth.localInstallation.id,
      name: auth.localInstallation.name,
      capabilitiesJson: auth.scopes,
    },
  };
}

function requireScope(auth: CliAuthContext, scope: string) {
  if (!auth.scopes.includes(scope)) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
}

function parseEventTypes(searchParams: URLSearchParams) {
  const repeated = searchParams.getAll("eventType");
  const csv = searchParams.get("eventTypes");
  const values = [
    ...repeated,
    ...(csv ? csv.split(",") : []),
  ].map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function matches(segments: string[], ...pattern: string[]) {
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}

function watchCliError(error: unknown) {
  if (error instanceof z.ZodError) return cliApiError(400, "PAYLOAD_INVALID");
  return error;
}
