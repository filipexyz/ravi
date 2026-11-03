// Bases HTTP router shared by the Console and CLI envelopes. Implements every
// route of `src/shared/bases/api.ts`; anything else is `404 not_found`. The
// envelope authenticates, checks the `console.bases` feature, and builds the
// caller; this module resolves the project and base and calls the services.

import type { ProjectAccessWorkspace } from "@/server/console/project-access";
import { isBaseUuid } from "@/shared/bases/values";

import { listBaseActivity } from "./activity";
import { changeBaseLifecycle, createBase, getBaseDetail, listBases, updateBase } from "./bases";
import { archiveChart, chartData, createChart, getChart, listCharts, updateChart } from "./charts";
import type { BasesCaller } from "./context";
import { mapBasesInputError, notFound } from "./errors";
import { createProperty, deleteProperty, restoreProperty, updateProperty } from "./properties";
import {
  aggregateRowsDirect,
  changeRowLifecycleDirect,
  createRowsDirect,
  fillAgentDirect,
  getRowDirect,
  purgeRowDirect,
  queryRowsDirect,
  rerunAgentDirect,
  rowHistoryDirect,
  updateRowDirect,
} from "./rows";
import { resolveBaseScope, resolveBasesProject, type BaseScope, type BasesProjectScope } from "./scope";
import { createSubscription, listSubscriptions, revokeSubscription } from "./subscriptions";
import {
  archiveRowThroughView,
  archiveView,
  createRowThroughView,
  createView,
  getRowThroughView,
  getView,
  historyThroughView,
  listViews,
  queryView,
  updateRowThroughView,
  updateView,
  viewVersion,
} from "./views";

export type BasesHttpRequest = {
  caller: BasesCaller;
  /** Workspace for `findAccessibleProjectRecord`; derived from the caller when null. */
  workspace: ProjectAccessWorkspace | null;
  method: string;
  projectRef: string;
  /** Path segments relative to `.../bases`. */
  segments: readonly string[];
  body: unknown;
  searchParams: URLSearchParams;
  /** `Idempotency-Key` header. */
  idempotencyKey: string | null;
};

export type BasesHttpResult = { status: number; payload: unknown };

type Handler = (context: {
  project: BasesProjectScope;
  base: () => Promise<BaseScope>;
  params: string[];
  body: unknown;
  request: BasesHttpRequest;
}) => Promise<BasesHttpResult>;

type Route = { method: string; pattern: readonly string[]; handler: Handler };

const ok = (payload: unknown, status = 200): BasesHttpResult => ({ status, payload });

