import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { basesCallerFromConsoleWorkspace, handleBasesRequest } from "@/server/console/bases";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
} from "@/server/console/workspace";
import { requestOrganizationRef } from "@/server/console/request-workspace";
import { BASES_LIMITS } from "@/shared/bases/limits";

type RouteContext = {
  params: Promise<{ projectRef: string; segments?: string[] }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

export function PATCH(request: NextRequest, context: RouteContext) {
  return handle(request, context, "PATCH");
}

type BodyResult = { ok: true; body: unknown } | { ok: false; response: NextResponse };

async function readBody(request: NextRequest): Promise<BodyResult> {
  const tooLarge = () => ({ ok: false as const, response: NextResponse.json({ error: "payload_too_large" }, { status: 413 }) });
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > BASES_LIMITS.requestBodyBytes) return tooLarge();
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "invalid_json" }, { status: 400 }) };
  }
  if (new TextEncoder().encode(raw).byteLength > BASES_LIMITS.requestBodyBytes) return tooLarge();
  if (!raw.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "invalid_json" }, { status: 400 }) };
  }
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST" | "PATCH") {
  const { projectRef, segments = [] } = await context.params;
  const auth = await getConsoleApiAuthState();
  if (!auth) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  let body: unknown = {};
  if (method !== "GET") {
    const read = await readBody(request);
    if (!read.ok) return read.response;
    body = read.body;
  }

  try {
    const workspace = await getConsoleWorkspace(auth, {
      organizationRef: requestOrganizationRef(request),
    });
    await assertConsoleFeatureAccess(workspace, "console.bases");
    const result = await handleBasesRequest({
      caller: basesCallerFromConsoleWorkspace(workspace, requestId),
      workspace: { user: { id: workspace.user.id }, organization: { id: workspace.organization.id }, membership: { role: workspace.membership.role } },
      method,
      projectRef,
      segments,
      body,
      searchParams: request.nextUrl.searchParams,
      idempotencyKey: request.headers.get("idempotency-key"),
    });
    return NextResponse.json(serializeBasesPayload(result.payload), { status: result.status });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }

    const eventId = await captureConsoleApiException(error, {
      tags: {
        feature: "console-bases",
        operation: method === "GET" ? "read" : "mutation",
        surface: "console",
      },
      contexts: {
        consoleApi: {
          method: request.method,
          path: request.nextUrl.pathname,
          requestId,
          segments,
        },
      },
    });
    console.error("Console bases request failed", { error, requestId, segments });
    return NextResponse.json({ error: "internal_error", eventId }, { status: 500 });
  }
}

function serializeBasesPayload(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeBasesPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeBasesPayload(item)]));
  }
  return value;
}

async function captureConsoleApiException(error: unknown, context: Parameters<typeof Sentry.captureException>[1]) {
  ensureSentryServerClient();
  const eventId = Sentry.captureException(error, context);
  await Sentry.flush(2000);
  return eventId;
}

function ensureSentryServerClient() {
  if (Sentry.getClient()) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    enableLogs: true,
  });
}
