import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { redirectLegacyConsolePath, returnToForOrganization } from "./org-urls";

const originalMode = process.env.RAVI_AUTH_MODE;
const originalOrigin = process.env.NEXT_PUBLIC_CONSOLE_URL;
afterEach(() => {
  if (originalMode === undefined) delete process.env.RAVI_AUTH_MODE;
  else process.env.RAVI_AUTH_MODE = originalMode;
  if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_CONSOLE_URL;
  else process.env.NEXT_PUBLIC_CONSOLE_URL = originalOrigin;
});

describe("organization URLs", () => {
  const acme = { id: "0b5c", slug: "acme" };

  test("choosing an organization opens where the reader was going, in that organization", () => {
    expect(returnToForOrganization(acme, null)).toBe("/acme");
    expect(returnToForOrganization(acme, "/projects")).toBe("/acme");
    expect(returnToForOrganization(acme, "/org/members")).toBe("/acme/members");
    expect(returnToForOrganization(acme, "/other/p/1/pages?x=1")).toBe("/acme/p/1/pages?x=1");
  });

  test("paths outside an organization are left alone", () => {
    expect(returnToForOrganization(acme, "/connectors/step-up?challenge=1")).toBe("/connectors/step-up?challenge=1");
    expect(returnToForOrganization(acme, "/bugs/1")).toBe("/bugs/1");
  });

  test("post-login /projects uses configured OIDC origin behind internal proxy URL", async () => {
    process.env.RAVI_AUTH_MODE = "oidc";
    process.env.NEXT_PUBLIC_CONSOLE_URL = "https://console.nba-console.localhost";
    const response = await redirectLegacyConsolePath(new NextRequest("https://0.0.0.0:3000/projects", {
      headers: { host: "attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "http" },
    }), {
      getAuthState: async () => ({ mode: "oidc", viewer: { name: "Test", email: "test@staging.invalid", mark: "T" } }),
      resolveTarget: async () => "/console-staging",
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://console.nba-console.localhost/console-staging");
  });

  test("unauthenticated legacy paths redirect to the canonical login without consulting target", async () => {
    process.env.RAVI_AUTH_MODE = "oidc";
    process.env.NEXT_PUBLIC_CONSOLE_URL = "https://console.nba-console.localhost";
    const response = await redirectLegacyConsolePath(new NextRequest("https://0.0.0.0:3000/projects?tab=all"), {
      getAuthState: async () => null,
      resolveTarget: async () => { throw new Error("Must not run without auth"); },
    });
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://console.nba-console.localhost");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("returnTo")).toBe("/projects?tab=all");
  });

  test("referer hint accepts only the configured Console origin, not forwarded authority", async () => {
    process.env.RAVI_AUTH_MODE = "oidc";
    process.env.NEXT_PUBLIC_CONSOLE_URL = "https://console.nba-console.localhost";
    for (const [referer, expected] of [
      ["https://console.nba-console.localhost/console-staging/members", "console-staging"],
      ["https://0.0.0.0:3000/console-staging/members", null],
      ["https://attacker.invalid/console-staging/members", null],
    ] as const) {
      let seen: string | null | undefined;
      await redirectLegacyConsolePath(new NextRequest("https://0.0.0.0:3000/projects", {
        headers: { referer, "x-forwarded-host": "attacker.invalid" },
      }), {
        getAuthState: async () => ({ mode: "oidc", viewer: { name: "Test", email: "test@staging.invalid", mark: "T" } }),
        resolveTarget: async (_auth, _path, refs) => { seen = refs.refererRef; return "/console-staging"; },
      });
      expect(seen).toBe(expected);
    }
  });
});
