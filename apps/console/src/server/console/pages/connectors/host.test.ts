import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createLocalJWKSet, jwtVerify } from "jose";

import { ConsoleApiError } from "@/server/console/api-error";
import type { PagesPrivateAuthRepository, PagesSessionRecord } from "@/server/console/pages/auth";
import type { PageSite } from "@/server/console/pages";
import {
  resetViewerAssertionKeyCache,
  viewerAssertionJwks,
} from "@/server/console/pages/viewer-assertions/jwt";
import type { BasesCaller } from "@/server/console/bases";
import {
  BASES_CHARTS_DATA_ACTION_ID,
  BASES_CONNECTOR_ACTION_IDS,
  BASES_VIEWS_DESCRIBE_ACTION_ID,
  BASES_VIEWS_QUERY_ACTION_ID,
  BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID,
  BASES_VIEWS_ROWS_CREATE_ACTION_ID,
  BASES_VIEWS_ROWS_GET_ACTION_ID,
  BASES_VIEWS_ROWS_UPDATE_ACTION_ID,
  BASES_VIEWS_VERSION_ACTION_ID,
  IDENTITY_ASSERTION_ACTION_ID,
  KNOWLEDGE_SEARCH_ACTION_ID,
  PAGES_PUBLISHED_LIST_ACTION_ID,
  PAGES_SITES_LIST_ACTION_ID,
  PAGES_THEME_GET_ACTION_ID,
  PROJECTS_LIST_ACTION_ID,
} from "./catalog";
import {
  execPagesConnector as execPagesConnectorWithPolicy,
  getPagesConnectorCatalog as getPagesConnectorCatalogWithPolicy,
  PAGES_CONNECTOR_EXEC_LIMITS,
  PAGES_KNOWLEDGE_SEARCH_LIMIT,
  pagesConnectorExecErrorBody,
  type PagesConnectorBasesServices,
  type PagesConnectorHostDeps,
  type PagesConnectorSite,
} from "./host";

process.env.RAVI_PAGES_AUTH_SESSION_SECRET ??= "test_pages_auth_secret_1234567890";

const SESSION = "sessionabcdefghijklmnopqrstuvwxyz123456";

// Unit fixture has no policy DB. Supply an explicit exact-resource read
// observation, not owner/admin inference; the real policy path runs in host.db.test.ts.
const fixtureCanRead: NonNullable<PagesConnectorHostDeps["canReadProject"]> = async (workspace, projectId, action) =>
  workspace.organization.id === "org_1" && workspace.user.id === "user_1" && projectId === "proj_1" && action === "read";
const execPagesConnector = (input: Parameters<typeof execPagesConnectorWithPolicy>[0], deps: PagesConnectorHostDeps = {}) =>
  execPagesConnectorWithPolicy(input, { canReadProject: fixtureCanRead, ...deps });
const getPagesConnectorCatalog = (input: Parameters<typeof getPagesConnectorCatalogWithPolicy>[0], deps: PagesConnectorHostDeps = {}) =>
  getPagesConnectorCatalogWithPolicy(input, { canReadProject: fixtureCanRead, ...deps });

