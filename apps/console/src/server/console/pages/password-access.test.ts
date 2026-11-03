import { afterEach, describe, expect, test } from "bun:test";
import { hash } from "@node-rs/argon2";

import {
  configurePagesPasswordPolicy,
  pagesPasswordAccessRepositoryForDb,
  verifyPagesPasswordAndCreateSession,
  verifyPagesPasswordSessionForRoute,
  type PagesPasswordAccessRepository,
  type PagesPasswordPolicyRecord,
  type PagesPasswordSessionRecord,
} from "./password-access";
import type { PagesPrivateAuthRepository } from "./auth";
import type { PagesRouteResolveRepository } from "./resolve";

const originalSessionSecret = process.env.RAVI_PAGES_AUTH_SESSION_SECRET;

afterEach(() => {
  if (originalSessionSecret === undefined) delete process.env.RAVI_PAGES_AUTH_SESSION_SECRET;
  else process.env.RAVI_PAGES_AUTH_SESSION_SECRET = originalSessionSecret;
});

describe("Ravi Pages password access", () => {
  test("stores Argon2id only and returns a safe policy projection", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-at-least-32-bytes";
    let storedHash = "";
    const repository = passwordRepository({
      async upsertPolicy(input) {
        storedHash = input.passwordHash;
        return policy({ passwordHash: input.passwordHash, routeId: "route_1" });
      },
    });
    const result = await configurePagesPasswordPolicy({
      host: "demo.ravi.page",
      pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456",
      password: "correct horse battery staple",
      path: "/report",
      requestId: "req_configure",
    }, {
      authRepository: privateAuthRepository(),
      // No policy DB here: an explicit exact-resource observation, not role inference.
      canAccessProject: async (workspace, projectId, action) =>
        workspace.user.id === "user_1" && projectId === "proj_1" && (action === "read" || action === "write"),
      passwordRepository: repository,
      routeRepository: routeRepository(),
    });

    expect(storedHash).toStartWith("$argon2id$");
    expect(storedHash).not.toContain("correct horse battery staple");
    expect(result).toEqual({
      configured: true,
      id: "policy_1",
      rotatedAt: "2026-08-03T12:00:00.000Z",
      scope: "route",
      status: "active",
      version: 1,
    });
    expect(JSON.stringify(result)).not.toContain("passwordHash");
  });

  test("creates an opaque host-scoped session only for the current password", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-at-least-32-bytes";
    const passwordHash = await hash("correct horse", { algorithm: 2, memoryCost: 4096, timeCost: 1 });
    let insertedHash = "";
    const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
    const repository = passwordRepository({
      async findPolicyForScope() {
        return policy({ passwordHash, routeId: "route_1", version: 3 });
      },
      async insertAudit(input) {
        audits.push({ action: input.action, metadata: input.metadataJson });
      },
      async insertSession(input) {
        insertedHash = input.sessionTokenHash;
        return session({
          expiresAt: input.expiresAt,
          issuedForHost: input.issuedForHost,
          policyVersion: input.policyVersion,
          sessionTokenHash: input.sessionTokenHash,
        });
      },
    });

    const denied = await verifyPagesPasswordAndCreateSession({
      host: "demo.ravi.page",
      password: "wrong password",
      path: "/report",
      requestId: "req_wrong",
    }, { passwordRepository: repository, routeRepository: routeRepository() });
    expect(denied).toBeNull();

    const allowed = await verifyPagesPasswordAndCreateSession({
      host: "demo.ravi.page",
      password: "correct horse",
      path: "/report",
      requestId: "req_right",
    }, { passwordRepository: repository, routeRepository: routeRepository() });
    expect(allowed?.sessionToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(insertedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(insertedHash).not.toBe(allowed?.sessionToken);
    expect(audits.map((audit) => audit.action)).toEqual([
      "pages.password_challenge.denied",
      "pages.password_challenge.allowed",
      "pages.password_session.created",
    ]);
    expect(JSON.stringify(audits)).not.toContain("correct horse");
    expect(JSON.stringify(audits)).not.toContain(passwordHash);
  });

  test("invalidates an existing session when the policy version rotates", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-at-least-32-bytes";
    const currentPolicy = policy({ routeId: "route_1", version: 4 });
    const staleSession = session({ policyVersion: 3 });
    let touched = false;
    const audits: string[] = [];
    const repository = passwordRepository({
      async findPolicyForScope() {
        return currentPolicy;
      },
      async findSessionByHash() {
        return staleSession;
      },
      async touchSession() {
        touched = true;
      },
      async insertAudit(input) {
        audits.push(input.action);
      },
    });

    const allowed = await verifyPagesPasswordSessionForRoute({
      host: "demo.ravi.page",
      requestId: "req_stale",
      routeId: "route_1",
      routeVisibility: "password",
      sessionToken: "passwordabcdefghijklmnopqrstuvwxyz123456",
      site: site(),
    }, repository);
    expect(allowed).toBe(false);
    expect(touched).toBe(false);
    expect(audits).toEqual(["pages.password_session.rejected"]);
  });

  test("does not let a site policy satisfy an explicitly password-protected route", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-at-least-32-bytes";
    const repository = passwordRepository({
      async findPolicyForScope(input) {
        expect(input.routeId).toBe("route_1");
        return policy({ routeId: null });
      },
      async findSessionByHash() {
        throw new Error("session lookup must not run without the exact route policy");
      },
    });

    const allowed = await verifyPagesPasswordSessionForRoute({
      host: "demo.ravi.page",
      requestId: "req_wrong_scope",
      routeId: "route_1",
      routeVisibility: "password",
      sessionToken: "passwordabcdefghijklmnopqrstuvwxyz123456",
      site: site(),
    }, repository);

    expect(allowed).toBe(false);
  });

  test("lets a site policy unlock a public route that inherits the site password mode", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-at-least-32-bytes";
    const sitePolicy = policy({ routeId: null });
    const siteSession = session({ routeId: null });
    const repository = passwordRepository({
      async findPolicyForScope(input) {
        expect(input.routeId).toBeNull();
        return sitePolicy;
      },
      async findSessionByHash() {
        return siteSession;
      },
    });

    const allowed = await verifyPagesPasswordSessionForRoute({
      host: "demo.ravi.page",
      requestId: "req_site_scope",
      routeId: "route_1",
      routeVisibility: "public",
      sessionToken: "passwordabcdefghijklmnopqrstuvwxyz123456",
      site: site({ defaultVisibility: "password" }),
    }, repository);

    expect(allowed).toBe(true);
  });

  test("database projections never select password hashes through session verification", async () => {
    const selectedTables: unknown[] = [];
    const database = {
      select() {
        return {
          from(table: unknown) {
            selectedTables.push(table);
            return this;
          },
          where() { return this; },
          orderBy() { return this; },
          limit() { return Promise.resolve([]); },
        };
      },
      insert() { throw new Error("not used"); },
      update() { throw new Error("not used"); },
    } as unknown as Parameters<typeof pagesPasswordAccessRepositoryForDb>[0];
    const repository = pagesPasswordAccessRepositoryForDb(database);
    expect(await repository.findSessionByHash("hash")).toBeNull();
    expect(selectedTables).toHaveLength(1);
  });
});

