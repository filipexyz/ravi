/**
 * POST /api/internal/connectors/step-up/mint
 *
 * Called by the Console step-up page. Requires a real WorkOS factor
 * verification (v1: password reauth) before forwarding the mint
 * request to the connectors Worker over HMAC.
 *
 * Plaintext password reaches this handler from the browser, is sent
 * once to WorkOS for verification, and is dropped. The plaintext
 * step-up token returned by the Worker is included verbatim in the
 * JSON response so the user can paste it into the CLI, then forgotten.
 */

import { createHmac, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getConsoleAuthState } from "@/lib/auth/session";
import { assertInternalConsoleFeature } from "@/server/console/internal-feature-api";
import { isTrustedConsolePost } from "@/server/console/ravi-link-web";
import { getInternalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import {
  getLinkHmacConfig,
  LinkHmacError,
  linkHmacRequest,
} from "@/server/connectors/link-hmac-client";
import { verifyPasswordReauth } from "@/server/connectors/workos-stepup";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    challengeId: z.string().min(1).max(200),
    factor: z.enum(["passkey", "totp", "sms", "password"]),
    password: z.string().min(1).max(512).optional(),
  })
  .refine((data) => data.factor !== "password" || (data.password && data.password.length > 0), {
    message: "password required when factor=password",
    path: ["password"],
  });

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  if (!isTrustedConsolePost(request)) {
    return jsonError(403, "forbidden", requestId);
  }
  const authState = await getConsoleAuthState();
  if (!authState) {
    return jsonError(401, "connector_unauthorized", requestId);
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return jsonError(400, "payload_invalid", requestId);
  }

  const workspace = await getInternalSelectedConsoleWorkspace(authState, requestId);
  if (workspace instanceof NextResponse) return workspace;
  const featureError = await assertInternalConsoleFeature(workspace, "console.connectors", requestId);
  if (featureError) return featureError;

  // v1: only password factor is wired up. TOTP/passkey land in a
  // follow-up change and plug into the same StepUpVerificationResult
  // contract.
  if (parsed.factor !== "password") {
    return jsonError(400, "factor_not_supported", requestId);
  }

  const verification = await verifyPasswordReauth({
    email: workspace.user.primaryEmail,
    password: parsed.password!,
  });
  if (!verification.verified) {
    if (verification.rejectionReason === "workos_not_configured") {
      return jsonError(503, "server_not_configured", requestId);
    }
    if (verification.rejectionReason === "workos_unavailable") {
      return jsonError(502, "workos_unavailable", requestId);
    }
    return jsonError(401, "factor_verification_failed", requestId);
  }

  const hmac = getLinkHmacConfig();
  if (!hmac) {
    console.error("RAVI_CONNECTORS HMAC keys not configured", { requestId });
    return jsonError(503, "server_not_configured", requestId);
  }

  const consoleAssertionToken = buildAssertionToken({
    challengeId: parsed.challengeId,
    userId: workspace.user.id,
    organizationId: workspace.organization.id,
    factor: verification.factor!,
    hmacSecret: hmac.key,
  });

  try {
    const result = await linkHmacRequest<{ token: string; expiresAt: string; factor: string }>(hmac, {
      method: "POST",
      path: "/ui/stepup/mint",
      body: {
        challengeId: parsed.challengeId,
        userId: workspace.user.id,
        organizationId: workspace.organization.id,
        providerResponse: {
          factor: verification.factor,
          consoleAssertionToken,
        },
      },
    });
    return NextResponse.json(
      { status: "ok", token: result.token, expiresAt: result.expiresAt, factor: result.factor },
      { status: 200, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    if (error instanceof LinkHmacError) {
      console.error("connector step-up mint failed", {
        requestId,
        status: error.status,
        code: error.code,
      });
      return jsonError(error.status >= 500 ? 502 : error.status, error.code, requestId);
    }
    console.error("connector step-up mint unexpected error", {
      requestId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return jsonError(500, "internal_error", requestId);
  }
}

/**
 * Build a short HMAC-signed assertion the Worker can use to confirm that
 * Console verified the factor before requesting a mint. Worker keeps the
 * factor itself; this token is opaque to the CLI.
 */
function buildAssertionToken(input: {
  challengeId: string;
  userId: string;
  organizationId: string;
  factor: string;
  hmacSecret: string;
}): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = [input.challengeId, input.userId, input.organizationId, input.factor, issuedAt].join(":");
  const signature = createHmac("sha256", input.hmacSecret).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

function jsonError(status: number, code: string, requestId: string): NextResponse {
  return NextResponse.json(
    { status: "error", code },
    { status, headers: { "x-request-id": requestId } },
  );
}