describe("Pages connector host BFF", () => {
  test("delegates only authorized human operations with verified site/user scope; callback cannot loop", async () => {
    const calls: unknown[] = [];
    const audits: Array<{ metadataJson: Record<string, unknown> }> = [];
    let localCalls = 0;
    const deps: PagesConnectorHostDeps = {
      findSiteByHost: async () => site(),
      authRepository: fakeAuthRepository({ session: { issuedFromClaimCodeId: "claim_1" } }),
      loadUsesSnapshot: async () => ({ catalogSchemaVersion: 1, uses: [{ id: PROJECTS_LIST_ACTION_ID, revision: 1 }] }),
      isRateLimited: () => false,
      shouldDelegateOperation: () => true,
      delegateOperation: async (input) => { calls.push(input); return { output: { items: [] }, auditMetadata: { via: "executor", delegation: "site-scoped", secret: "must-not-persist" } }; },
      insertAudit: async (input) => { audits.push(input); },
      listProjects: async () => { localCalls++; return [] as never; },
    };
    const operation = { host: "demo.ravi.page", id: PROJECTS_LIST_ACTION_ID, input: {}, origin: "https://demo.ravi.page", pagesSession: SESSION, requestId: "delegate-test" };
    await execPagesConnector(operation, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ actorId: "user_1", organizationId: "org_1", projectId: "proj_1", siteId: "site_1", releaseId: "release_1", pagesSession: SESSION });
    expect(localCalls).toBe(0);
    expect(audits.at(-1)?.metadataJson).toMatchObject({ via: "executor", delegation: "site-scoped" });
    expect(audits.at(-1)?.metadataJson).not.toHaveProperty("secret");
    await execPagesConnector(operation, { ...deps, executorCallback: true });
    expect(calls).toHaveLength(1);
    expect(localCalls).toBe(1);
    await expect(execPagesConnector({ ...operation, id: BASES_VIEWS_QUERY_ACTION_ID, input: {} }, deps)).rejects.toMatchObject({ payload: { error: "connector_not_allowlisted" } });
    expect(calls).toHaveLength(1);
  });

  test("legacy incompatible origin configuration cannot execute even a declared action", async () => {
    const deps: PagesConnectorHostDeps = {
      findSiteByHost: async () => site(), authRepository: fakeAuthRepository(),
      loadUsesSnapshot: async () => { throw new ConsoleApiError(403, { error: "connector_origin_grants_conflict" }); },
      isRateLimited: () => false,
      listProjects: async () => { throw new Error("must not execute"); },
    };
    await expect(execPagesConnector({ host: "demo.ravi.page", id: PROJECTS_LIST_ACTION_ID, pagesSession: SESSION, requestId: "invalid-origin-release" }, deps))
      .rejects.toMatchObject({ status: 403, payload: { error: "connector_origin_grants_conflict" } });
  });
  test("returns the curated platform catalog slice and marks session-less actions inexecutable", async () => {
    const result = await getPagesConnectorCatalog(
      {
        host: "demo.ravi.page",
        requestId: "req_catalog",
      },
      {
        findSiteByHost: async () => site(),
        loadUsesSnapshot: async () => null,
      },
    );

    expect(result.schemaVersion).toBe(1);
    expect(result.siteId).toBe("site_1");
    expect(result.projectId).toBe("proj_1");
    expect(result.actions.map((action) => action.id)).toEqual([
      PROJECTS_LIST_ACTION_ID,
      PAGES_SITES_LIST_ACTION_ID,
      PAGES_PUBLISHED_LIST_ACTION_ID,
      PAGES_THEME_GET_ACTION_ID,
    ]);
    expect(result.actions.find((action) => action.id === PAGES_SITES_LIST_ACTION_ID)).toMatchObject({
      id: PAGES_SITES_LIST_ACTION_ID,
      allowlisted: true,
      executable: false,
      missingSession: true,
      auth: "platform",
      providerId: "ravi",
    });
    expect(result.actions.find((action) => action.id === PROJECTS_LIST_ACTION_ID)).toMatchObject({
      id: PROJECTS_LIST_ACTION_ID,
      allowlisted: true,
      executable: false,
      missingSession: true,
      auth: "platform",
      providerId: "ravi",
    });
  });

  test("executes ravi.pages.sites.list with a viewer workspace from the Pages session", async () => {
    const listed: unknown[] = [];
    const audits: unknown[] = [];
    const result = await execPagesConnector(
      {
        host: "demo.ravi.page",
        id: PAGES_SITES_LIST_ACTION_ID,
        input: {},
        pagesSession: SESSION,
        requestId: "req_exec",
      },
      {
        authRepository: fakeAuthRepository({ audits }),
        findSiteByHost: async () => site(),
        loadUsesSnapshot: async () => ({
          catalogSchemaVersion: 1,
          uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
        }),
        insertAudit: async (input) => {
          audits.push(input);
        },
        listPageSitesForProject: async ({ projectRef, workspace }) => {
          listed.push({ projectRef, workspace });
          return [
            pageSite({ id: "site_1", slug: "demo" }),
            pageSite({ id: "site_gone", slug: "gone", status: "deleted" }),
          ];
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      id: PAGES_SITES_LIST_ACTION_ID,
      revision: 1,
    });
    expect(result.output).toEqual({
      items: [
        {
          id: "site_1",
          slug: "demo",
          defaultHostname: "demo.ravi.page",
          defaultVisibility: "private",
          isDefault: false,
          status: "active",
          activeReleaseId: "release_1",
          updatedAt: Date.parse("2026-09-16T12:00:00.000Z"),
        },
      ],
    });
    expect(listed).toEqual([
      {
        projectRef: "proj_1",
        workspace: {
          mode: "workos",
          user: { id: "user_1" },
          organization: { id: "org_1" },
          membership: { role: "developer" },
        },
      },
    ]);
    expect(audits.at(-1)).toMatchObject({
      action: "pages.connector.exec.allowed",
      actorId: "user_1",
      metadataJson: {
        actionId: PAGES_SITES_LIST_ACTION_ID,
        outcome: "ok",
      },
    });
  });

  test("executes ravi.projects.list with the viewer workspace in the current org", async () => {
    const listed: unknown[] = [];
    const result = await execPagesConnector(
      {
        host: "demo.ravi.page",
        id: PROJECTS_LIST_ACTION_ID,
        input: {},
        pagesSession: SESSION,
        requestId: "req_projects",
      },
      {
        authRepository: fakeAuthRepository(),
        findSiteByHost: async () => site(),
        loadUsesSnapshot: async () => ({
          catalogSchemaVersion: 1,
          uses: [{ id: PROJECTS_LIST_ACTION_ID, revision: 1 }],
        }),
        listProjects: async (workspace) => {
          listed.push(workspace);
          return [
            {
              id: "proj_1",
              orgId: "org_1",
              slug: "current",
              name: "Current",
              description: "This site",
              artifactCount: 9,
              members: 3,
              lastActive: 1,
            },
            {
              id: "proj_2",
              orgId: "org_1",
              slug: "hub",
              name: "Hub",
              description: "",
              artifactCount: 0,
              members: 1,
              lastActive: 2,
            },
          ];
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      id: PROJECTS_LIST_ACTION_ID,
      revision: 1,
    });
    expect(result.output).toEqual({
      items: [
        { id: "proj_1", slug: "current", name: "Current", description: "This site" },
        { id: "proj_2", slug: "hub", name: "Hub" },
      ],
    });
    expect(listed).toEqual([
      {
        user: { id: "user_1" },
        organization: { id: "org_1" },
        membership: { role: "developer" },
      },
    ]);
  });

  test("lists sites for an explicit in-org projectRef the viewer can access", async () => {
    const listed: unknown[] = [];
    const resolved: unknown[] = [];
    const result = await execPagesConnector(
      {
        host: "demo.ravi.page",
        id: PAGES_SITES_LIST_ACTION_ID,
        input: { projectRef: "hub" },
        pagesSession: SESSION,
        requestId: "req_project_ref",
      },
      {
        authRepository: fakeAuthRepository(),
        findSiteByHost: async () => site(),
        loadUsesSnapshot: async () => ({
          catalogSchemaVersion: 1,
          uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
        }),
        findAccessibleProjectRecord: async (workspace, projectRef) => {
          resolved.push({ workspace, projectRef });
          return accessibleProject({ id: "proj_2", slug: "hub" });
        },
        listPageSitesForProject: async ({ projectRef, workspace }) => {
          listed.push({ projectRef, workspace });
          return [pageSite({ id: "site_2", projectId: "proj_2", slug: "hub" })];
        },
      },
    );

    expect(result.output).toEqual({
      items: [
        {
          id: "site_2",
          slug: "hub",
          defaultHostname: "demo.ravi.page",
          defaultVisibility: "private",
          isDefault: false,
          status: "active",
          activeReleaseId: "release_1",
          updatedAt: Date.parse("2026-09-16T12:00:00.000Z"),
        },
      ],
    });
    expect(resolved).toEqual([
      {
        workspace: {
          user: { id: "user_1" },
          organization: { id: "org_1" },
          membership: { role: "developer" },
        },
        projectRef: "hub",
      },
    ]);
    expect(listed).toEqual([
      {
        projectRef: "proj_2",
        workspace: {
          mode: "workos",
          user: { id: "user_1" },
          organization: { id: "org_1" },
          membership: { role: "developer" },
        },
      },
    ]);
  });

  test("rejects sites.list when projectRef is not readable in the viewer org", async () => {
    await expect(
      execPagesConnector(
        {
          host: "demo.ravi.page",
          id: PAGES_SITES_LIST_ACTION_ID,
          input: { projectRef: "proj_foreign" },
          pagesSession: SESSION,
          requestId: "req_forbidden_project",
        },
        {
          authRepository: fakeAuthRepository(),
          findSiteByHost: async () => site(),
          loadUsesSnapshot: async () => ({
            catalogSchemaVersion: 1,
            uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
          }),
          findAccessibleProjectRecord: async () => null,
          listPageSitesForProject: async () => {
            throw new Error("should not list");
          },
        },
      ),
    ).rejects.toMatchObject({
      status: 403,
      payload: { error: "connector_permission_required" },
    });
  });

  test("lists published pages for an explicit projectRef and fails closed when forbidden", async () => {
    const listed: unknown[] = [];
    const allowed = await execPagesConnector(
      {
        host: "demo.ravi.page",
        id: PAGES_PUBLISHED_LIST_ACTION_ID,
        input: { projectRef: "proj_2" },
        pagesSession: SESSION,
        requestId: "req_published_ref",
      },
      {
        authRepository: fakeAuthRepository(),
        findSiteByHost: async () => site(),
        loadUsesSnapshot: async () => ({
          catalogSchemaVersion: 1,
          uses: [{ id: PAGES_PUBLISHED_LIST_ACTION_ID, revision: 1 }],
        }),
        findAccessibleProjectRecord: async () => accessibleProject({ id: "proj_2" }),
        listPublishedPages: async (workspace, projectRef) => {
          listed.push({ workspace, projectRef });
          return [
            {
              id: "page_2",
              path: "/",
              title: "Hub",
              urls: ["https://hub.ravi.page/"],
              visibility: "private",
              siteSlug: "hub",
              defaultHostname: "hub.ravi.page",
              updatedAt: 123,
            },
          ] as never;
        },
      },
    );
    expect(allowed.output).toEqual({
      items: [
        {
          id: "page_2",
          path: "/",
          title: "Hub",
          urls: ["https://hub.ravi.page/"],
          visibility: "private",
          siteSlug: "hub",
          defaultHostname: "hub.ravi.page",
          updatedAt: 123,
        },
      ],
    });
    expect(listed).toEqual([
      {
        workspace: {
          user: { id: "user_1" },
          organization: { id: "org_1" },
          membership: { role: "developer" },
        },
        projectRef: "proj_2",
      },
    ]);

    await expect(
      execPagesConnector(
        {
          host: "demo.ravi.page",
          id: PAGES_PUBLISHED_LIST_ACTION_ID,
          input: { projectRef: "other-org-project" },
          pagesSession: SESSION,
          requestId: "req_published_forbidden",
        },
        {
          authRepository: fakeAuthRepository(),
          findSiteByHost: async () => site(),
          loadUsesSnapshot: async () => ({
            catalogSchemaVersion: 1,
            uses: [{ id: PAGES_PUBLISHED_LIST_ACTION_ID, revision: 1 }],
          }),
          findAccessibleProjectRecord: async () => null,
          listPublishedPages: async () => {
            throw new Error("should not list");
          },
        },
      ),
    ).rejects.toMatchObject({
      status: 403,
      payload: { error: "connector_permission_required" },
    });
  });

  test("rejects missing Pages session on exec", async () => {
    const audits: unknown[] = [];
    await expect(
      execPagesConnector(
        {
          host: "demo.ravi.page",
          id: PAGES_SITES_LIST_ACTION_ID,
          input: {},
          requestId: "req_no_session",
        },
        {
          findSiteByHost: async () => site(),
          insertAudit: async (input) => {
            audits.push(input);
          },
        },
      ),
    ).rejects.toMatchObject({
      status: 401,
      payload: { error: "connector_session_required" },
    });
    expect(audits.at(-1)).toMatchObject({
      action: "pages.connector.exec.denied",
      metadataJson: { outcome: "connector_session_required" },
    });
  });

  test("rejects an invalid Pages session on exec", async () => {
    await expect(
      execPagesConnector(
        {
          host: "demo.ravi.page",
          id: PAGES_SITES_LIST_ACTION_ID,
          input: {},
          pagesSession: SESSION,
          requestId: "req_bad_session",
        },
        {
          authRepository: fakeAuthRepository({ missingSession: true }),
          findSiteByHost: async () => site(),
        },
      ),
    ).rejects.toMatchObject({
      status: 401,
      payload: { error: "connector_unauthorized" },
    });
  });

  test("rate-limits exec per viewer, then site, then organization", async () => {
    const execWithLimiter = async (limitedKeyPrefix: string | null) => {
      const checked: Array<{ key: string; limit: number; windowMs: number }> = [];
      const listed: unknown[] = [];
      const run = execPagesConnector(
        {
          host: "demo.ravi.page",
          id: PAGES_SITES_LIST_ACTION_ID,
          input: {},
          pagesSession: SESSION,
          requestId: "req_rate",
        },
        {
          authRepository: fakeAuthRepository(),
          findSiteByHost: async () => site(),
          loadUsesSnapshot: async () => ({
            catalogSchemaVersion: 1,
            uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
          }),
          insertAudit: async () => {},
          listPageSitesForProject: async (input) => {
            listed.push(input);
            return [];
          },
          isRateLimited: (options) => {
            checked.push(options);
            return limitedKeyPrefix !== null && options.key.startsWith(limitedKeyPrefix);
          },
        },
      );
      return { run, checked, listed };
    };

    const ok = await execWithLimiter(null);
    await expect(ok.run).resolves.toMatchObject({ ok: true });
    expect(ok.listed).toHaveLength(1);
    expect(ok.checked).toEqual([
      { key: "pages-connectors-exec:viewer:site_1:user_1", limit: PAGES_CONNECTOR_EXEC_LIMITS.viewer, windowMs: 60_000 },
      { key: "pages-connectors-exec:site:site_1", limit: PAGES_CONNECTOR_EXEC_LIMITS.site, windowMs: 60_000 },
      { key: "pages-connectors-exec:org:org_1", limit: PAGES_CONNECTOR_EXEC_LIMITS.organization, windowMs: 60_000 },
    ]);

    for (const [prefix, counted] of [
      ["pages-connectors-exec:viewer:", 1],
      ["pages-connectors-exec:site:", 2],
      ["pages-connectors-exec:org:", 3],
    ] as const) {
      const limited = await execWithLimiter(prefix);
      await expect(limited.run).rejects.toMatchObject({ status: 429, payload: { error: "connector_rate_limited" } });
      // A refused call is not counted against the later, wider buckets and never reaches the action.
      expect(limited.checked).toHaveLength(counted);
      expect(limited.listed).toHaveLength(0);
    }
  });

  test("does not count exec calls without a valid Pages session", async () => {
    const checked: unknown[] = [];
    await expect(
      execPagesConnector(
        { host: "demo.ravi.page", id: PAGES_SITES_LIST_ACTION_ID, input: {}, pagesSession: SESSION, requestId: "req_rate_bad" },
        {
          authRepository: fakeAuthRepository({ missingSession: true }),
          findSiteByHost: async () => site(),
          insertAudit: async () => {},
          isRateLimited: (options) => {
            checked.push(options);
            return true;
          },
        },
      ),
    ).rejects.toMatchObject({ status: 401, payload: { error: "connector_unauthorized" } });
    expect(checked).toEqual([]);
  });

  test("rejects unknown action ids", async () => {
    await expect(
      execPagesConnector(
        {
          host: "demo.ravi.page",
          id: "console.pages.sites.list",
          input: {},
          pagesSession: SESSION,
          requestId: "req_unknown",
        },
        {
          authRepository: fakeAuthRepository(),
          findSiteByHost: async () => site(),
          loadUsesSnapshot: async () => ({
            catalogSchemaVersion: 1,
            uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
          }),
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
      payload: { error: "connector_capability_unsupported" },
    });
  });

  test("rejects input that fails the snapshot schema", async () => {
    try {
      await execPagesConnector(
        {
          host: "demo.ravi.page",
          id: PAGES_SITES_LIST_ACTION_ID,
          input: { limit: 0, projectId: "proj_other" },
          pagesSession: SESSION,
          requestId: "req_schema",
        },
        {
          authRepository: fakeAuthRepository(),
          findSiteByHost: async () => site(),
          loadUsesSnapshot: async () => ({
            catalogSchemaVersion: 1,
            uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
          }),
          listPageSitesForProject: async () => {
            throw new Error("should not list");
          },
        },
      );
      throw new Error("expected schema failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).payload.error).toBe("payload_invalid");
    }
  });

  test("mints a 60-second viewer assertion for a human session and registered audience", async () => {
    const env = assertionSigningEnv();
    const previous = process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON;
    const previousIssuer = process.env.RAVI_PAGES_VIEWER_ASSERTION_ISSUER;
    process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON = env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON;
    process.env.RAVI_PAGES_VIEWER_ASSERTION_ISSUER = env.RAVI_PAGES_VIEWER_ASSERTION_ISSUER;
    resetViewerAssertionKeyCache();
    const audits: unknown[] = [];

    try {
      const result = await execPagesConnector(
        {
          host: "demo.ravi.page",
          id: IDENTITY_ASSERTION_ACTION_ID,
          input: { aud: "https://api.customer.example" },
          origin: "https://demo.ravi.page",
          pagesSession: SESSION,
          requestId: "req_assert",
        },
        {
          authRepository: fakeAuthRepository({
            audits,
            session: { issuedFromClaimCodeId: "claim_1", metadataJson: {} },
          }),
          findSiteByHost: async () => site(),
          findViewerAssertionAudience: async () => ({
            audience: "https://api.customer.example",
            id: "aud_1",
            organizationId: "org_1",
            origins: ["https://demo.ravi.page"],
            projectId: "proj_1",
            siteId: "site_1",
            status: "active",
            updatedAt: new Date("2026-09-16T12:00:00.000Z"),
          }),
          loadUsesSnapshot: async () => ({
            catalogSchemaVersion: 1,
            uses: [{ id: IDENTITY_ASSERTION_ACTION_ID, revision: 1 }],
          }),
        },
      );

      expect(Object.keys(result.output as object)).toEqual(["token"]);
      const token = (result.output as { token: string }).token;
      const jwks = await viewerAssertionJwks();
      const verified = await jwtVerify(token, createLocalJWKSet({ keys: jwks.keys }), {
        algorithms: ["ES256"],
        audience: "https://api.customer.example",
        issuer: "https://console.ravi.bot",
      });
      expect(verified.payload.sub).toBe("user_1");
      expect(verified.payload.raviUserId).toBe("user_1");
      expect(verified.payload.raviOrgId).toBe("org_1");
      expect(verified.payload.site).toBe("site_1");
      expect(verified.payload.project).toBe("proj_1");
      expect(verified.payload.actor).toBe("human_viewer");
      expect(verified.payload.exp! - verified.payload.iat!).toBe(60);
      expect(verified.payload).not.toHaveProperty("consoleUserId");
      expect(verified.payload).not.toHaveProperty("consoleOrgId");
      expect(JSON.stringify(result)).not.toContain("consoleUserId");
      expect(audits.at(-1)).toMatchObject({
        action: "pages.connector.exec.allowed",
        metadataJson: {
          actor: "human_viewer",
          audience: "https://api.customer.example",
          kid: "pages-viewer-assertion-1",
        },
      });
      expect(JSON.stringify(audits.at(-1))).not.toContain(token);
    } finally {
      if (previous === undefined) delete process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON;
      else process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON = previous;
      if (previousIssuer === undefined) delete process.env.RAVI_PAGES_VIEWER_ASSERTION_ISSUER;
      else process.env.RAVI_PAGES_VIEWER_ASSERTION_ISSUER = previousIssuer;
      resetViewerAssertionKeyCache();
    }
  });

  test("refuses viewer assertions for capture sessions, missing allowlist, unknown audiences, and foreign origins", async () => {
    const deny = async (
      overrides: Parameters<typeof execPagesConnector>[1],
      input: Partial<Parameters<typeof execPagesConnector>[0]> = {},
    ) => {
      try {
        await execPagesConnector(
          {
            host: "demo.ravi.page",
            id: IDENTITY_ASSERTION_ACTION_ID,
            input: { aud: "https://api.customer.example" },
            origin: "https://demo.ravi.page",
            pagesSession: SESSION,
            requestId: "req_deny",
            ...input,
          },
          {
            authRepository: fakeAuthRepository({
              session: { issuedFromClaimCodeId: "claim_1", metadataJson: {} },
            }),
            findSiteByHost: async () => site(),
            findViewerAssertionAudience: async () => ({
              audience: "https://api.customer.example",
              id: "aud_1",
              organizationId: "org_1",
              origins: ["https://demo.ravi.page"],
              projectId: "proj_1",
              siteId: "site_1",
              status: "active",
              updatedAt: new Date("2026-09-16T12:00:00.000Z"),
            }),
            loadUsesSnapshot: async () => ({
              catalogSchemaVersion: 1,
              uses: [{ id: IDENTITY_ASSERTION_ACTION_ID, revision: 1 }],
            }),
            ...overrides,
          },
        );
        throw new Error("expected denial");
      } catch (error) {
        expect(error).toBeInstanceOf(ConsoleApiError);
        return (error as ConsoleApiError).payload.error;
      }
    };

    expect(
      await deny({
        authRepository: fakeAuthRepository({
          session: { issuedFromClaimCodeId: null, metadataJson: { source: "pages.capture" } },
        }),
      }),
    ).toBe("viewer_assertion_actor_forbidden");
    expect(
      await deny({
        authRepository: fakeAuthRepository({
          session: { issuedFromClaimCodeId: null, metadataJson: {} },
        }),
      }),
    ).toBe("viewer_assertion_actor_forbidden");
    expect(
      await deny({
        loadUsesSnapshot: async () => ({
          catalogSchemaVersion: 1,
          uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
        }),
      }),
    ).toBe("connector_not_allowlisted");
    expect(await deny({ findViewerAssertionAudience: async () => null })).toBe("viewer_assertion_audience_unknown");
    expect(await deny({}, { origin: "https://other.ravi.page" })).toBe("viewer_assertion_origin_forbidden");
    expect(await deny({}, { origin: null })).toBe("viewer_assertion_origin_forbidden");
  });
});

describe("Pages connector Bases actions", () => {
  const VIEW_ID = "6e0b4f3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
  const ROW_ID = "0c7a4f3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
  const CHART_ID = "9d1c4f3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
  const BASE_ID = "5a2c4f3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
  const ALL_BASES_USES = [...BASES_CONNECTOR_ACTION_IDS].map((id) => ({ id, revision: 1 }));
  const HUMAN_SESSION = { id: "session_human", issuedFromClaimCodeId: "claim_1", metadataJson: {} };

  type Recorded = { name: keyof PagesConnectorBasesServices; caller: BasesCaller; input: Record<string, unknown> };

  function fakeBases(recorded: Recorded[], overrides: Partial<PagesConnectorBasesServices> = {}): PagesConnectorBasesServices {
    const row = { rowId: ROW_ID, version: 4, values: { name: "Acme", status: "opt_won" }, body: null, archivedAt: null };
    return {
      describeView: async (caller, input) => {
        recorded.push({ name: "describeView", caller, input });
        return {
          id: VIEW_ID,
          baseId: BASE_ID,
          name: "Pipeline",
          description: null,
          layout: { type: "table" },
          version: 3,
          columns: [{ key: "name", name: "Name", type: "text", config: {}, required: true }],
          capabilities: { read: true, aggregateOnly: false, writeColumns: ["status"], create: false, archive: false, manage: false, approve: [] },
          valid: true,
        };
      },
      queryView: async (caller, input) => {
        recorded.push({ name: "queryView", caller, input });
        return { columns: ["name", "status"], rows: [row], nextCursor: "cursor_2", users: {} };
      },
      createRow: async (caller, input) => {
        recorded.push({ name: "createRow", caller, input });
        return { row: { ...row, version: 1 }, users: {}, idempotentReplay: false };
      },
      updateRow: async (caller, input) => {
        recorded.push({ name: "updateRow", caller, input });
        return { row, users: { user_9: { id: "user_9", displayName: "Nine", avatarUrl: null } }, idempotentReplay: false };
      },
      getRow: async (caller, input) => {
        recorded.push({ name: "getRow", caller, input });
        return { row, users: { user_9: { id: "user_9", displayName: "Nine", avatarUrl: null } }, idempotentReplay: false };
      },
      archiveRow: async (caller, input) => {
        recorded.push({ name: "archiveRow", caller, input });
        return { row: { ...row, version: 5, values: {} }, users: {}, idempotentReplay: false };
      },
      chartData: async (caller, input) => {
        recorded.push({ name: "chartData", caller, input });
        return {
          chart: { id: CHART_ID, baseId: BASE_ID, viewId: VIEW_ID, name: "By status", description: null, spec: { mark: "bar", encoding: {} }, version: 1 },
          fields: {},
          data: [{ x: "opt_won", y: 6 }],
          suppressedGroups: 2,
          users: {},
        };
      },
      viewVersion: async (caller, input) => {
        recorded.push({ name: "viewVersion", caller, input });
        return { fingerprint: "0123456789abcdef0123456789abcdef" };
      },
      ...overrides,
    };
  }

  function basesDeps(recorded: Recorded[], overrides: PagesConnectorHostDeps = {}): PagesConnectorHostDeps {
    return {
      authRepository: fakeAuthRepository({ session: HUMAN_SESSION }),
      bases: fakeBases(recorded),
      basesFeatureEnabled: async () => true,
      findSiteByHost: async () => site(),
      findUserEmail: async () => "Viewer@Example.COM",
      insertAudit: async () => {},
      loadUsesSnapshot: async () => ({ catalogSchemaVersion: 1, uses: ALL_BASES_USES }),
      ...overrides,
    };
  }

  async function execError(
    id: string,
    input: unknown,
    deps: PagesConnectorHostDeps,
    extra: { origin?: string | null } = {},
  ): Promise<{ status: number; error: string }> {
    const { status, body } = await execErrorBody(id, input, deps, extra);
    // Denials and errors without details keep the `{ error }` body.
    expect(Object.keys(body)).toEqual(["error"]);
    return { status, error: body.error };
  }

  async function execErrorBody(
    id: string,
    input: unknown,
    deps: PagesConnectorHostDeps,
    extra: { origin?: string | null } = {},
  ): Promise<{ status: number; body: ReturnType<typeof pagesConnectorExecErrorBody> }> {
    try {
      await execPagesConnector(
        {
          host: "demo.ravi.page",
          id,
          input,
          origin: "origin" in extra ? extra.origin : "https://demo.ravi.page",
          pagesSession: SESSION,
          requestId: "req_bases_deny",
        },
        deps,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      const apiError = error as ConsoleApiError;
      return { status: apiError.status, body: pagesConnectorExecErrorBody(apiError) };
    }
    throw new Error("expected a denial");
  }

  const createInput = { viewId: VIEW_ID, values: { name: "Ada" }, idempotencyKey: "form-submit-0001" };
  const updateInput = { viewId: VIEW_ID, rowId: ROW_ID, values: { status: "Won" }, expectedVersion: 3, idempotencyKey: "row-edit-00001" };
  const getInput = { viewId: VIEW_ID, rowId: ROW_ID };
  const archiveInput = { viewId: VIEW_ID, rowId: ROW_ID, expectedVersion: 4 };
  const inputFor = (id: string): Record<string, unknown> =>
    id === BASES_VIEWS_ROWS_CREATE_ACTION_ID
      ? createInput
      : id === BASES_VIEWS_ROWS_UPDATE_ACTION_ID
        ? updateInput
        : id === BASES_VIEWS_ROWS_GET_ACTION_ID
          ? getInput
          : id === BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID
            ? archiveInput
            : id === BASES_CHARTS_DATA_ACTION_ID
              ? { chartId: CHART_ID }
              : { viewId: VIEW_ID };

  test("dispatches every action as the Pages viewer of this site in the site's project", async () => {
    const recorded: Recorded[] = [];
    const audits: Array<{ action: string; metadataJson: Record<string, unknown> }> = [];
    const deps = basesDeps(recorded, {
      insertAudit: async (input) => {
        audits.push(input);
      },
    });
    const exec = (id: string, input: unknown) =>
      execPagesConnector(
        { host: "demo.ravi.page", id, input, origin: "https://demo.ravi.page", pagesSession: SESSION, requestId: `req_${id}` },
        deps,
      );

    const described = await exec(BASES_VIEWS_DESCRIBE_ACTION_ID, { viewId: VIEW_ID });
    expect(described).toMatchObject({ ok: true, id: BASES_VIEWS_DESCRIBE_ACTION_ID, revision: 1 });
    expect(described.output).toMatchObject({ id: VIEW_ID, name: "Pipeline", columns: [{ key: "name" }] });
    expect((described.output as { capabilities: object }).capabilities).not.toHaveProperty("manage");

    const queried = await exec(BASES_VIEWS_QUERY_ACTION_ID, {
      viewId: VIEW_ID,
      filter: { prop: "status", op: "eq", value: "Won" },
      sort: [{ prop: "name", dir: "desc" }],
      limit: 10,
    });
    expect(queried.output).toEqual({
      columns: ["name", "status"],
      rows: [{ rowId: ROW_ID, version: 4, values: { name: "Acme", status: "opt_won" }, body: null }],
      nextCursor: "cursor_2",
      users: {},
    });

    expect((await exec(BASES_VIEWS_ROWS_GET_ACTION_ID, getInput)).output).toEqual({
      rowId: ROW_ID,
      version: 4,
      values: { name: "Acme", status: "opt_won" },
      body: null,
      users: { user_9: { id: "user_9", displayName: "Nine", avatarUrl: null } },
    });
    expect((await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, createInput)).output).toEqual({ rowId: ROW_ID, version: 1 });
    expect((await exec(BASES_VIEWS_ROWS_UPDATE_ACTION_ID, updateInput)).output).toEqual({
      rowId: ROW_ID,
      version: 4,
      values: { name: "Acme", status: "opt_won" },
      body: null,
    });
    expect((await exec(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID, archiveInput)).output).toEqual({ rowId: ROW_ID, version: 5 });
    expect((await exec(BASES_CHARTS_DATA_ACTION_ID, { chartId: CHART_ID })).output).toEqual({
      chart: { id: CHART_ID, baseId: BASE_ID, viewId: VIEW_ID, name: "By status", description: null, spec: { mark: "bar", encoding: {} }, version: 1 },
      groups: [{ x: "opt_won", y: 6 }],
      fields: {},
      suppressedGroups: 2,
      users: {},
    });

    expect(recorded.map((item) => item.name)).toEqual([
      "describeView",
      "queryView",
      "getRow",
      "createRow",
      "updateRow",
      "archiveRow",
      "chartData",
    ]);
    for (const item of recorded) {
      expect(item.caller).toMatchObject({
        organizationId: "org_1",
        user: { id: "user_1", email: "viewer@example.com" },
        orgRole: "developer",
        actorType: "user",
        actorId: "user_1",
        surface: "page",
        source: { kind: "pages_session", id: "session_human" },
        pageSiteId: "site_1",
        localInstallationId: null,
        clientHint: null,
      });
      expect(item.input.projectId).toBe("proj_1");
    }
    expect(recorded[1]!.input).toEqual({
      projectId: "proj_1",
      viewId: VIEW_ID,
      filter: { prop: "status", op: "eq", value: "Won" },
      sort: [{ prop: "name", dir: "desc" }],
      limit: 10,
    });
    expect(recorded[2]!.input).toEqual({ projectId: "proj_1", ...getInput });
    expect(recorded[3]!.input).toEqual({ projectId: "proj_1", ...createInput });
    expect(recorded[4]!.input).toEqual({ projectId: "proj_1", ...updateInput });
    expect(recorded[4]!.input).not.toHaveProperty("lastWriteWins");
    expect(recorded[5]!.input).toEqual({ projectId: "proj_1", ...archiveInput });
    expect(recorded[5]!.input).not.toHaveProperty("lastWriteWins");
    expect(recorded[6]!.input).toEqual({ projectId: "proj_1", chartId: CHART_ID });
    expect(audits.filter((audit) => audit.action === "pages.connector.exec.allowed")).toHaveLength(7);
  });

  test("version returns the fingerprint and query passes search through", async () => {
    const recorded: Recorded[] = [];
    const deps = basesDeps(recorded);
    const exec = (id: string, input: unknown) =>
      execPagesConnector(
        { host: "demo.ravi.page", id, input, origin: "https://demo.ravi.page", pagesSession: SESSION, requestId: `req_${id}` },
        deps,
      );
    const version = await exec(BASES_VIEWS_VERSION_ACTION_ID, { viewId: VIEW_ID });
    expect(version).toMatchObject({ ok: true, id: BASES_VIEWS_VERSION_ACTION_ID, revision: 1 });
    expect(version.output).toEqual({ fingerprint: "0123456789abcdef0123456789abcdef" });
    await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: VIEW_ID, search: "acme" });
    expect(recorded.map((item) => item.name)).toEqual(["viewVersion", "queryView"]);
    expect(recorded[0]!.input).toEqual({ projectId: "proj_1", viewId: VIEW_ID });
    expect(recorded[0]!.caller).toMatchObject({ surface: "page", user: { id: "user_1" } });
    expect(recorded[1]!.input).toMatchObject({ projectId: "proj_1", viewId: VIEW_ID, search: "acme" });
  });

  test("are refused when the release does not declare them in uses", async () => {
    const recorded: Recorded[] = [];
    for (const snapshot of [null, { catalogSchemaVersion: 1, uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }] }]) {
      const denied = await execError(
        BASES_VIEWS_QUERY_ACTION_ID,
        { viewId: VIEW_ID },
        basesDeps(recorded, { loadUsesSnapshot: async () => snapshot }),
      );
      expect(denied).toEqual({ status: 403, error: "connector_not_allowlisted" });
    }
    expect(recorded).toEqual([]);
  });

  test("refuse capture, unscoped, password, and foreign-site sessions", async () => {
    const recorded: Recorded[] = [];
    const sessions = [
      { issuedFromClaimCodeId: null, metadataJson: { source: "pages.capture" } },
      { issuedFromClaimCodeId: "claim_1", metadataJson: { source: "pages.capture" } },
      { issuedFromClaimCodeId: null, metadataJson: {} },
      { issuedFromClaimCodeId: "claim_1", metadataJson: { source: "operator" } },
    ];
    for (const session of sessions) {
      for (const id of BASES_CONNECTOR_ACTION_IDS) {
        expect(
          await execError(id, inputFor(id), basesDeps(recorded, { authRepository: fakeAuthRepository({ session }) })),
        ).toEqual({ status: 403, error: "connector_permission_required" });
      }
    }
    // A password-visitor token is not a Pages session.
    expect(
      await execError(
        BASES_VIEWS_QUERY_ACTION_ID,
        { viewId: VIEW_ID },
        basesDeps(recorded, { authRepository: fakeAuthRepository({ missingSession: true }) }),
      ),
    ).toEqual({ status: 401, error: "connector_unauthorized" });
    // A session issued for another site or project never verifies for this host.
    for (const session of [
      { ...HUMAN_SESSION, siteId: "site_2" },
      { ...HUMAN_SESSION, projectId: "proj_2" },
      { ...HUMAN_SESSION, organizationId: "org_2" },
    ]) {
      expect(
        await execError(
          BASES_VIEWS_QUERY_ACTION_ID,
          { viewId: VIEW_ID },
          basesDeps(recorded, { authRepository: fakeAuthRepository({ session }) }),
        ),
      ).toEqual({ status: 401, error: "connector_unauthorized" });
    }
    expect(recorded).toEqual([]);
  });

  test("writes require an exact Origin match; reads do not", async () => {
    const recorded: Recorded[] = [];
    for (const origin of [null, "", "https://other.ravi.page", "https://demo.ravi.page.evil.example", "http://demo.ravi.page", "https://demo.ravi.page:8443", "null"]) {
      expect(await execError(BASES_VIEWS_ROWS_CREATE_ACTION_ID, createInput, basesDeps(recorded), { origin })).toEqual({
        status: 401,
        error: "connector_unauthorized",
      });
      expect(await execError(BASES_VIEWS_ROWS_UPDATE_ACTION_ID, updateInput, basesDeps(recorded), { origin })).toEqual({
        status: 401,
        error: "connector_unauthorized",
      });
      expect(await execError(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID, archiveInput, basesDeps(recorded), { origin })).toEqual({
        status: 401,
        error: "connector_unauthorized",
      });
    }
    expect(recorded).toEqual([]);

    const get = await execPagesConnector(
      { host: "demo.ravi.page", id: BASES_VIEWS_ROWS_GET_ACTION_ID, input: getInput, pagesSession: SESSION, requestId: "req_get" },
      basesDeps(recorded),
    );
    expect(get.ok).toBe(true);

    const read = await execPagesConnector(
      { host: "demo.ravi.page", id: BASES_VIEWS_QUERY_ACTION_ID, input: { viewId: VIEW_ID }, pagesSession: SESSION, requestId: "req_read" },
      basesDeps(recorded),
    );
    expect(read.ok).toBe(true);
    const write = await execPagesConnector(
      {
        host: "Demo.Ravi.Page",
        id: BASES_VIEWS_ROWS_CREATE_ACTION_ID,
        input: createInput,
        origin: "https://demo.ravi.page",
        pagesSession: SESSION,
        requestId: "req_write",
      },
      basesDeps(recorded),
    );
    expect(write.output).toEqual({ rowId: ROW_ID, version: 1 });
  });

  test("bind the site project: no projectRef/projectId input, and service not_found passes through", async () => {
    const recorded: Recorded[] = [];
    expect(await execError(BASES_VIEWS_QUERY_ACTION_ID, { viewId: VIEW_ID, projectRef: "other" }, basesDeps(recorded))).toEqual({
      status: 400,
      error: "payload_invalid",
    });
    expect(await execError(BASES_VIEWS_DESCRIBE_ACTION_ID, { viewId: VIEW_ID, projectId: "proj_2" }, basesDeps(recorded))).toEqual({
      status: 400,
      error: "payload_invalid",
    });
    expect(recorded).toEqual([]);

    const audits: Array<{ action: string; metadataJson: Record<string, unknown> }> = [];
    const notFound = await execError(
      BASES_VIEWS_QUERY_ACTION_ID,
      { viewId: VIEW_ID },
      basesDeps(recorded, {
        bases: fakeBases(recorded, {
          queryView: async (caller, input) => {
            recorded.push({ name: "queryView", caller, input });
            throw new ConsoleApiError(404, { error: "not_found" });
          },
        }),
        insertAudit: async (input) => {
          audits.push(input);
        },
      }),
    );
    expect(notFound).toEqual({ status: 404, error: "not_found" });
    expect(recorded.map((item) => item.input.projectId)).toEqual(["proj_1"]);
    expect(audits.at(-1)).toMatchObject({
      action: "pages.connector.exec.denied",
      metadataJson: { actionId: BASES_VIEWS_QUERY_ACTION_ID, outcome: "not_found" },
    });
  });

  test("require the console.bases feature", async () => {
    const recorded: Recorded[] = [];
    const features: unknown[] = [];
    expect(
      await execError(
        BASES_VIEWS_ROWS_CREATE_ACTION_ID,
        createInput,
        basesDeps(recorded, {
          basesFeatureEnabled: async (input) => {
            features.push(input);
            return false;
          },
        }),
      ),
    ).toEqual({ status: 403, error: "connector_permission_required" });
    expect(features).toEqual([{ organizationId: "org_1", role: "developer" }]);
    expect(recorded).toEqual([]);
  });

  test("catalog marks Bases actions executable only for human viewer sessions", async () => {
    const catalog = async (session: Record<string, unknown>) =>
      getPagesConnectorCatalog(
        { host: "demo.ravi.page", pagesSession: SESSION, requestId: "req_catalog_bases" },
        {
          authRepository: fakeAuthRepository({ session }),
          findSiteByHost: async () => site(),
          loadUsesSnapshot: async () => ({
            catalogSchemaVersion: 1,
            uses: [...ALL_BASES_USES, { id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
          }),
        },
      );

    const human = await catalog(HUMAN_SESSION);
    expect(human.actions.map((action) => [action.id, action.executable])).toEqual([
      [PAGES_SITES_LIST_ACTION_ID, true],
      [BASES_VIEWS_DESCRIBE_ACTION_ID, true],
      [BASES_VIEWS_QUERY_ACTION_ID, true],
      [BASES_VIEWS_VERSION_ACTION_ID, true],
      [BASES_VIEWS_ROWS_GET_ACTION_ID, true],
      [BASES_VIEWS_ROWS_CREATE_ACTION_ID, true],
      [BASES_VIEWS_ROWS_UPDATE_ACTION_ID, true],
      [BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID, true],
      [BASES_CHARTS_DATA_ACTION_ID, true],
      [PAGES_THEME_GET_ACTION_ID, true],
    ]);
    const capture = await catalog({ issuedFromClaimCodeId: null, metadataJson: { source: "pages.capture" } });
    expect(capture.actions.filter((action) => action.executable).map((action) => action.id)).toEqual([
      PAGES_SITES_LIST_ACTION_ID,
      PAGES_THEME_GET_ACTION_ID,
    ]);
    for (const id of [BASES_VIEWS_ROWS_CREATE_ACTION_ID, BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID]) {
      expect(human.actions.find((action) => action.id === id)).toMatchObject({
        class: "write",
        requiredRoles: [],
        requiredScopes: ["console.bases.write"],
      });
    }
    expect(human.actions.find((action) => action.id === BASES_VIEWS_ROWS_GET_ACTION_ID)).toMatchObject({
      class: "read",
      requiredScopes: ["console.bases.read"],
    });
  });

  test("catalog actions carry only the public fields; backedBy never leaves the Console", async () => {
    const publicFields = [
      "allowlisted",
      "auth",
      "class",
      "description",
      "executable",
      "id",
      "inputSchema",
      "missingSession",
      "outputSchema",
      "providerId",
      "requiredRoles",
      "requiredScopes",
      "requiresStepUp",
      "revision",
      "status",
      "title",
    ];
    const uses = [
      ...ALL_BASES_USES,
      ...[
        PROJECTS_LIST_ACTION_ID,
        PAGES_SITES_LIST_ACTION_ID,
        PAGES_PUBLISHED_LIST_ACTION_ID,
        IDENTITY_ASSERTION_ACTION_ID,
        PAGES_THEME_GET_ACTION_ID,
      ].map((id) => ({ id, revision: 1 })),
    ];
    const catalog = (pagesSession: string | null) =>
      getPagesConnectorCatalog(
        { host: "demo.ravi.page", pagesSession, requestId: "req_catalog_public" },
        {
          authRepository: fakeAuthRepository({ session: HUMAN_SESSION }),
          findSiteByHost: async () => site(),
          loadUsesSnapshot: async () => ({ catalogSchemaVersion: 1, uses }),
        },
      );

    for (const result of [await catalog(null), await catalog(SESSION)]) {
      expect(result.actions).toHaveLength(uses.length);
      for (const action of result.actions) expect(Object.keys(action).sort()).toEqual(publicFields);
      expect(JSON.stringify(result)).not.toContain("backedBy");
    }
  });

  test("error bodies carry validation_failed fieldErrors and version_conflict current, and nothing else", async () => {
    const recorded: Recorded[] = [];
    const audits: Array<{ action: string; metadataJson: Record<string, unknown> }> = [];
    const current = { rowId: ROW_ID, version: 7, values: { status: "opt_open" }, body: null };
    const failing = (error: ConsoleApiError) => async () => {
      throw error;
    };
    const run = (id: string, error: ConsoleApiError) =>
      execErrorBody(
        id,
        inputFor(id),
        basesDeps(recorded, {
          bases: fakeBases(recorded, {
            createRow: failing(error),
            updateRow: failing(error),
            archiveRow: failing(error),
            getRow: failing(error),
          }),
          insertAudit: async (input) => {
            audits.push(input);
          },
        }),
      );
    const apiError = (status: number, body: Record<string, unknown>) =>
      new ConsoleApiError(status, body as unknown as ConsoleApiError["payload"]);

    const fieldErrors = { email: "Enter a valid email address.", name: "This property is required." };
    expect(
      await run(BASES_VIEWS_ROWS_CREATE_ACTION_ID, apiError(400, { error: "validation_failed", fieldErrors, reason: "internal detail" })),
    ).toEqual({ status: 400, body: { error: "validation_failed", fieldErrors } });
    expect(await run(BASES_VIEWS_ROWS_UPDATE_ACTION_ID, apiError(400, { error: "validation_failed", fieldErrors }))).toEqual({
      status: 400,
      body: { error: "validation_failed", fieldErrors },
    });

    const conflict = { error: "version_conflict", reason: "The row changed since it was read.", current: { ...current, archivedAt: null, extra: "x" } };
    for (const id of [BASES_VIEWS_ROWS_UPDATE_ACTION_ID, BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID]) {
      expect(await run(id, apiError(409, conflict))).toEqual({ status: 409, body: { error: "version_conflict", current } });
    }

    // Other codes, and details that do not match their code or shape, stay `{ error }`.
    for (const [id, status, body] of [
      [BASES_VIEWS_ROWS_GET_ACTION_ID, 404, { error: "not_found" }],
      [BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID, 403, { error: "base_forbidden", reason: "This view does not grant this write." }],
      [BASES_VIEWS_ROWS_CREATE_ACTION_ID, 400, { error: "payload_invalid", reason: "values: bad", fieldErrors: { values: "bad" } }],
      [BASES_VIEWS_ROWS_UPDATE_ACTION_ID, 409, { error: "write_escapes_view", current }],
      [BASES_VIEWS_ROWS_CREATE_ACTION_ID, 400, { error: "validation_failed", fieldErrors: { email: 42 } }],
      [BASES_VIEWS_ROWS_CREATE_ACTION_ID, 400, { error: "validation_failed", fieldErrors: {} }],
      [BASES_VIEWS_ROWS_UPDATE_ACTION_ID, 409, { error: "version_conflict", current: { values: {} } }],
    ] as const) {
      expect(await run(id, apiError(status, body))).toEqual({ status, body: { error: body.error } });
    }

    const denied = audits.filter((audit) => audit.action === "pages.connector.exec.denied");
    expect(denied.map((audit) => audit.metadataJson.outcome)).toContain("validation_failed");
    for (const audit of denied) {
      expect(audit.metadataJson).not.toHaveProperty("fieldErrors");
      expect(audit.metadataJson).not.toHaveProperty("current");
    }
  });

  test("other connectors keep the { error } body even when the error carries details", async () => {
    try {
      await execPagesConnector(
        { host: "demo.ravi.page", id: PAGES_SITES_LIST_ACTION_ID, input: {}, pagesSession: SESSION, requestId: "req_sites_err" },
        {
          authRepository: fakeAuthRepository(),
          findSiteByHost: async () => site(),
          insertAudit: async () => {},
          loadUsesSnapshot: async () => ({ catalogSchemaVersion: 1, uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }] }),
          listPageSitesForProject: async () => {
            throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { slug: "taken" } });
          },
        },
      );
      throw new Error("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect(pagesConnectorExecErrorBody(error as ConsoleApiError)).toEqual({ error: "validation_failed" });
    }
  });
});

