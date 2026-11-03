import { describe, expect, test } from "bun:test";

import type { ConsoleWorkspace } from "./workspace";

process.env.RAVI_GITHUB_APP_STATE_SECRET = "github-app-unit-test-secret";
process.env.RAVI_GITHUB_APP_CLIENT_ID = "Iv1.test";
process.env.RAVI_GITHUB_APP_CLIENT_SECRET = "test-secret";

const { openGithubUserSession, readGithubAppState, sealGithubUserSession, startGithubUserAuthorization } = await import("./github-app");

const workspace = (role: string) => ({
  membership: { role },
  organization: { id: "org-1" },
  user: { id: "user-1" },
}) as unknown as ConsoleWorkspace;

describe("GitHub sign-in", () => {
  test("sends people to GitHub with a signed state that names them and the installation", () => {
    const url = new URL(startGithubUserAuthorization(workspace("owner"), "123"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.test");
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.ravi.bot/github/callback");

    const state = readGithubAppState(url.searchParams.get("state"));
    expect(state).toMatchObject({ installationId: "123", organizationId: "org-1", userId: "user-1" });
  });

  test("rejects a state someone changed", () => {
    const url = new URL(startGithubUserAuthorization(workspace("owner")));
    const [encoded, signature] = url.searchParams.get("state")!.split(".");
    const forged = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")),
      installationId: "999",
    })).toString("base64url");
    expect(readGithubAppState(`${forged}.${signature}`)).toBeNull();
  });

  test("only owners and admins start it", () => {
    // Organization integration administration, not project data access: developers no longer qualify.
    expect(() => startGithubUserAuthorization(workspace("admin"))).not.toThrow();
    for (const role of ["developer", "viewer"]) expect(() => startGithubUserAuthorization(workspace(role))).toThrow("github_manage_forbidden");
  });

  test("the sealed sign-in opens only for the same person, untouched and unexpired", () => {
    const sealed = sealGithubUserSession({ exp: Date.now() + 60_000, token: "ghu_abc", userId: "user-1" });
    expect(sealed).not.toContain("ghu_abc");
    expect(openGithubUserSession(sealed, "user-1")?.token).toBe("ghu_abc");
    expect(openGithubUserSession(sealed, "user-2")).toBeNull();
    expect(openGithubUserSession(`${sealed.slice(0, -2)}AA`, "user-1")).toBeNull();

    const expired = sealGithubUserSession({ exp: Date.now() - 1, token: "ghu_abc", userId: "user-1" });
    expect(openGithubUserSession(expired, "user-1")).toBeNull();
  });
});
