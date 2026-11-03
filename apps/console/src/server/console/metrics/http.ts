import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { adminJson, adminRequestId, gateAdminRequest } from "@/server/admin/http";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

import { computeDailyMetrics, computePeopleUsage, localDay, parseExcludedOrgIds, shiftDay } from "./compute";
import { renderMetricsDashboard, METRICS_DASHBOARD_USES } from "./dashboard";
import { ensureMetricsSetup, MetricsConfigError, resolveMetricsProject, syncUsageMetrics } from "./sync";

// Admin routes of the usage metrics:
// - GET  /api/internal/admin/metrics            numbers computed now (admin token), no writes
// - GET  /api/internal/admin/metrics/tick       Vercel cron (CRON_SECRET): writes the Bases
// - POST /api/internal/admin/metrics/tick       same, with the admin token
// - GET  /api/internal/admin/metrics/dashboard  the data page HTML with the view ids

export type MetricsEnv = {
  project?: string;
  excludeOrgIds?: string;
  cronSecret?: string;
};

function envFromProcess(): MetricsEnv {
  return {
    project: process.env.RAVI_METRICS_PROJECT,
    excludeOrgIds: process.env.RAVI_METRICS_EXCLUDE_ORG_IDS,
    cronSecret: process.env.CRON_SECRET,
  };
}

export async function handleMetricsSummaryHttp(request: Request, env: MetricsEnv = envFromProcess()): Promise<Response> {
  const gate = gateAdminRequest(request, { rateLimitName: "admin-metrics", missingTokenLog: "admin_metrics_token_missing" });
  if (!gate.ok) return gate.response;
  const requestId = gate.requestId;
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isInteger(requested) && requested >= 1 && requested <= 120 ? requested : 30;
  try {
    const now = new Date();
    const today = localDay(now);
    const excludeOrgIds = parseExcludedOrgIds(env.excludeOrgIds);
    const [daily, people] = await Promise.all([
      computeDailyMetrics({ fromDay: shiftDay(today, -(days - 1)), toDay: today, excludeOrgIds }),
      computePeopleUsage({ now, excludeOrgIds }),
    ]);
    const outside = people.filter((person) => !person.staff);
    return adminJson(
      {
        status: "ok",
        requestId,
        result: {
          asOf: now.toISOString(),
          today: daily.at(-1) ?? null,
          people: {
            active7d: outside.filter((person) => person.active7d).length,
            active30d: outside.filter((person) => Date.parse(person.lastActiveAt) >= now.getTime() - 30 * 86_400_000).length,
            pagesPublishers30d: outside.filter((person) => person.publishes30d > 0).length,
            pagesReaders30d: outside.filter((person) => person.pageOpens30d > 0).length,
            list: people,
          },
          daily,
        },
      },
      200,
      requestId,
    );
  } catch (error) {
    console.error("admin_metrics_failed", { requestId, name: error instanceof Error ? error.name : "unknown" });
    return adminJson({ status: "error", code: "metrics_failed", requestId }, 500, requestId);
  }
}

export async function handleMetricsTickHttp(request: Request, env: MetricsEnv = envFromProcess()): Promise<Response> {
  let requestId: string;
  const cron = request.method === "GET";
  if (cron) {
    requestId = adminRequestId(request);
    const secret = env.cronSecret?.trim();
    if (!secret) {
      console.error("metrics_tick_cron_secret_missing", { requestId });
      return adminJson({ status: "error", code: "cron_secret_not_configured", requestId }, 503, requestId);
    }
    if (!bearerMatches(request, secret)) {
      if (isRateLimited({ key: rateLimitKey(request, "metrics-tick"), limit: 10, windowMs: 60_000 })) {
        return adminJson({ status: "error", code: "rate_limited", requestId }, 429, requestId);
      }
      return adminJson({ status: "error", code: "unauthorized", requestId }, 401, requestId);
    }
  } else {
    const gate = gateAdminRequest(request, { rateLimitName: "metrics-tick", missingTokenLog: "metrics_tick_admin_token_missing" });
    if (!gate.ok) return gate.response;
    requestId = gate.requestId;
  }

  try {
    const project = await resolveMetricsProject(env.project);
    const result = await syncUsageMetrics({ project, now: new Date(), requestId, excludeOrgIds: parseExcludedOrgIds(env.excludeOrgIds) });
    return adminJson({ status: "ok", requestId, result }, 200, requestId);
  } catch (error) {
    if (error instanceof MetricsConfigError) {
      // An unconfigured install is not a cron failure.
      if (cron && error.code === "metrics_project_not_configured") return adminJson({ status: "skipped", code: error.code, requestId }, 200, requestId);
      return adminJson({ status: "error", code: error.code, requestId }, 409, requestId);
    }
    console.error("metrics_tick_failed", {
      requestId,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : "unknown",
    });
    return adminJson({ status: "error", code: "metrics_tick_failed", requestId }, 500, requestId);
  }
}

export async function handleMetricsDashboardHttp(request: Request, env: MetricsEnv = envFromProcess()): Promise<Response> {
  const gate = gateAdminRequest(request, { rateLimitName: "admin-metrics-dashboard", missingTokenLog: "admin_metrics_token_missing" });
  if (!gate.ok) return gate.response;
  const requestId = gate.requestId;
  try {
    const project = await resolveMetricsProject(env.project);
    const setup = await ensureMetricsSetup({ project, requestId });
    if (!setup.siteId) {
      // The views can only admit a site that exists: ship any page to the project first.
      return adminJson({ status: "error", code: "metrics_site_missing", requestId }, 409, requestId);
    }
    const html = renderMetricsDashboard({ daysViewId: setup.daysViewId, peopleViewId: setup.peopleViewId });
    return new NextResponse(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": requestId,
        "x-ravi-pages-uses": METRICS_DASHBOARD_USES.join(","),
      },
    });
  } catch (error) {
    if (error instanceof MetricsConfigError) return adminJson({ status: "error", code: error.code, requestId }, 409, requestId);
    console.error("admin_metrics_dashboard_failed", { requestId, name: error instanceof Error ? error.name : "unknown" });
    return adminJson({ status: "error", code: "metrics_dashboard_failed", requestId }, 500, requestId);
  }
}

function bearerMatches(request: Request, secret: string): boolean {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) return false;
  const given = Buffer.from(bearer);
  const expected = Buffer.from(secret);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