describe("Pages connector ravi.pages.theme.get", () => {
  const THEME = { hash: "b".repeat(64), css: "@layer ravi.theme, ravi.pieces;", locale: "pt-BR", version: 2, ref: "org/marca" };
  const SITES_ONLY = { catalogSchemaVersion: 1, uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }] };

  const exec = (deps: PagesConnectorHostDeps, input: { pagesSession?: string | null; input?: unknown } = {}) =>
    execPagesConnector(
      {
        host: "demo.ravi.page",
        id: PAGES_THEME_GET_ACTION_ID,
        input: input.input ?? {},
        pagesSession: input.pagesSession === undefined ? SESSION : input.pagesSession,
        requestId: "req_theme",
      },
      {
        authRepository: fakeAuthRepository(),
        findSiteByHost: async () => site(),
        insertAudit: async () => {},
        loadUsesSnapshot: async () => SITES_ONLY,
        ...deps,
      },
    );

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      throw new Error("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      return { status: (error as ConsoleApiError).status, error: (error as ConsoleApiError).payload.error };
    }
  };

  test("runs for the site's project without being in the release uses, and audits the exec", async () => {
    const resolved: unknown[] = [];
    const audits: Array<{ action: string; metadataJson: Record<string, unknown> }> = [];
    for (const snapshot of [SITES_ONLY, { catalogSchemaVersion: 1, uses: [] }, null]) {
      const result = await exec({
        loadUsesSnapshot: async () => snapshot,
        resolvePagesTheme: async (input) => {
          resolved.push(input);
          return THEME;
        },
        insertAudit: async (input) => {
          audits.push(input);
        },
      });
      expect(result).toEqual({ ok: true, id: PAGES_THEME_GET_ACTION_ID, revision: 1, output: THEME });
    }
    expect(resolved).toEqual(Array(3).fill({ organizationId: "org_1", projectId: "proj_1" }));
    expect(audits.at(-1)).toMatchObject({
      action: "pages.connector.exec.allowed",
      metadataJson: { actionId: PAGES_THEME_GET_ACTION_ID, outcome: "ok", revision: 1 },
    });
    expect(JSON.stringify(audits)).not.toContain(THEME.css);

    const none = await exec({ loadUsesSnapshot: async () => SITES_ONLY, resolvePagesTheme: async () => ({ none: true }) });
    expect(none.output).toEqual({ none: true });
  });

  test("follows the session rules of the other platform reads, not the Bases ones", async () => {
    let calls = 0;
    const resolvePagesTheme = async () => {
      calls += 1;
      return THEME;
    };
    expect(await errorOf(exec({ resolvePagesTheme }, { pagesSession: null }))).toEqual({ status: 401, error: "connector_session_required" });
    expect(await errorOf(exec({ resolvePagesTheme, authRepository: fakeAuthRepository({ missingSession: true }) }))).toEqual({
      status: 401,
      error: "connector_unauthorized",
    });
    expect(calls).toBe(0);
    // A capture session (thumbnails) is refused by Bases actions but reads the theme like sites.list.
    const capture = fakeAuthRepository({ session: { issuedFromClaimCodeId: null, metadataJson: { source: "pages.capture" } } });
    expect((await exec({ resolvePagesTheme, authRepository: capture })).output).toEqual(THEME);
    expect(calls).toBe(1);
  });

  test("takes a strict empty input and projects the output through its schema", async () => {
    expect(await errorOf(exec({ resolvePagesTheme: async () => THEME }, { input: { projectRef: "other" } }))).toEqual({
      status: 400,
      error: "payload_invalid",
    });
    const leaky = async () => ({ ...THEME, files: [{ path: "theme.json", content: "{}" }] }) as unknown as typeof THEME;
    expect(await errorOf(exec({ resolvePagesTheme: leaky }))).toEqual({ status: 503, error: "connector_unavailable" });
  });

  test("a snapshot that lists it keeps its own revision, so a stale one fails closed", async () => {
    const stale = { catalogSchemaVersion: 1, uses: [{ id: PAGES_THEME_GET_ACTION_ID, revision: 2 }] };
    expect(await errorOf(exec({ loadUsesSnapshot: async () => stale, resolvePagesTheme: async () => THEME }))).toEqual({
      status: 400,
      error: "connector_capability_unsupported",
    });
  });

  test("the catalog lists it as allowlisted next to the release uses", async () => {
    const result = await getPagesConnectorCatalog(
      { host: "demo.ravi.page", pagesSession: SESSION, requestId: "req_theme_catalog" },
      { authRepository: fakeAuthRepository(), findSiteByHost: async () => site(), loadUsesSnapshot: async () => SITES_ONLY },
    );
    expect(result.actions.map((action) => [action.id, action.allowlisted, action.executable])).toEqual([
      [PAGES_SITES_LIST_ACTION_ID, true, true],
      [PAGES_THEME_GET_ACTION_ID, true, true],
    ]);
  });
});

