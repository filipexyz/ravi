import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { ConsoleApiError } from "@/server/console/api-error";
import { ConsoleWorkspaceSelectionRequiredError } from "@/server/console/workspace";

import { handlePagesAuthStartGet } from "./route";

const TARGET = {
  host: "onb2-proto.ravi.page",
  organizationId: "org_rbbt",
  projectId: "proj_sales",
  siteId: "site_onb2",
};

const NO_GRANT = {
  createGuestClaimCode: async () => {
    throw new ConsoleApiError(403, { error: "pages_access_denied", reason: "org_forbidden" });
  },
  getUser: async () => ({ id: "user_guest" }) as never,
};

const WORKSPACE = {
  mode: "workos" as const,
  user: { id: "user_1" },
  organization: { id: "org_rbbt" },
  membership: { role: "viewer" },
};

describe("GET /api/pages/auth/start", () => {
  test("renders HTML for a browser denied because the user is not in the site org", async () => {
    const response = await handlePagesAuthStartGet(
      startRequest({ accept: "text/html", fetchMode: "navigate" }),
      {
        ...NO_GRANT,
        getAuthState: async () => ({}) as never,
        getWorkspace: async () => {
          throw new ConsoleWorkspaceSelectionRequiredError([]);
        },
        rateLimited: () => false,
        resolveTarget: async () => TARGET,
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Acesso negado");
    expect(html).toContain("onb2-proto.ravi.page");
    expect(html).toContain("convidarem à organização");
    expect(html).toContain("Pedir acesso");
    expect(html).toContain(`/access/request?returnTo=${encodeURIComponent("https://onb2-proto.ravi.page/deck")}`);
    expect(html).not.toContain("not_found");
    expect(html).not.toContain("org_rbbt");
  });

  test("returns precise JSON for org denial", async () => {
    const response = await handlePagesAuthStartGet(startRequest({ accept: "application/json" }), {
      ...NO_GRANT,
      getAuthState: async () => ({}) as never,
      getWorkspace: async () => {
        throw new ConsoleWorkspaceSelectionRequiredError([]);
      },
      rateLimited: () => false,
      resolveTarget: async () => TARGET,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "pages_access_denied",
      reason: "org_forbidden",
    });
  });

  test("returns precise JSON for project denial", async () => {
    const response = await handlePagesAuthStartGet(startRequest({ format: "json" }), {
      ...NO_GRANT,
      createClaimCode: async () => {
        throw new ConsoleApiError(403, { error: "pages_access_denied", reason: "project_forbidden" });
      },
      getAuthState: async () => ({}) as never,
      getWorkspace: async () => WORKSPACE as never,
      rateLimited: () => false,
      resolveTarget: async () => TARGET,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "pages_access_denied",
      reason: "project_forbidden",
    });
  });

  test("keeps invalid return targets off the access-denied copy", async () => {
    const response = await handlePagesAuthStartGet(
      startRequest({
        accept: "text/html",
        returnTo: "https://missing.ravi.page/",
      }),
      {
        rateLimited: () => false,
        resolveTarget: async () => null,
      },
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("Destino inválido");
    expect(html).toContain("não é um problema de permissão");
    expect(html).not.toContain("Acesso negado");
  });

  test("redirects to the claim URL when access is allowed", async () => {
    const response = await handlePagesAuthStartGet(startRequest({ accept: "text/html" }), {
      createClaimCode: async () => ({
        claimCodeId: "claim_1",
        claimUrl: "https://onb2-proto.ravi.page/_ravi/auth/claim?code=abc",
        expiresAt: new Date("2026-05-10T21:00:00.000Z"),
      }),
      getAuthState: async () => ({}) as never,
      getWorkspace: async () => WORKSPACE as never,
      rateLimited: () => false,
      resolveTarget: async () => TARGET,
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://onb2-proto.ravi.page/_ravi/auth/claim?code=abc");
  });
});

describe("GET /api/pages/auth/start for people given a page", () => {
  test("signs in someone outside the org who was given the requested page", async () => {
    const calls: unknown[] = [];
    const response = await handlePagesAuthStartGet(startRequest({ accept: "text/html" }), {
      createGuestClaimCode: async (input) => {
        calls.push(input);
        return {
          claimCodeId: "claim_guest",
          claimUrl: "https://onb2-proto.ravi.page/_ravi/auth/claim?code=guest",
          expiresAt: new Date("2026-05-10T21:00:00.000Z"),
        };
      },
      getAuthState: async () => ({ mode: "workos" }) as never,
      getUser: async () => ({ id: "user_guest" }) as never,
      getWorkspace: async () => {
        throw new ConsoleWorkspaceSelectionRequiredError([]);
      },
      rateLimited: () => false,
      resolveTarget: async () => TARGET,
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://onb2-proto.ravi.page/_ravi/auth/claim?code=guest");
    expect(calls).toEqual([
      expect.objectContaining({ returnTo: "https://onb2-proto.ravi.page/deck", userId: "user_guest" }),
    ]);
  });

  test("lets a member without project access in through a grant too", async () => {
    const response = await handlePagesAuthStartGet(startRequest({ format: "json" }), {
      createClaimCode: async () => {
        throw new ConsoleApiError(403, { error: "pages_access_denied", reason: "project_forbidden" });
      },
      createGuestClaimCode: async () => ({
        claimCodeId: "claim_guest",
        claimUrl: "https://onb2-proto.ravi.page/_ravi/auth/claim?code=guest",
        expiresAt: new Date("2026-05-10T21:00:00.000Z"),
      }),
      getAuthState: async () => ({ mode: "workos" }) as never,
      getUser: async () => ({ id: "user_1" }) as never,
      getWorkspace: async () => WORKSPACE as never,
      rateLimited: () => false,
      resolveTarget: async () => TARGET,
    });

    expect(response.status).toBe(307);
  });

  test("never tries the guest path in anonymous local mode", async () => {
    let guestTried = false;
    const response = await handlePagesAuthStartGet(startRequest({ format: "json" }), {
      createGuestClaimCode: async () => {
        guestTried = true;
        throw new Error("should not run");
      },
      getAuthState: async () => ({ mode: "anonymous" }) as never,
      getWorkspace: async () => {
        throw new ConsoleWorkspaceSelectionRequiredError([]);
      },
      rateLimited: () => false,
      resolveTarget: async () => TARGET,
    });

    expect(response.status).toBe(403);
    expect(guestTried).toBe(false);
  });
});

function startRequest(input: { accept?: string; fetchMode?: string; format?: string; returnTo?: string }) {
  const url = new URL("https://console.ravi.bot/api/pages/auth/start");
  url.searchParams.set("returnTo", input.returnTo ?? "https://onb2-proto.ravi.page/deck");
  if (input.format) url.searchParams.set("format", input.format);
  const headers = new Headers();
  if (input.accept) headers.set("accept", input.accept);
  if (input.fetchMode) headers.set("sec-fetch-mode", input.fetchMode);
  return new NextRequest(url, { headers });
}
