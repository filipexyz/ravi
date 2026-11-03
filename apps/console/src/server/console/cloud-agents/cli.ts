import { projectAuthorizationFromCli, type VerifiedCliProjectContext } from "@/server/cli/project-authorization";
// The cloud agents routes under `/api/cli/cloud-agents/...` (CLI bearer auth,
// the Library route's scopes: no new scope, no new `ravi login`):
//
//   GET  credential                       POST credential            POST credential/remove
//   GET  agents?project=                  POST agents/deploy
//   GET  agents/<id>                      POST agents/<id>/archive
//   POST runs                             GET  runs?project=&agent=&status=&cursor=&origin=installation
//   GET  runs/<id>                        GET  runs/<id>/events?after=
//   POST runs/<id>/messages               POST runs/<id>/stop
//   POST runs/<id>/approvals/<approvalId> GET  runs/<id>/outputs/<outputId>   (bytes)
//   POST runs/<id>/delivered
//   GET  schedules?project=               POST schedules
//   POST schedules/<id>                   POST schedules/<id>/delete

import type { CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { parseConsoleRole } from "@/server/console/workspace";

import type { CloudContext, CloudDeps } from "./access";
import { decideCloudApproval } from "./approvals";
import { getCloudCredential, removeCloudCredential, setCloudCredential } from "./credential";
import { archiveCloudAgent, deployCloudAgent, getCloudAgent, listCloudAgents } from "./deploy";
import { cloudError } from "./errors";
import {
  downloadCloudRunOutput,
  getCloudRun,
  listCloudRunEvents,
  listCloudRuns,
  markCloudRunDelivered,
  sendCloudRunMessage,
  serializeRunById,
  startCloudRun,
  stopCloudRun,
} from "./runs";
import { createCloudSchedule, deleteCloudSchedule, listCloudSchedules, updateCloudSchedule } from "./schedules";
import { resolveCloudDeps } from "./access";

export const CLOUD_AGENTS_CLI_READ_SCOPES = ["console.projects.read"] as const;
export const CLOUD_AGENTS_CLI_WRITE_SCOPES = ["console.projects.link"] as const;
export const CLOUD_AGENTS_MAX_BODY_BYTES = 512 * 1024;

export type CloudAgentsCliRequest = {
  auth: Pick<CliAuthContext, "membership" | "organization" | "scopes" | "user"> & VerifiedCliProjectContext;
  requestId: string;
  method: string;
  segments: readonly string[];
  body: unknown;
  searchParams: URLSearchParams;
  deps?: CloudDeps;
};

export type CloudAgentsCliResult =
  | { kind: "json"; status: number; payload: unknown }
  | { kind: "bytes"; status: number; body: ReadableStream<Uint8Array> | null; contentType: string; name: string; size: number | null };

export async function handleCloudAgentsCliRequest(request: CloudAgentsCliRequest): Promise<CloudAgentsCliResult> {
  const method = request.method.toUpperCase();
  const scopes = method === "GET" ? CLOUD_AGENTS_CLI_READ_SCOPES : CLOUD_AGENTS_CLI_WRITE_SCOPES;
  for (const scope of scopes) {
    if (!request.auth.scopes.includes(scope)) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", `This CLI session lacks the ${scope} scope. Log in again to grant it.`);
    }
  }
  const role = parseConsoleRole(request.auth.membership.role);
  if (!role) throw cliApiError(403, "ORG_ACCESS_DENIED");
  const ctx: CloudContext = {
    workspace: {
      authorization: projectAuthorizationFromCli(request.auth),
      user: { id: request.auth.user.id },
      organization: { id: request.auth.organization.id, slug: request.auth.organization.slug },
      membership: { role },
    },
    requestId: request.requestId,
    surface: "cli",
    localInstallationId: request.auth.localInstallation?.id ?? null,
    deps: request.deps,
  };
  return routeCloudAgentsRequest(ctx, method, request.segments, request.body, request.searchParams);
}

export async function routeCloudAgentsRequest(
  ctx: CloudContext,
  method: string,
  segments: readonly string[],
  body: unknown,
  query: URLSearchParams,
): Promise<CloudAgentsCliResult> {
  const json = (payload: unknown, status = 200): CloudAgentsCliResult => ({ kind: "json", status, payload });
  const [group, id, action, subId, ...rest] = segments;
  const param = (name: string) => query.get(name)?.trim() || null;

  if (group === "credential") {
    if (!id && method === "GET") return json({ credential: await getCloudCredential(ctx) });
    if (!id && method === "POST") return json({ credential: await setCloudCredential(ctx, body) });
    if (id === "remove" && !action && method === "POST") return json({ credential: await removeCloudCredential(ctx) });
  }

  if (group === "agents") {
    if (!id && method === "GET") return json(await listCloudAgents(ctx, param("project")));
    if (id === "deploy" && !action && method === "POST") {
      const result = await deployCloudAgent(ctx, body);
      return json(result, result.changed ? 201 : 200);
    }
    if (id && !action && method === "GET") return json(await getCloudAgent(ctx, id));
    if (id && action === "archive" && !subId && method === "POST") return json(await archiveCloudAgent(ctx, id));
  }

  if (group === "runs") {
    if (!id && method === "POST") return json(await startCloudRun(ctx, withTrigger(body)), 201);
    if (!id && method === "GET") {
      return json(
        await listCloudRuns(ctx, {
          project: param("project"),
          agent: param("agent"),
          status: param("status"),
          cursor: param("cursor"),
          origin: param("origin"),
          limit: param("limit") ? Number(param("limit")) : null,
        }),
      );
    }
    if (id && !action && method === "GET") return json(await getCloudRun(ctx, id));
    if (id && action === "events" && !subId && method === "GET") return json(await listCloudRunEvents(ctx, id, param("after")));
    if (id && action === "messages" && !subId && method === "POST") return json(await sendCloudRunMessage(ctx, id, body));
    if (id && action === "stop" && !subId && method === "POST") return json(await stopCloudRun(ctx, id));
    if (id && action === "delivered" && !subId && method === "POST") return json(await markCloudRunDelivered(ctx, id));
    if (id && action === "approvals" && subId && rest.length === 0 && method === "POST") {
      await decideCloudApproval(ctx, id, subId, body);
      return json({ run: await serializeRunById(resolveCloudDeps(ctx.deps), id, { outputs: false }) });
    }
    if (id && action === "outputs" && subId && rest.length === 0 && method === "GET") {
      const file = await downloadCloudRunOutput(ctx, id, subId);
      return { kind: "bytes", status: 200, body: file.body, contentType: file.contentType, name: file.name, size: file.size };
    }
  }

  if (group === "schedules") {
    if (!id && method === "GET") return json(await listCloudSchedules(ctx, param("project")));
    if (!id && method === "POST") return json(await createCloudSchedule(ctx, body), 201);
    if (id && !action && method === "POST") return json(await updateCloudSchedule(ctx, id, body));
    if (id && action === "delete" && !subId && method === "POST") return json(await deleteCloudSchedule(ctx, id));
  }

  throw cloudError("not_found", "Unknown cloud agents route.");
}

/** A CLI run with a task origin is a task run unless the body says otherwise. */
function withTrigger(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const origin = record.origin as { kind?: unknown } | undefined;
  if (record.trigger === undefined && origin?.kind === "task") return { ...record, trigger: "task" };
  return body;
}