describe("ravi.knowledge.search site built-in", () => {
  const searchOutput = {
    results: [{ path: "/trocas", url: "https://demo.ravi.page/trocas#prazo", anchor: "prazo", heading: "Prazo", text: "30 dias." }],
    issues: [],
  };
  // A guest: a human_viewer session (issued from a claim code) of someone outside the org.
  const guestRepository = (audits?: unknown[]) =>
    fakeAuthRepository({ audits, membership: null, session: { issuedFromClaimCodeId: "claim_1", userId: "guest_1" } });

  function knowledgeDeps(overrides: Partial<PagesConnectorHostDeps> = {}) {
    const searches: unknown[] = [];
    const deps: PagesConnectorHostDeps = {
      authRepository: fakeAuthRepository(),
      findSiteByHost: async () => site(),
      // The release allowlists nothing: the built-in must not depend on `uses`.
      loadUsesSnapshot: async () => ({ catalogSchemaVersion: 1, uses: [] }),
      insertAudit: async () => {},
      isRateLimited: () => false,
      pageChatEnabled: async () => true,
      searchMarkedPages: async (input) => {
        searches.push(input);
        return searchOutput;
      },
      ...overrides,
    };
    return { deps, searches };
  }

  const exec = (deps: PagesConnectorHostDeps, id = KNOWLEDGE_SEARCH_ACTION_ID, input: unknown = { query: "prazo de troca" }) =>
    execPagesConnector({ host: "demo.ravi.page", id, input, pagesSession: SESSION, requestId: "req_knowledge" }, deps);

  test("a member runs it without the uses allowlist", async () => {
    const { deps, searches } = knowledgeDeps();
    const result = await exec(deps);
    expect(result).toEqual({ ok: true, id: KNOWLEDGE_SEARCH_ACTION_ID, revision: 1, output: searchOutput });
    expect(searches).toEqual([
      {
        site: site(),
        viewer: { kind: "member", userId: "user_1", workspace: expect.objectContaining({ user: { id: "user_1" } }) },
        query: "prazo de troca",
        limit: 4,
        requestId: "req_knowledge",
      },
    ]);
  });

  test("is refused when Page Chat is off for the site", async () => {
    const audits: Array<{ metadataJson: Record<string, unknown> }> = [];
    const { deps, searches } = knowledgeDeps({
      pageChatEnabled: async () => false,
      insertAudit: async (input) => {
        audits.push(input as { metadataJson: Record<string, unknown> });
      },
    });
    await expect(exec(deps)).rejects.toMatchObject({ status: 403, payload: { error: "page_chat_disabled_for_site" } });
    expect(searches).toEqual([]);
    expect(audits.at(-1)?.metadataJson).toMatchObject({ outcome: "page_chat_disabled_for_site" });
  });

  test("a guest reaches it instead of the 401 connector_unauthorized", async () => {
    const audits: Array<{ metadataJson: Record<string, unknown> }> = [];
    const { deps, searches } = knowledgeDeps({
      authRepository: guestRepository(),
      insertAudit: async (input) => {
        audits.push(input as { metadataJson: Record<string, unknown> });
      },
    });
    const result = await exec(deps);
    expect(result.output).toEqual(searchOutput);
    expect(searches).toEqual([
      { site: site(), viewer: { kind: "guest", userId: "guest_1" }, query: "prazo de troca", limit: 4, requestId: "req_knowledge" },
    ]);
    // The audit row carries ids and the outcome, never the query.
    expect(JSON.stringify(audits)).not.toContain("prazo de troca");
    expect(audits.at(-1)?.metadataJson).toMatchObject({ outcome: "ok", audience: "guest" });
  });

  test("a guest calling any other action still gets 401 connector_unauthorized", async () => {
    for (const id of [BASES_VIEWS_QUERY_ACTION_ID, PAGES_SITES_LIST_ACTION_ID]) {
      const { deps } = knowledgeDeps({
        authRepository: guestRepository(),
        loadUsesSnapshot: async () => ({ catalogSchemaVersion: 1, uses: [{ id, revision: 1 }] }),
      });
      await expect(exec(deps, id, { viewId: "00000000-0000-4000-8000-000000000001" })).rejects.toMatchObject({
        status: 401,
        payload: { error: "connector_unauthorized" },
      });
    }
  });

  test("no viewer at all is 401 connector_unauthorized", async () => {
    const { deps, searches } = knowledgeDeps({
      authRepository: fakeAuthRepository({ membership: null, session: { issuedFromClaimCodeId: null } }),
    });
    await expect(exec(deps)).rejects.toMatchObject({ status: 401, payload: { error: "connector_unauthorized" } });
    expect(searches).toEqual([]);
  });

  test("limits each viewer per site and validates input", async () => {
    const keys: string[] = [];
    const { deps } = knowledgeDeps({
      authRepository: guestRepository(),
      isRateLimited: (input) => {
        keys.push(`${input.key}|${input.limit}`);
        return true;
      },
    });
    await expect(exec(deps)).rejects.toMatchObject({ status: 429, payload: { error: "connector_rate_limited" } });
    expect(keys).toEqual([`pages-knowledge:site_1:guest_1|${PAGES_KNOWLEDGE_SEARCH_LIMIT.perViewer}`]);
    expect(PAGES_KNOWLEDGE_SEARCH_LIMIT.perViewer).toBe(30);

    const valid = knowledgeDeps();
    await expect(exec(valid.deps, KNOWLEDGE_SEARCH_ACTION_ID, { query: "" })).rejects.toMatchObject({
      status: 400,
      payload: { error: "payload_invalid" },
    });
    await expect(exec(valid.deps, KNOWLEDGE_SEARCH_ACTION_ID, { query: "x", limit: 9 })).rejects.toMatchObject({
      status: 400,
      payload: { error: "payload_invalid" },
    });
  });
});

