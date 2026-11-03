const UNAUTHENTICATED_PATHS = ["/login", "/sign-in", "/sign-up", "/callback", "/callback/fleet", "/callback/setup", "/setup", "/api/setup/start", "/logout"] as const;

export function isPublicAuthPath(pathname: string) {
  return (
    UNAUTHENTICATED_PATHS.includes(pathname as (typeof UNAUTHENTICATED_PATHS)[number]) ||
    isCliApiPath(pathname) ||
    pathname === "/api/fleet/associations/start" ||
    pathname === "/api/fleet/associations/poll" ||
    isInternalWorkerApiPath(pathname) ||
    isAdminApiPath(pathname) ||
    // Vercel Workflow's generated routes, invoked by Vercel's queue, not by browsers.
    pathname.startsWith("/.well-known/workflow/")
  );
}

function isCliApiPath(pathname: string) {
  return pathname === "/api/cli" || pathname.startsWith("/api/cli/");
}

function isInternalWorkerApiPath(pathname: string) {
  return (
    // Dedicated ES256 service proofs are mandatory inside these handlers.
    pathname === "/api/executor/identity/resolve" ||
    pathname === "/api/executor/operations/execute" ||
    pathname === "/api/pages/auth/optional" ||
    pathname === "/api/public/pages/viewer-assertions/jwks" ||
    pathname === "/api/internal/pages/resolve" ||
    pathname === "/api/internal/pages/auth/claim" ||
    pathname === "/api/internal/pages/operator/comments" ||
    pathname === "/api/internal/pages/operator/password" ||
    pathname === "/api/internal/pages/operator/releases" ||
    pathname === "/api/internal/pages/operator/visibility" ||
    pathname === "/api/internal/pages/connectors/catalog" ||
    pathname === "/api/internal/pages/connectors/exec" ||
    pathname === "/api/internal/pages/password/verify" ||
    pathname === "/api/internal/pages/chat/session" ||
    pathname === "/api/internal/pages/chat/close" ||
    // Text chat rooms: the Pages Worker calls these with the Pages control token.
    pathname.startsWith("/api/internal/pages/chat/rooms/") ||
    // Console mode of mcp.ravi.so: HMAC-signed by the MCP Worker.
    pathname === "/api/internal/mcp/console/tools/list" ||
    pathname === "/api/internal/mcp/console/tools/call" ||
    pathname === "/api/internal/mail/routes/resolve" ||
    pathname === "/api/internal/mail/messages/ingest" ||
    pathname === "/api/internal/runtime" ||
    pathname.startsWith("/api/internal/runtime/") ||
    pathname === "/api/internal/event-plane" ||
    pathname.startsWith("/api/internal/event-plane/") ||
    pathname === "/api/internal/watches/github/webhook" ||
    pathname === "/api/internal/meetings/recall/webhook" ||
    pathname === "/api/internal/billing/asaas/webhook" ||
    pathname === "/api/internal/usage/events"
  );
}

function isAdminApiPath(pathname: string) {
  return pathname === "/api/internal/admin" || pathname.startsWith("/api/internal/admin/");
}