function policy(overrides: Partial<PagesPasswordPolicyRecord> = {}): PagesPasswordPolicyRecord {
  return {
    id: "policy_1",
    organizationId: "org_1",
    projectId: "proj_1",
    siteId: "site_1",
    routeId: null,
    passwordHash: "$argon2id$v=19$m=4096,t=1,p=1$test$test",
    version: 1,
    status: "active",
    configuredByUserId: "user_1",
    rotatedAt: new Date("2026-08-03T12:00:00.000Z"),
    disabledAt: null,
    createdAt: new Date("2026-08-03T12:00:00.000Z"),
    updatedAt: new Date("2026-08-03T12:00:00.000Z"),
    ...overrides,
  };
}

function session(overrides: Partial<PagesPasswordSessionRecord> = {}): PagesPasswordSessionRecord {
  return {
    id: "session_1",
    sessionTokenHash: "a".repeat(64),
    organizationId: "org_1",
    projectId: "proj_1",
    siteId: "site_1",
    routeId: "route_1",
    policyId: "policy_1",
    policyVersion: 1,
    status: "active",
    issuedForHost: "demo.ravi.page",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
    lastRequestId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function site(overrides: { defaultVisibility?: "public" | "password" } = {}) {
  return {
    id: "site_1",
    organizationId: "org_1",
    projectId: "proj_1",
    defaultHostname: "demo.ravi.page",
    defaultVisibility: overrides.defaultVisibility ?? "public",
    status: "active" as const,
  };
}

function routeRepository(): PagesRouteResolveRepository {
  return {
    async findSiteByHost() {
      return { ...site(), activeReleaseId: "release_1" };
    },
    async getActiveRelease() {
      return { id: "release_1", releaseNumber: 1, status: "active" };
    },
    async listReleaseRoutes() {
      return [{
        id: "binding_1",
        routeId: "route_1",
        path: "/report",
        matchType: "spa",
        priority: 0,
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        entrypoint: "index.html",
        assetBase: "/_ravi/assets/artifact_1/version_1/",
        visibility: "password",
      }];
    },
    async getArtifactVersionFile() {
      return null;
    },
  };
}

function privateAuthRepository(): PagesPrivateAuthRepository {
  return {
    async transaction() { throw new Error("unexpected_issuance"); },
    async assertBrowserSource() { throw new Error("unexpected_issuance"); },
    async findClaimCodeByHash() { return null; },
    async findSessionByHash() {
      return {
        id: "pages_session_1",
        sessionTokenHash: "hash",
        organizationId: "org_1",
        projectId: "proj_1",
        siteId: "site_1",
        userId: "user_1",
        status: "active",
        issuedForHost: "demo.ravi.page",
        issuedFromClaimCodeId: null,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        lastUsedAt: null,
        lastRequestId: null,
        metadataJson: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    async findOrganizationMembership() {
      return { role: "owner", status: "active" };
    },
    async touchSession() {},
    async insertAudit() {},
    async findSiteByHost() { return site(); },
    async consumeClaimCode() { return null; },
    async insertClaimCode() { throw new Error("not used"); },
    async insertSession() { throw new Error("not used"); },
    async markSessionExpired() {},
  };
}

function passwordRepository(
  overrides: Partial<PagesPasswordAccessRepository> = {},
): PagesPasswordAccessRepository {
  return {
    async disablePolicy() { return null; },
    async findPolicyForScope() { return null; },
    async findSessionByHash() { return null; },
    async insertAudit() {},
    async insertSession(input) { return session({ sessionTokenHash: input.sessionTokenHash }); },
    async markSessionExpired() {},
    async touchSession() {},
    async upsertPolicy(input) { return policy({ passwordHash: input.passwordHash }); },
    ...overrides,
  };
}
