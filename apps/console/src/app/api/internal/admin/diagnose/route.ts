import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { authorizeAdminRequest, getAdminToken } from "@/server/admin/auth";
import { diagnoseUser } from "@/server/admin/diagnose";
import { db, schema } from "@/server/db";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  const token = getAdminToken();
  if (!token) {
    console.error("Admin diagnose endpoint missing RAVI_ADMIN_TOKEN", { requestId });
    return NextResponse.json(
      { status: "error", code: "admin_token_not_configured" },
      { status: 503, headers: { "x-request-id": requestId } },
    );
  }

  if (!authorizeAdminRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "admin-diagnose-unauthorized"), limit: 10, windowMs: 60_000 })) {
      return NextResponse.json(
        { status: "error", code: "rate_limited" },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }
    return NextResponse.json(
      { status: "error", code: "unauthorized" },
      { status: 401, headers: { "x-request-id": requestId } },
    );
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email")?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json(
      { status: "error", code: "invalid_email" },
      { status: 400, headers: { "x-request-id": requestId } },
    );
  }

  try {
    const result = await diagnoseUser({ email });

    await db.insert(schema.auditEvents).values({
      organizationId: result.user
        ? result.memberships[0]?.organizationId ?? null
        : null,
      actorType: "system",
      actorId: null,
      targetType: "user",
      targetId: result.user?.id ?? null,
      action: "admin.diagnose",
      requestId,
      metadataJson: {
        emailHash: hashEmail(email),
        membershipCount: result.memberships.length,
        identityCount: result.identities.length,
        organizationLinkCount: result.organizationLinks.length,
      },
    });

    return NextResponse.json(
      { status: "ok", requestId, result },
      {
        headers: {
          "cache-control": "no-store",
          "x-request-id": requestId,
        },
      },
    );
  } catch (error) {
    console.error("Admin diagnose failed", { error, requestId });
    return NextResponse.json(
      { status: "error", code: "diagnose_failed" },
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
}

function hashEmail(email: string): string {
  // Light fingerprint so the audit row is non-PII at rest while still letting
  // operators correlate calls with the same target across audit entries.
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return `email_${(hash >>> 0).toString(16)}`;
}
