import { NextRequest, NextResponse } from "next/server";
import { getOidcOrigin, oidcModeEnabled } from "@/lib/auth/oidc-config";
import { getRuntimeOidcConfig } from "@/lib/auth/oidc-runtime";
import { oidcCookieOptions } from "@/lib/auth/oidc-transaction";
import { BootstrapService, SETUP_COOKIE } from "@/server/console/fleet/bootstrap";
import { dbClient } from "@/server/db";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  try {
    if (!oidcModeEnabled() || request.headers.get("origin") !== getOidcOrigin() || request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error();
    const reader = request.body?.getReader(); if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 2048) throw new Error(); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await new BootstrapService(dbClient, await getRuntimeOidcConfig()).begin(body);
    const response = NextResponse.json({ url: result.url }, { headers });
    response.cookies.set(SETUP_COOKIE, result.cookie, { ...oidcCookieOptions, maxAge: 300 });
    return response;
  } catch { return NextResponse.json({ error: "setup_unavailable" }, { status: 403, headers }); }
}