function assertionSigningEnv() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    RAVI_PAGES_VIEWER_ASSERTION_ISSUER: "https://console.ravi.bot",
    RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON: JSON.stringify([
      {
        alg: "ES256",
        kid: "pages-viewer-assertion-1",
        pkcs8Pem: pem,
        status: "active",
      },
    ]),
  };
}

function site(): PagesConnectorSite {
  return {
    id: "site_1",
    organizationId: "org_1",
    projectId: "proj_1",
    defaultHostname: "demo.ravi.page",
    defaultVisibility: "private",
    status: "active",
    activeReleaseId: "release_1",
  };
}

function accessibleProject(overrides: { id?: string; slug?: string } = {}) {
  return {
    id: overrides.id ?? "proj_2",
    organizationId: "org_1",
    slug: overrides.slug ?? "hub",
    name: "Hub",
    description: null,
    status: "active" as const,
    defaultVisibility: "private" as const,
    metadataJson: {},
    createdAt: new Date("2026-09-16T12:00:00.000Z"),
    updatedAt: new Date("2026-09-16T12:00:00.000Z"),
  };
}

function pageSite(overrides: Partial<PageSite> = {}): PageSite {
  return {
    id: "site_1",
    organizationId: "org_1",
    projectId: "proj_1",
    slug: "demo",
    defaultHostname: "demo.ravi.page",
    defaultVisibility: "private",
    isDefault: false,
    status: "active",
    activeReleaseId: "release_1",
    createdByActorType: "user",
    createdByActorId: "user_1",
    metadataJson: {},
    createdAt: new Date("2026-09-16T12:00:00.000Z"),
    updatedAt: new Date("2026-09-16T12:00:00.000Z"),
    ...overrides,
  } as PageSite;
}

