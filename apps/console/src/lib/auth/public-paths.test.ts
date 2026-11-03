import { describe, expect, test } from "bun:test";

import { isPublicAuthPath } from "./public-paths";

describe("public auth paths", () => {
  test("exempts only the two signed Executor callbacks from browser auth", () => {
    expect(isPublicAuthPath("/api/executor/identity/resolve")).toBe(true);
    expect(isPublicAuthPath("/api/executor/operations/execute")).toBe(true);
    expect(isPublicAuthPath("/api/executor/identity/resolve/extra")).toBe(false);
    expect(isPublicAuthPath("/api/executor/admin")).toBe(false);
  });
  test("keeps browser auth routes public", () => {
    expect(isPublicAuthPath("/login")).toBe(true);
    expect(isPublicAuthPath("/callback")).toBe(true);
  });

  test("keeps CLI API routes outside browser auth redirects", () => {
    expect(isPublicAuthPath("/api/cli/auth/config")).toBe(true);
    expect(isPublicAuthPath("/api/cli/me")).toBe(true);
    expect(isPublicAuthPath("/api/cli/link")).toBe(true);
    expect(isPublicAuthPath("/api/cli/link/unlink")).toBe(true);
  });

  test("keeps the Pages Worker endpoints outside browser auth redirects", () => {
    expect(isPublicAuthPath("/api/pages/auth/optional")).toBe(true);
    expect(isPublicAuthPath("/api/public/pages/viewer-assertions/jwks")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/resolve")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/auth/claim")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/operator/comments")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/operator/password")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/operator/releases")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/operator/visibility")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/connectors/catalog")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/connectors/exec")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/password/verify")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/chat/session")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/chat/close")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/chat/rooms/open")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/chat/rooms/messages/send")).toBe(true);
    expect(isPublicAuthPath("/api/internal/pages/chat/rooms")).toBe(false);
    expect(isPublicAuthPath("/api/internal/mcp/console/tools/list")).toBe(true);
    expect(isPublicAuthPath("/api/internal/mcp/console/tools/call")).toBe(true);
    expect(isPublicAuthPath("/api/internal/mcp/bridges/list")).toBe(false);
    expect(isPublicAuthPath("/.well-known/workflow/v1/flow")).toBe(true);
    expect(isPublicAuthPath("/api/internal/usage/events")).toBe(true);
  });

  test("keeps the Mail Worker endpoints outside browser auth redirects", () => {
    expect(isPublicAuthPath("/api/internal/mail/routes/resolve")).toBe(true);
    expect(isPublicAuthPath("/api/internal/mail/messages/ingest")).toBe(true);
  });

  test("keeps the Event Plane control endpoint outside browser auth redirects", () => {
    expect(isPublicAuthPath("/api/internal/event-plane")).toBe(true);
    expect(isPublicAuthPath("/api/internal/event-plane/desired-state")).toBe(true);
    expect(isPublicAuthPath("/api/internal/event-plane/cells/register")).toBe(true);
  });

  test("keeps runtime-control endpoints outside browser auth redirects", () => {
    expect(isPublicAuthPath("/api/internal/runtime")).toBe(true);
    expect(isPublicAuthPath("/api/internal/runtime/operations/claim")).toBe(true);
    expect(isPublicAuthPath("/api/internal/runtime/operations/report")).toBe(true);
    expect(isPublicAuthPath("/api/internal/runtime/bootstrap/issue")).toBe(true);
  });

  test("keeps the GitHub watch webhook outside browser auth redirects", () => {
    expect(isPublicAuthPath("/api/internal/watches/github/webhook")).toBe(true);
  });

  test("keeps the payment webhook outside browser auth redirects", () => {
    expect(isPublicAuthPath("/api/internal/billing/asaas/webhook")).toBe(true);
    expect(isPublicAuthPath("/api/console/billing")).toBe(false);
  });

  test("keeps the admin namespace outside browser auth redirects", () => {
    expect(isPublicAuthPath("/api/internal/admin")).toBe(true);
    expect(isPublicAuthPath("/api/internal/admin/diagnose")).toBe(true);
    expect(isPublicAuthPath("/api/internal/admin/memberships/link")).toBe(true);
  });

  test("does not expose console APIs through the auth proxy", () => {
    expect(isPublicAuthPath("/api/console/projects")).toBe(false);
    expect(isPublicAuthPath("/api/pages/auth/start")).toBe(false);
    expect(isPublicAuthPath("/api/internal/pages/other")).toBe(false);
    expect(isPublicAuthPath("/api/internal/mail/other")).toBe(false);
    expect(isPublicAuthPath("/api/internal/runtime-other")).toBe(false);
    expect(isPublicAuthPath("/api/internal/events")).toBe(false);
    expect(isPublicAuthPath("/api/internal/watches/github/other")).toBe(false);
    expect(isPublicAuthPath("/api/internal/usage/other")).toBe(false);
    expect(isPublicAuthPath("/projects")).toBe(false);
  });
});
