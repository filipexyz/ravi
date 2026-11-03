// The Console UI's routes under `/api/console/cloud-agents/...` (session
// cookie): the contract routes of `cli.ts`, plus what only the screens need:
//
//   GET  availability                     -> { availability, viewerId }
//   GET  library-agents?project=          -> { agents: CloudLibraryAgent[] }
//   GET  agents/<id>/heartbeat            -> { heartbeat: string | null }
//   POST credential/alert                 { monthlyAlertUsd: number | null } -> { credential }
//
// A run started here is a manual run: only the fields a person sets are kept.
// `runs/<id>/delivered` belongs to the OSS watcher and is not served here.

import { routeCloudAgentsRequest, type CloudAgentsCliResult } from "./cli";
import { cloudError } from "./errors";
import {
  cloudAgentsAvailability,
  getCloudAgentHeartbeat,
  listDeployableLibraryAgents,
  setCloudMonthlyAlert,
  type CloudContext,
} from "./service";

export const CLOUD_AGENTS_CONSOLE_MAX_BODY_BYTES = 256 * 1024;

const RUN_START_FIELDS = ["project", "agent", "prompt", "budgetUsd", "repositories", "idempotencyKey"] as const;

export async function routeCloudAgentsConsoleRequest(
  ctx: CloudContext,
  method: string,
  segments: readonly string[],
  body: unknown,
  query: URLSearchParams,
): Promise<CloudAgentsCliResult> {
  const json = (payload: unknown, status = 200): CloudAgentsCliResult => ({ kind: "json", status, payload });
  const [group, id, action, ...rest] = segments;
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  if (method === "GET" && group === "availability" && !id) {
    return json({ availability: await cloudAgentsAvailability(ctx), viewerId: ctx.workspace.user.id });
  }
  if (method === "GET" && group === "library-agents" && !id) {
    return json(await listDeployableLibraryAgents(ctx, query.get("project")?.trim() || null));
  }
  if (method === "GET" && group === "agents" && id && action === "heartbeat" && rest.length === 0) {
    return json(await getCloudAgentHeartbeat(ctx, id));
  }
  if (method === "POST" && group === "credential" && id === "alert" && !action) {
    const value = record.monthlyAlertUsd;
    if (value !== null && typeof value !== "number") throw cloudError("validation_failed", "Send { monthlyAlertUsd: number | null }.");
    return json({ credential: await setCloudMonthlyAlert(ctx, value) });
  }
  if (group === "runs" && id && action === "delivered") throw cloudError("not_found", "Unknown cloud agents route.");
  if (method === "POST" && group === "runs" && !id) {
    const start: Record<string, unknown> = { trigger: "manual" };
    for (const field of RUN_START_FIELDS) if (record[field] !== undefined) start[field] = record[field];
    return routeCloudAgentsRequest(ctx, method, segments, start, query);
  }
  return routeCloudAgentsRequest(ctx, method, segments, body, query);
}
