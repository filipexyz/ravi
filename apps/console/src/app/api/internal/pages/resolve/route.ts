import { after, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import {
  authorizePagesResolveRequest,
  getPagesResolveControlToken,
  resolvePagesRoute,
  type PagesRouteResolveRequest,
  type PagesRouteResolveResponse,
} from "@/server/console/pages/resolve";
import { repairActiveSiteEdgeManifest, type EdgeManifestRepairReason } from "@/server/console/pages/publish";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

const EDGE_REPAIR_REASONS = new Set<EdgeManifestRepairReason>([
  "manifest_missing",
  "manifest_unreadable",
  "manifest_invalid",
  "manifest_not_ready",
  "site_not_active",
  "host_mismatch",
  "active_release_mismatch",
  "route_miss",
  "reserved_asset_route_miss",
  "reserved_asset_file_miss",
  "file_miss",
]);

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Ravi Pages resolve endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return NextResponse.json(
      {
        status: "error",
        code: "control_token_not_configured",
      },
      { status: 503 },
    );
  }

  if (!authorizePagesResolveRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-resolve-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return NextResponse.json(
        {
          status: "error",
          code: "rate_limited",
        },
        { status: 429 },
      );
    }

    return NextResponse.json(
      {
        status: "error",
        code: "unauthorized",
      },
      { status: 401 },
    );
  }

  let input: PagesRouteResolveRequest;

  try {
    input = (await request.json()) as PagesRouteResolveRequest;
  } catch {
    return NextResponse.json(
      {
        status: "error",
        code: "invalid_json",
      },
      { status: 400 },
    );
  }

  try {
    const payload = await resolvePagesRoute({ input: { ...input, requestId } });
    scheduleEdgeManifestRepairAfterPublicFallback({
      payload,
      reason: edgeRepairReasonFromRequest(request),
      requestId,
    });
    return NextResponse.json(payload, { headers: { "x-request-id": requestId } });
  } catch (error) {
    console.error("Ravi Pages route resolution failed", {
      error,
      host: input.host,
      path: input.path,
      requestId,
    });

    return NextResponse.json({
      status: "error",
      httpStatus: 503,
      code: "control_plane_error",
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}

function scheduleEdgeManifestRepairAfterPublicFallback({
  payload,
  reason,
  requestId,
}: {
  payload: PagesRouteResolveResponse;
  reason: EdgeManifestRepairReason | null;
  requestId: string;
}) {
  if (!reason || !isPublicResolveOk(payload)) return;
  try {
    after(() => repairEdgeManifestAfterPublicFallback({ payload, reason, requestId }));
  } catch {
    void repairEdgeManifestAfterPublicFallback({ payload, reason, requestId });
  }
}

async function repairEdgeManifestAfterPublicFallback({
  payload,
  reason,
  requestId,
}: {
  payload: Extract<PagesRouteResolveResponse, { status: "ok" }>;
  reason: EdgeManifestRepairReason;
  requestId: string;
}) {
  try {
    await repairActiveSiteEdgeManifest({
      organizationId: payload.site.organizationId,
      reason,
      requestId,
      siteRef: payload.site.id,
    });
  } catch (error) {
    console.error("Ravi Pages edge manifest repair after fallback failed", {
      error,
      reason,
      requestId,
      siteId: payload.site.id,
    });
  }
}

function edgeRepairReasonFromRequest(request: Request): EdgeManifestRepairReason | null {
  if (request.headers.get("x-ravi-pages-edge-resolve") !== "fallback") return null;
  const reason = request.headers.get("x-ravi-pages-edge-miss-reason");
  return reason && EDGE_REPAIR_REASONS.has(reason as EdgeManifestRepairReason)
    ? (reason as EdgeManifestRepairReason)
    : null;
}

function isPublicResolveOk(payload: PagesRouteResolveResponse): payload is Extract<PagesRouteResolveResponse, { status: "ok" }> {
  return (
    payload.status === "ok" &&
    payload.site.visibility === "public" &&
    payload.route.visibility === "public" &&
    payload.object.cache !== "private" &&
    payload.object.cache !== "no-store"
  );
}
