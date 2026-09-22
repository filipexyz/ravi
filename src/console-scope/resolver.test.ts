import { afterEach, describe, expect, it } from "bun:test";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  resolveConsoleProjectRef,
  resolveConsoleScope,
  saveConsoleScopeDefault,
  seedInstallConsoleScopeDefaultFromVisibleProjects,
  seedInstallConsoleScopeDefaultIfAbsent,
  validateProjectRef,
} from "./resolver.js";
import { closeConsoleScopeStore, getConsoleScopeDefault } from "./store.js";

let stateDir: string | null = null;

afterEach(async () => {
  closeConsoleScopeStore();
  if (stateDir) {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  }
});

describe("validateProjectRef", () => {
  it("rejects an unknown ref as PAYLOAD_INVALID with a corrective set command", async () => {
    let caught: unknown;
    try {
      await validateProjectRef("missing-project", "https://console.example", {
        readCredentials: () => makeCredentials(),
        listProjects: async () => makeProjectList([{ id: "proj_1", slug: "rbbt-ravi", name: "RBBT" }]),
        lookupLocalAgent: () => null,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CloudAuthError);
    expect(caught).toMatchObject({
      code: "PAYLOAD_INVALID",
    });
    expect((caught as CloudAuthError).message).toContain('Console project "missing-project" was not found');
    expect((caught as CloudAuthError).message).toContain("ravi cloud scope set --project <project-ref>");
    expect((caught as CloudAuthError).message).toContain("Visible project refs: rbbt-ravi.");
    expect((caught as CloudAuthError).message).not.toContain("not visible in the selected organization");
    expect((caught as CloudAuthError).message).not.toContain("PROJECT_ACCESS_DENIED");
  });

  it("says agent refs are not Console projects when the ref matches a local agent", async () => {
    let caught: unknown;
    try {
      await validateProjectRef("main", "https://console.example", {
        readCredentials: () => makeCredentials(),
        listProjects: async () => makeProjectList([{ id: "proj_1", slug: "rbbt-ravi", name: "RBBT" }]),
        lookupLocalAgent: (id) => (id === "main" ? { id: "main" } : null),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "PAYLOAD_INVALID" });
    expect((caught as CloudAuthError).message).toContain('matches local agent id "main"');
    expect((caught as CloudAuthError).message).toContain("agent refs are not Console projects");
    expect((caught as CloudAuthError).message).toContain("ravi cloud scope set --project <project-ref>");
  });

  it("preserves a remote PROJECT_ACCESS_DENIED from the project list", async () => {
    const remote = new CloudAuthError("PROJECT_ACCESS_DENIED", "Console denied the project list.", { status: 403 });
    let caught: unknown;
    try {
      await validateProjectRef("rbbt-ravi", "https://console.example", {
        readCredentials: () => makeCredentials(),
        listProjects: async () => {
          throw remote;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(remote);
  });
});

describe("resolveConsoleProjectRef missing vs unknown", () => {
  it("names Project: not selected when no project is in scope", async () => {
    stateDir = await createIsolatedRaviState("ravi-console-scope-missing-");
    let caught: unknown;
    try {
      await resolveConsoleProjectRef(
        { requireProject: true },
        {
          readCredentials: () => makeCredentials(),
          listProjects: async () =>
            makeProjectList([
              { id: "proj_1", slug: "rbbt-ravi", name: "RBBT" },
              { id: "proj_2", slug: "filipe-ai", name: "Filipe" },
            ]),
          getContext: () => ({ sessionName: "ravi-console" }),
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "PAYLOAD_INVALID" });
    expect((caught as CloudAuthError).message).toContain("Project: not selected");
    expect((caught as CloudAuthError).message).toContain("ravi cloud scope set --project <project-ref>");
    expect((caught as CloudAuthError).message).toContain("--global");
    expect((caught as CloudAuthError).message).not.toContain("not visible in the selected organization");
  });
});

describe("install-level Console project default", () => {
  it("seeds a global default from the unique visible project", async () => {
    stateDir = await createIsolatedRaviState("ravi-console-scope-login-seed-");
    const credentials = makeCredentials();
    const seeded = await seedInstallConsoleScopeDefaultFromVisibleProjects(
      { consoleUrl: credentials.consoleUrl, credentials },
      {
        readCredentials: () => credentials,
        listProjects: async () => makeProjectList([{ id: "proj_1", slug: "solo-lab", name: "Solo" }]),
      },
    );

    expect(seeded).toMatchObject({
      scopeKind: "global",
      scopeKey: "default",
      project: { ref: "solo-lab" },
      sourceNote: "login unique visible project",
    });
    expect(
      getConsoleScopeDefault({ scopeKind: "global", scopeKey: "default" }, credentials.consoleUrl, {
        organization: credentials.organization,
      })?.project?.ref,
    ).toBe("solo-lab");
  });

  it("does not pick a global default when multiple projects are visible", async () => {
    stateDir = await createIsolatedRaviState("ravi-console-scope-login-multi-");
    const credentials = makeCredentials();
    const seeded = await seedInstallConsoleScopeDefaultFromVisibleProjects(
      { consoleUrl: credentials.consoleUrl, credentials },
      {
        readCredentials: () => credentials,
        listProjects: async () =>
          makeProjectList([
            { id: "proj_1", slug: "rbbt-ravi", name: "RBBT" },
            { id: "proj_2", slug: "filipe-ai", name: "Filipe" },
          ]),
      },
    );

    expect(seeded).toBeNull();
    expect(
      getConsoleScopeDefault({ scopeKind: "global", scopeKey: "default" }, credentials.consoleUrl, {
        organization: credentials.organization,
      }),
    ).toBeNull();
  });

  it("does not overwrite an existing install default on login seed", async () => {
    stateDir = await createIsolatedRaviState("ravi-console-scope-login-keep-");
    const credentials = makeCredentials();
    seedInstallConsoleScopeDefaultIfAbsent({
      consoleUrl: credentials.consoleUrl,
      organization: credentials.organization,
      project: { id: "proj_keep", slug: "already-set", name: "Kept", ref: "already-set" },
      sourceNote: "operator global",
    });

    const seeded = await seedInstallConsoleScopeDefaultFromVisibleProjects(
      { consoleUrl: credentials.consoleUrl, credentials },
      {
        readCredentials: () => credentials,
        listProjects: async () => makeProjectList([{ id: "proj_1", slug: "solo-lab", name: "Solo" }]),
      },
    );

    expect(seeded?.project?.ref).toBe("already-set");
    expect(seeded?.sourceNote).toBe("operator global");
  });

  it("lets a new agent inherit a saved --global default", async () => {
    stateDir = await createIsolatedRaviState("ravi-console-scope-global-inherit-");
    const credentials = makeCredentials();
    await saveConsoleScopeDefault(
      {
        scopeKind: "global",
        scopeKey: "default",
        project: { ref: "rbbt-ravi" },
        sourceNote: "ravi cloud scope set",
      },
      {
        readCredentials: () => credentials,
        listProjects: async () => makeProjectList([{ id: "proj_1", slug: "rbbt-ravi", name: "RBBT" }]),
      },
    );

    const scope = await resolveConsoleScope(
      {},
      {
        readCredentials: () => credentials,
        listProjects: async () =>
          makeProjectList([
            { id: "proj_1", slug: "rbbt-ravi", name: "RBBT" },
            { id: "proj_2", slug: "filipe-ai", name: "Filipe" },
          ]),
        getContext: () => ({ agentId: "fresh-agent" }),
      },
    );

    expect(scope).toMatchObject({
      source: "global_default",
      project: { ref: "rbbt-ravi" },
    });
  });

  it("seeds global from the first non-global set so a later agent inherits it", async () => {
    stateDir = await createIsolatedRaviState("ravi-console-scope-first-set-seed-");
    const credentials = makeCredentials();
    await saveConsoleScopeDefault(
      {
        scopeKind: "session",
        scopeKey: "ravi-console",
        project: { ref: "rbbt-ravi" },
        sourceNote: "ravi cloud scope set",
      },
      {
        readCredentials: () => credentials,
        listProjects: async () => makeProjectList([{ id: "proj_1", slug: "rbbt-ravi", name: "RBBT" }]),
      },
    );

    expect(
      getConsoleScopeDefault({ scopeKind: "global", scopeKey: "default" }, credentials.consoleUrl, {
        organization: credentials.organization,
      })?.project?.ref,
    ).toBe("rbbt-ravi");

    const scope = await resolveConsoleScope(
      {},
      {
        readCredentials: () => credentials,
        listProjects: async () =>
          makeProjectList([
            { id: "proj_1", slug: "rbbt-ravi", name: "RBBT" },
            { id: "proj_2", slug: "filipe-ai", name: "Filipe" },
          ]),
        getContext: () => ({ agentId: "other-agent" }),
      },
    );

    expect(scope).toMatchObject({
      source: "global_default",
      project: { ref: "rbbt-ravi" },
    });
  });
});

function makeProjectList(projects: Array<Record<string, unknown>>) {
  return {
    success: true as const,
    consoleUrl: "https://console.example",
    total: projects.length,
    projects,
    items: projects,
  };
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["console.projects.read", "console.projects.link"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
