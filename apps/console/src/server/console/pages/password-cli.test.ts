import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { managePagesPasswordFromCli } from "./password-cli";

describe("Ravi Pages password CLI control", () => {
  test("configures policy before activating password visibility and returns no secret", async () => {
    const events: string[] = [];
    let receivedPassword = "";
    const result = await managePagesPasswordFromCli({
      body: {
        action: "set",
        password: "correct horse battery staple",
        path: "/report",
        siteRef: "demo",
      },
      projectRef: "project",
      requestId: "req_set",
      workspace: workspace(),
    }, {
      configurePolicy: async (input) => {
        events.push("policy");
        receivedPassword = input.password;
        return policy();
      },
      getSite: async () => site() as never,
      passwordRepository: passwordRepository(),
      resolveRouteContext: async () => routeContext(),
      updateRouteVisibility: async (input) => {
        events.push("visibility");
        expect(input.context.actorType).toBe("cli");
        expect(input.visibility).toBe("password");
        return visibilityResult("password");
      },
    });

    expect(events).toEqual(["policy", "visibility"]);
    expect(receivedPassword).toBe("correct horse battery staple");
    expect(result).toMatchObject({
      action: "set",
      configured: true,
      path: "/report",
      policy: { configured: true, scope: "route", version: 2 },
      route: { effectiveVisibility: "password", visibility: "password" },
      scope: "route",
      url: "https://demo.ravi.page/report",
    });
    expect(JSON.stringify(result)).not.toContain("correct horse battery staple");
    expect(JSON.stringify(result)).not.toContain("passwordHash");
  });

  test("reads safe status without mutating policy or release", async () => {
    const result = await managePagesPasswordFromCli({
      body: { action: "status", path: "/report", siteRef: "demo" },
      projectRef: "project",
      requestId: "req_status",
      workspace: workspace(),
    }, {
      configurePolicy: async () => { throw new Error("unexpected configure"); },
      disablePolicy: async () => { throw new Error("unexpected disable"); },
      getPolicyStatus: async () => ({ configured: true, policy: policy(), scope: "route" }),
      getSite: async (input) => {
        expect(input.action).toBe("read");
        return site() as never;
      },
      passwordRepository: passwordRepository(),
      resolveRouteContext: async () => routeContext({ visibility: "password" }),
      updateRouteVisibility: async () => { throw new Error("unexpected visibility update"); },
    });

    expect(result).toMatchObject({
      action: "status",
      configured: true,
      release: { id: "release_1", number: 4 },
      route: { id: "route_1", visibility: "password" },
    });
  });

  test("activates replacement visibility before disabling the policy", async () => {
    const events: string[] = [];
    const result = await managePagesPasswordFromCli({
      body: {
        action: "remove",
        path: "/report",
        siteRef: "demo",
        visibility: "private",
      },
      projectRef: "project",
      requestId: "req_remove",
      workspace: workspace(),
    }, {
      disablePolicy: async () => {
        events.push("disable");
        return { changed: true, policy: { ...policy(), configured: false, status: "disabled" } };
      },
      getSite: async (input) => {
        expect(input.action).toBe("write");
        return site() as never;
      },
      passwordRepository: passwordRepository(),
      resolveRouteContext: async () => routeContext({ visibility: "password" }),
      updateRouteVisibility: async (input) => {
        events.push("visibility");
        expect(input.visibility).toBe("private");
        return visibilityResult("private");
      },
    });

    expect(events).toEqual(["visibility", "disable"]);
    expect(result).toMatchObject({
      action: "remove",
      configured: false,
      policy: { configured: false, status: "disabled" },
      route: { effectiveVisibility: "private", visibility: "private" },
    });
  });

  test("rejects malformed requests without reflecting submitted fields", async () => {
    const secret = "do-not-reflect-this-password";
    try {
      await managePagesPasswordFromCli({
        body: { action: "set", password: secret, path: "/", siteRef: "demo", unexpected: true },
        projectRef: "project",
        requestId: "req_invalid",
        workspace: workspace(),
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect(JSON.stringify((error as ConsoleApiError).payload)).not.toContain(secret);
    }
  });
});

function workspace() {
  return {
    membership: { role: "owner" as const },
    mode: "workos" as const,
    organization: { id: "org_1" },
    scopes: ["console.projects.read", "console.projects.link", "artifacts.publish"],
    user: { id: "user_1" },
  };
}

function site() {
  return {
    id: "site_1",
    organizationId: "org_1",
    projectId: "project_1",
    slug: "demo",
    defaultHostname: "demo.ravi.page",
    defaultVisibility: "public",
    activeReleaseId: "release_1",
    status: "active",
  };
}

function routeContext(overrides: { visibility?: "public" | "password" } = {}) {
  const visibility = overrides.visibility ?? "public";
  return {
    effectiveVisibility: visibility,
    release: { id: "release_1", releaseNumber: 4, status: "active" as const },
    route: {
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      assetBase: "/_ravi/assets/artifact_1/version_1/",
      entrypoint: "index.html",
      id: "binding_1",
      matchType: "spa" as const,
      path: "/report",
      priority: 0,
      routeId: "route_1",
      visibility,
    },
    site: {
      activeReleaseId: "release_1",
      defaultHostname: "demo.ravi.page",
      defaultVisibility: "public" as const,
      id: "site_1",
      organizationId: "org_1",
      projectId: "project_1",
      status: "active" as const,
    },
  };
}

function policy() {
  return {
    configured: true,
    id: "policy_1",
    rotatedAt: "2026-08-03T12:00:00.000Z",
    scope: "route" as const,
    status: "active" as const,
    version: 2,
  };
}

function visibilityResult(visibility: "password" | "private") {
  return {
    changed: true,
    release: { id: "release_2", number: 5 },
    route: {
      bindingId: "binding_2",
      effectiveVisibility: visibility,
      id: "route_1",
      path: "/report",
      visibility,
    },
    site: { id: "site_1", projectId: "project_1" },
  };
}

function passwordRepository() {
  return {
    async disablePolicy() { return null; },
    async findPolicyForScope() { return null; },
    async findSessionByHash() { return null; },
    async insertAudit() {},
    async insertSession() { throw new Error("not used"); },
    async markSessionExpired() {},
    async touchSession() {},
    async upsertPolicy() { throw new Error("not used"); },
  } as never;
}
