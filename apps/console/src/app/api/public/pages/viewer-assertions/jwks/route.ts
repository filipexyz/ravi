import { NextResponse } from "next/server";

import { ConsoleApiError } from "@/server/console/api-error";
import { viewerAssertionJwks } from "@/server/console/pages/viewer-assertions/jwt";

export const runtime = "nodejs";

export async function GET() {
  try {
    const jwks = await viewerAssertionJwks();
    return NextResponse.json(jwks, {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
      },
    });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, {
        status: error.status,
        headers: { "cache-control": "no-store" },
      });
    }
    console.error("Pages viewer assertion JWKS is unavailable");
    return NextResponse.json(
      { error: "viewer_assertion_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
