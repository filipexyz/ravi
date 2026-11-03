import { fleetBrowserActor as actor } from "@/server/console/fleet/browser-actor";
import { NextRequest, NextResponse } from "next/server";
import { getConsoleApiAuthState } from "@/lib/auth/session";
import { getOidcOrigin } from "@/lib/auth/oidc-config";
import { ConsoleWorkspaceSelectionRequiredError } from "@/server/console/workspace";
import { FleetError } from "@/server/console/fleet/contract";
import { fleetService, fleetSsoService, onboardingService, organizationAccess, organizationMembersService, apiKeysService } from "@/server/console/fleet/runtime";
import { hashBrowserSessionToken, OIDC_SESSION_COOKIE, oidcCookieOptions } from "@/lib/auth/oidc-transaction";
import { SSO_TEST_COOKIE } from "@/server/console/fleet/sso-service";
import { ConsoleApiError } from "@/server/console/api-error";
import { gatewayOptions, gatewayAuthority } from "@/server/console/fleet/gateway-authority";
import { gatewayRequest, gatewayStream } from "@/server/console/fleet/gateway";

export const runtime = "nodejs";
type Context = { params: Promise<{ segments?: string[] }> };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status,
  headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });

function failure(error: unknown) {
  if (error instanceof FleetError) return json({ error: error.code }, error.status);
  if (error instanceof ConsoleApiError) return json({ error: error.payload.error }, error.status);
  if (error instanceof ConsoleWorkspaceSelectionRequiredError) return json({ error: "forbidden" }, 403);
  // Intentionally no raw exception/body telemetry on a secret-handling endpoint.
  return json({ error: "fleet_unavailable" }, 503);
}
export async function GET(request: NextRequest, context: Context) {
  try {
    const identity = await actor(request);
    if ((await context.params).segments?.join("/") === "desktop/people") {
      const installationId = request.nextUrl.searchParams.get("installationId") ?? "", projectId = request.nextUrl.searchParams.get("projectId") ?? "";
      if (![installationId,projectId].every((id)=>/^[0-9a-f-]{36}$/.test(id))) throw new FleetError("invalid_request");
      const state = await gatewayAuthority(identity,installationId,projectId,"directory");
      return json({people:state.people});
    }
    if ((await context.params).segments?.join("/") === "desktop/bootstrap") {
      const auth = await getConsoleApiAuthState();
      if (auth?.mode !== "oidc" || auth.oidc?.userId !== identity.userId) throw new FleetError("auth_required", 401);
      return json({ ...await gatewayOptions(identity), organizationId: identity.organizationId, viewer: auth.viewer });
    }

    if ((await context.params).segments?.join("/") === "gateway/stream") return await gatewayStream(identity,request.nextUrl,request.signal,request.headers.get("last-event-id"));
    if ((await context.params).segments?.join("/") === "gateway/options") return json(await gatewayOptions(identity));
    if ((await context.params).segments?.join("/") === "api-keys") return json(await apiKeysService().list(identity));
    if ((await context.params).segments?.join("/") === "members") return json(await organizationMembersService().list(identity));
    if ((await context.params).segments?.join("/") === "access") return json(await organizationAccess(identity));
    if ((await context.params).segments?.join("/") === "onboarding") return json(await onboardingService().state(identity));
    if ((await context.params).segments?.join("/") === "sso") return json(await fleetSsoService().state(identity, sessionHash(request)));
    if ((await context.params).segments?.join("/") === "credentials") return json(await fleetService().credentials(identity));
    if ((await context.params).segments?.join("/") === "installations") return json(await fleetService().installations(identity));
    if ((await context.params).segments?.length) return json({ error: "not_found" }, 404);
    return json(await fleetService().state(identity));
  } catch (error) { return failure(error); }
}
function sessionHash(request: NextRequest) {
  return hashBrowserSessionToken(request.cookies.get(OIDC_SESSION_COOKIE)?.value ?? "") ?? "";
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const identity = await actor(request);
    if (request.headers.get("origin") !== getOidcOrigin() || request.headers.get("content-type")?.split(";")[0] !== "application/json") {
      throw new FleetError("forbidden", 403);
    }
    const reader = request.body?.getReader();
    if (!reader) throw new FleetError("invalid_request");
    const parts: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > 65_536) throw new FleetError("request_too_large", 413); parts.push(part.value);
    } } finally { await reader.cancel().catch(() => {}); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new FleetError("invalid_json"); }
    const path = ((await context.params).segments ?? []).join("/");
    if (path === "gateway/request") return await gatewayRequest(identity, body, request.signal);
    if (path === "api-keys/issue") return json(await apiKeysService().issue(identity, body));
    if (path === "api-keys/classify") return json(await apiKeysService().classify(identity, body));
    if (path === "api-keys/rotate") return json(await apiKeysService().rotate(identity, body));
    if (path === "api-keys/revoke") return json(await apiKeysService().revoke(identity, body));
    if (path === "api-keys/services/create") return json(await apiKeysService().createService(identity, body));
    if (path === "api-keys/services/revoke") return json(await apiKeysService().revokeService(identity, body));
    if (path === "members/status") return json(await organizationMembersService().change(identity, body));
    if (path === "onboarding/finish") return json(await onboardingService().finish(identity, body));
    if (path === "sso/save") return json(await fleetSsoService().save(identity, sessionHash(request), body));
    if (path === "sso/activate") return json(await fleetSsoService().activate(identity, sessionHash(request), body));
    if (path === "sso/test") {
      const result = await fleetSsoService().beginTest(identity, sessionHash(request), body);
      const response = json({ url: result.url });
      response.cookies.set(SSO_TEST_COOKIE, result.cookie, { ...oidcCookieOptions, maxAge: 300 });
      return response;
    }
    if (!["credentials/save", "credentials/revoke", "installations/save", "installations/test", "installations/activate"].includes(path)) {
      return json({ error: "not_found" }, 404);
    }
    const service = fleetService();
    if (path === "credentials/save") return json(await service.writeCredential(identity, body));
    if (path === "credentials/revoke") return json(await service.revokeCredential(identity, body));
    if (path === "installations/save") return json(await service.writeInstallation(identity, body));
    if (path === "installations/test") return json(await service.testInstallation(identity, body));
    if (path === "installations/activate") return json(await service.activateInstallation(identity, body));
    return json({ error: "not_found" }, 404);
  } catch (error) { return failure(error); }
}