function fakeAuthRepository(
  options: {
    audits?: unknown[];
    membership?: { role: string; status: string } | null;
    missingSession?: boolean;
    session?: Partial<PagesSessionRecord>;
  } = {},
): PagesPrivateAuthRepository {
  return {
    async transaction() { throw new Error("unexpected_issuance"); },
    async assertBrowserSource() { throw new Error("unexpected_issuance"); },
    async findClaimCodeByHash() { return null; },
    async consumeClaimCode() {
      return null;
    },
    async findOrganizationMembership() {
      return options.membership === undefined ? { role: "developer", status: "active" } : options.membership;
    },
    async findSessionByHash() {
      if (options.missingSession) return null;
      return {
        id: "session_1",
        createdAt: new Date("2026-07-08T14:00:00.000Z"),
        expiresAt: new Date("2030-07-08T16:00:00.000Z"),
        issuedForHost: "demo.ravi.page",
        issuedFromClaimCodeId: null,
        lastRequestId: null,
        lastUsedAt: null,
        metadataJson: {},
        organizationId: "org_1",
        projectId: "proj_1",
        revokedAt: null,
        sessionTokenHash: "hash_1",
        siteId: "site_1",
        status: "active",
        updatedAt: new Date("2026-07-08T14:00:00.000Z"),
        userId: "user_1",
        ...options.session,
      };
    },
    async findSiteByHost() {
      return {
        id: "site_1",
        defaultHostname: "demo.ravi.page",
        defaultVisibility: "private",
        organizationId: "org_1",
        projectId: "proj_1",
        status: "active",
      };
    },
    async insertAudit(input) {
      options.audits?.push(input);
    },
    async insertClaimCode() {
      throw new Error("unexpected_claim_code");
    },
    async insertSession() {
      throw new Error("unexpected_session");
    },
    async markSessionExpired() {},
    async touchSession() {},
  };
}