/** Pattern parts: literal, `:base` (uuid or slug), `:prop` (id or key), `:id` (uuid). */
const ROUTES: Route[] = [
  { method: "GET", pattern: [], handler: async ({ project, request }) => ok(await listBases(project, { includeArchived: flag(request, "includeArchived") })) },
  {
    method: "POST",
    pattern: [],
    handler: async ({ project, body, request }) => {
      const result = await createBase(project, body, request.idempotencyKey);
      return ok(result.payload, result.status);
    },
  },
  { method: "GET", pattern: [":base"], handler: async ({ base }) => ok(await getBaseDetail(await base())) },
  { method: "GET", pattern: [":base", "activity"], handler: async ({ base, request }) => ok(await listBaseActivity(await base(), request.searchParams)) },
  { method: "PATCH", pattern: [":base"], handler: async ({ base, body }) => ok(await updateBase(await base(), body)) },
  { method: "POST", pattern: [":base", "archive"], handler: async ({ base, body }) => ok(await changeBaseLifecycle(await base(), "archive", body)) },
  { method: "POST", pattern: [":base", "restore"], handler: async ({ base, body }) => ok(await changeBaseLifecycle(await base(), "restore", body)) },

  {
    method: "POST",
    pattern: [":base", "properties"],
    handler: async ({ base, body, request }) => ok(await createProperty(await base(), body, request.idempotencyKey)),
  },
  { method: "PATCH", pattern: [":base", "properties", ":prop"], handler: async ({ base, params, body }) => ok(await updateProperty(await base(), params[0]!, body)) },
  {
    method: "POST",
    pattern: [":base", "properties", ":prop", "delete"],
    handler: async ({ base, params, body }) => ok(await deleteProperty(await base(), params[0]!, body)),
  },
  {
    method: "POST",
    pattern: [":base", "properties", ":prop", "restore"],
    handler: async ({ base, params, body }) => ok(await restoreProperty(await base(), params[0]!, body)),
  },

  { method: "POST", pattern: [":base", "rows", "query"], handler: async ({ base, body }) => ok(await queryRowsDirect(await base(), body)) },
  { method: "POST", pattern: [":base", "rows", "aggregate"], handler: async ({ base, body }) => ok(await aggregateRowsDirect(await base(), body)) },
  {
    method: "POST",
    pattern: [":base", "rows"],
    handler: async ({ base, body, request }) => {
      const result = await createRowsDirect(await base(), body, request.idempotencyKey);
      return ok(result.payload, result.status);
    },
  },
  {
    method: "GET",
    pattern: [":base", "rows", ":id"],
    handler: async ({ base, params, request }) => ok(await getRowDirect(await base(), params[0]!, flag(request, "includeArchived"))),
  },
  {
    method: "PATCH",
    pattern: [":base", "rows", ":id"],
    handler: async ({ base, params, body, request }) => ok(await updateRowDirect(await base(), params[0]!, body, request.idempotencyKey)),
  },
  {
    method: "POST",
    pattern: [":base", "rows", ":id", "archive"],
    handler: async ({ base, params, body }) => ok(await changeRowLifecycleDirect(await base(), params[0]!, "archive", body)),
  },
  {
    method: "POST",
    pattern: [":base", "rows", ":id", "restore"],
    handler: async ({ base, params, body }) => ok(await changeRowLifecycleDirect(await base(), params[0]!, "restore", body)),
  },
  {
    method: "POST",
    pattern: [":base", "rows", ":id", "purge"],
    handler: async ({ base, params, body }) => ok(await purgeRowDirect(await base(), params[0]!, body)),
  },
  {
    method: "GET",
    pattern: [":base", "rows", ":id", "history"],
    handler: async ({ base, params, request }) => ok(await rowHistoryDirect(await base(), params[0]!, request.searchParams)),
  },
  {
    method: "POST",
    pattern: [":base", "rows", ":id", "agent", ":prop"],
    handler: async ({ base, params, body, request }) => ok(await fillAgentDirect(await base(), params[0]!, params[1]!, body, request.idempotencyKey)),
  },
  {
    method: "POST",
    pattern: [":base", "rows", ":id", "agent", ":prop", "rerun"],
    handler: async ({ base, params, body, request }) => ok(await rerunAgentDirect(await base(), params[0]!, params[1]!, body, request.idempotencyKey)),
  },

  { method: "GET", pattern: [":base", "views"], handler: async ({ base, request }) => ok(await listViews(await base(), { includeArchived: flag(request, "includeArchived") })) },
  {
    method: "POST",
    pattern: [":base", "views"],
    handler: async ({ base, body, request }) => {
      const result = await createView(await base(), body, request.idempotencyKey);
      return ok(result.payload, result.status);
    },
  },
  { method: "GET", pattern: [":base", "views", ":id"], handler: async ({ base, params }) => ok(await getView(await base(), params[0]!)) },
  { method: "PATCH", pattern: [":base", "views", ":id"], handler: async ({ base, params, body }) => ok(await updateView(await base(), params[0]!, body)) },
  { method: "POST", pattern: [":base", "views", ":id", "archive"], handler: async ({ base, params, body }) => ok(await archiveView(await base(), params[0]!, body)) },
  { method: "POST", pattern: [":base", "views", ":id", "query"], handler: async ({ base, params, body }) => ok(await queryView(await base(), params[0]!, body)) },
  { method: "POST", pattern: [":base", "views", ":id", "version"], handler: async ({ base, params, body }) => ok(await viewVersion(await base(), params[0]!, body)) },
  {
    method: "POST",
    pattern: [":base", "views", ":id", "rows"],
    handler: async ({ base, params, body, request }) => {
      const result = await createRowThroughView(await base(), params[0]!, body, request.idempotencyKey);
      return ok(result.payload, result.status);
    },
  },
  {
    method: "GET",
    pattern: [":base", "views", ":id", "rows", ":id"],
    handler: async ({ base, params, request }) =>
      ok(await getRowThroughView(await base(), params[0]!, params[1]!, { asUserId: request.searchParams.get("asUserId") ?? undefined })),
  },
  {
    method: "PATCH",
    pattern: [":base", "views", ":id", "rows", ":id"],
    handler: async ({ base, params, body, request }) =>
      ok(await updateRowThroughView(await base(), params[0]!, params[1]!, body, request.idempotencyKey)),
  },
  {
    method: "POST",
    pattern: [":base", "views", ":id", "rows", ":id", "archive"],
    handler: async ({ base, params, body }) => ok(await archiveRowThroughView(await base(), params[0]!, params[1]!, body)),
  },
  {
    method: "GET",
    pattern: [":base", "views", ":id", "rows", ":id", "history"],
    handler: async ({ base, params, request }) => ok(await historyThroughView(await base(), params[0]!, params[1]!, request.searchParams)),
  },

  { method: "GET", pattern: [":base", "charts"], handler: async ({ base, request }) => ok(await listCharts(await base(), { includeArchived: flag(request, "includeArchived") })) },
  {
    method: "POST",
    pattern: [":base", "charts"],
    handler: async ({ base, body, request }) => {
      const result = await createChart(await base(), body, request.idempotencyKey);
      return ok(result.payload, result.status);
    },
  },
  { method: "GET", pattern: [":base", "charts", ":id"], handler: async ({ base, params }) => ok(await getChart(await base(), params[0]!)) },
  { method: "PATCH", pattern: [":base", "charts", ":id"], handler: async ({ base, params, body }) => ok(await updateChart(await base(), params[0]!, body)) },
  { method: "POST", pattern: [":base", "charts", ":id", "archive"], handler: async ({ base, params, body }) => ok(await archiveChart(await base(), params[0]!, body)) },
  { method: "POST", pattern: [":base", "charts", ":id", "data"], handler: async ({ base, params, body }) => ok(await chartData(await base(), params[0]!, body)) },

  { method: "GET", pattern: [":base", "subscriptions"], handler: async ({ base }) => ok(await listSubscriptions(await base())) },
  {
    method: "POST",
    pattern: [":base", "subscriptions"],
    handler: async ({ base, body }) => {
      const result = await createSubscription(await base(), body);
      return ok(result.payload, result.status);
    },
  },
  {
    method: "POST",
    pattern: [":base", "subscriptions", ":id", "revoke"],
    handler: async ({ base, params, body }) => ok(await revokeSubscription(await base(), params[0]!, body)),
  },
];

