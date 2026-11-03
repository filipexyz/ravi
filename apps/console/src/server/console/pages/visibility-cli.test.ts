import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  cliHasPagesRouteVisibilityWriteScopes,
  updatePagesRouteVisibilityFromCli,
} from "./visibility-cli";

describe("Ravi Pages route visibility CLI control", () => {
  test("requires both CLI write scopes", () => {
    expect(cliHasPagesRouteVisibilityWriteScopes(["console.projects.link"])).toBe(false);
    expect(cliHasPagesRouteVisibilityWriteScopes(["artifacts.publish"])).toBe(false);
    expect(cliHasPagesRouteVisibilityWriteScopes(["console.projects.read", "artifacts.publish"])).toBe(false);
    expect(cliHasPagesRouteVisibilityWriteScopes(["console.projects.link", "artifacts.publish"])).toBe(true);
  });

  test("flips one published route without uploading content and returns effective visibility", async () => {
    const result = await updatePagesRouteVisibilityFromCli({
      body: { path: "/", siteRef: "demo", visibility: "public" },
      projectRef: "project",
      requestId: "req_visibility",
      workspace: workspace(),
    }, {
      getSite: async (input) => {
        expect(input.action).toBe("write");
        expect(input.projectRef).toBe("project");
        expect(input.siteRef).toBe("demo");
        return site() as never;
      },
      resolveRouteContext: async (input) => {
        expect(input.host).toBe("demo.ravi.page");
        expect(input.path).toBe("/");
        return routeContext();
      },
      updateRouteVisibility: async (input) => {
        expect(input.context.actorType).toBe("cli");
        expect(input.context.scopes).toEqual(workspace().scopes);
        expect(input.reason).toBe("cli_visibility_update");
        expect(input.visibility).toBe("public");
        expect(input.route.path).toBe("/");
        expect(input.release.id).toBe("release_1");
        return visibilityResult({
          changed: true,
          visibility: "public",
          effectiveVisibility: "public",
          release: { id: "release_2", number: 5 },
        });
      },
    });

    expect(result).toMatchObject({
      changed: true,
      path: "/",
      projectRef: "project",
      release: { id: "release_2", number: 5 },
      route: {
        bindingId: "binding_2",
        effectiveVisibility: "public",
        id: "route_1",
        path: "/",
        visibility: "public",
      },
      site: {
        defaultHostname: "demo.ravi.page",
        defaultVisibility: "public",
        id: "site_1",
        projectId: "project_1",
      },
      siteRef: "demo",
      url: "https://demo.ravi.page/",
    });
  });

  test("returns the current release when the route already has the requested visibility", async () => {
    const result = await updatePagesRouteVisibilityFromCli({
      body: { path: "/report", siteRef: "demo", visibility: "private" },
      projectRef: "project",
      requestId: "req_idempotent",
      workspace: workspace(),
    }, {
      getSite: async () => site() as never,
      resolveRouteContext: async () => routeContext({
        path: "/report",
        visibility: "private",
        effectiveVisibility: "private",
      }),
      updateRouteVisibility: async (input) => {
        expect(input.visibility).toBe("private");
        return visibilityResult({
          changed: false,
          visibility: "private",
          effectiveVisibility: "private",
          path: "/report",
          bindingId: "binding_1",
          release: { id: "release_1", number: 4 },
        });
      },
    });

    expect(result).toMatchObject({
      changed: false,
      path: "/report",
      release: { id: "release_1", number: 4 },
      route: { effectiveVisibility: "private", visibility: "private" },
      url: "https://demo.ravi.page/report",
    });
  });

  test("rejects an unknown active route without mutating visibility", async () => {
    try {
      await updatePagesRouteVisibilityFromCli({
        body: { path: "/missing", siteRef: "demo", visibility: "public" },
        projectRef: "project",
        requestId: "req_missing",
        workspace: workspace(),
      }, {
        getSite: async () => site() as never,
        resolveRouteContext: async () => null,
        updateRouteVisibility: async () => {
          throw new Error("unexpected visibility update");
        },
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(404);
      expect((error as ConsoleApiError).payload).toMatchObject({ error: "route_not_found" });
    }
  });

  test("rejects password visibility and extra fields without reflecting them", async () => {
    try {
      await updatePagesRouteVisibilityFromCli({
        body: { path: "/", siteRef: "demo", visibility: "password", unexpected: true },
        projectRef: "project",
        requestId: "req_invalid",
        workspace: workspace(),
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).payload.error).toBe("validation_failed");
      expect(JSON.stringify((error as ConsoleApiError).payload)).not.toContain("password");
    }
  });
});

function workspace() {
  return {
    membership: { role: "owner" as const },
    mode: "workos" as const,
    organization: { id: "org_1" },
    scopes: ["console.projects.link", "artifacts.publish"],
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

function routeContext(overrides: {
  effectiveVisibility?: "public" | "private" | "protected_link";
  path?: string;
  visibility?: "public" | "private" | "protected_link";
} = {}) {
  const visibility = overrides.visibility ?? "private";
  const path = overrides.path ?? "/";
  return {
    effectiveVisibility: overrides.effectiveVisibility ?? visibility,
    release: { id: "release_1", releaseNumber: 4, status: "active" as const },
    route: {
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      assetBase: "/_ravi/assets/artifact_1/version_1/",
      entrypoint: "index.html",
      id: "binding_1",
      matchType: "spa" as const,
      path,
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

function visibilityResult(input: {
  bindingId?: string;
  changed: boolean;
  effectiveVisibility: "public" | "private" | "protected_link";
  path?: string;
  release: { id: string; number: number };
  visibility: "public" | "private" | "protected_link";
}) {
  return {
    changed: input.changed,
    release: input.release,
    route: {
      bindingId: input.bindingId ?? "binding_2",
      effectiveVisibility: input.effectiveVisibility,
      id: "route_1",
      path: input.path ?? "/",
      visibility: input.visibility,
    },
    site: { id: "site_1", projectId: "project_1" },
  };
}