function flag(request: BasesHttpRequest, name: string) {
  const value = request.searchParams.get(name);
  return value === "1" || value === "true";
}

export type BasesRouteMatch = { route: Route; baseRef: string | null; params: string[] };

/** Matches method and segments; `:id` segments must be uuids. */
export function matchBasesRoute(method: string, segments: readonly string[]): BasesRouteMatch | null {
  const upper = method.toUpperCase();
  for (const route of ROUTES) {
    if (route.method !== upper || route.pattern.length !== segments.length) continue;
    let baseRef: string | null = null;
    const params: string[] = [];
    let matched = true;
    for (let index = 0; index < route.pattern.length; index += 1) {
      const part = route.pattern[index]!;
      const segment = segments[index] ?? "";
      if (part === ":base") {
        if (!segment.trim()) matched = false;
        baseRef = segment;
      } else if (part === ":prop") {
        if (!segment.trim()) matched = false;
        params.push(segment);
      } else if (part === ":id") {
        if (!isBaseUuid(segment)) matched = false;
        params.push(segment.toLowerCase());
      } else if (part !== segment) {
        matched = false;
      }
      if (!matched) break;
    }
    if (matched) return { route, baseRef, params };
  }
  return null;
}

/** Removes the untrusted `clientHint` (already captured in the caller) from object bodies. */
export function stripClientHint(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("clientHint" in body)) return body;
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete rest.clientHint;
  return rest;
}

export async function handleBasesRequest(request: BasesHttpRequest): Promise<BasesHttpResult> {
  const match = matchBasesRoute(request.method, request.segments);
  if (!match) notFound();
  try {
    const project = await resolveBasesProject({ caller: request.caller, workspace: request.workspace, projectRef: request.projectRef });
    let scope: Promise<BaseScope> | null = null;
    const base = () => {
      if (match.baseRef === null) notFound();
      scope ??= resolveBaseScope(project, match.baseRef);
      return scope;
    };
    return await match.route.handler({
      project,
      base,
      params: match.params,
      body: request.method.toUpperCase() === "GET" ? {} : stripClientHint(request.body),
      request,
    });
  } catch (error) {
    throw mapBasesInputError(error);
  }
}
