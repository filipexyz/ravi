import { describe, expect, test } from "bun:test";

import {
  createPagesOperatorComment as createPagesOperatorCommentWithPolicy,
  deletePagesOperatorComment as deletePagesOperatorCommentWithPolicy,
  listPagesOperatorComments as listPagesOperatorCommentsWithPolicy,
  pagesOperatorReleases as pagesOperatorReleasesWithPolicy,
  releaseAuthor,
  type PagesOperatorCommentTarget,
} from "./operator";
import type { PagesPrivateAuthRepository } from "./auth";
import type { PagesRouteResolveOkResponse } from "./resolve";

process.env.RAVI_PAGES_AUTH_SESSION_SECRET ??= "test_pages_auth_secret_1234567890";

// Unit fixture has no policy DB. Supply an explicit exact-resource observation
// (read and write on proj_1 for user_1), not owner/admin inference.
type ProjectCheck = NonNullable<NonNullable<Parameters<typeof pagesOperatorReleasesWithPolicy>[1]>["canAccessProject"]>;
const fixtureAccess: ProjectCheck = async (workspace, projectId, action) =>
  workspace.organization.id === "org_1" && workspace.user.id === "user_1" && projectId === "proj_1" && action !== "admin";
function withPolicy<I, D extends { canAccessProject?: ProjectCheck }, R>(run: (input: I, deps?: D) => Promise<R>) {
  return (input: I, deps?: D) => run(input, { canAccessProject: fixtureAccess, ...deps } as D);
}
const createPagesOperatorComment = withPolicy(createPagesOperatorCommentWithPolicy);
const deletePagesOperatorComment = withPolicy(deletePagesOperatorCommentWithPolicy);
const listPagesOperatorComments = withPolicy(listPagesOperatorCommentsWithPolicy);
const pagesOperatorReleases = withPolicy(pagesOperatorReleasesWithPolicy);

describe("Pages operator comments", () => {
  test("creates comments after Pages session authorization and sanitizes the target", async () => {
    const audits: unknown[] = [];
    const created: unknown[] = [];
    const authRepository = fakeAuthRepository({ audits });
    const commentRepository = {
      async createComment(input: any) {
        created.push(input);
        return {
          id: "comment_1",
          body: input.body,
          path: input.path,
          status: "open" as const,
          targetJson: input.targetJson,
          metadataJson: input.metadataJson,
          createdAt: new Date("2026-07-08T15:00:00.000Z"),
          createdByUserId: input.createdByUserId,
          createdByDisplayName: null,
          releaseId: input.releaseId,
        };
      },
      async listOpenComments() {
        return [];
      },
      async findOpenComment() {
        return null;
      },
      async deleteComment() {
        return null;
      },
    };

    const result = await createPagesOperatorComment(
      {
        body: "  Check this heading  ",
        host: "demo.ravi.page",
        pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456",
        path: "/docs",
        requestId: "req_1",
        target: {
          ignored: "field",
          rect: { height: 20.444, width: 100.125, x: 10.555, y: 40.991 },
          selector: "main > h1",
          tag: "h1",
          text: "Important headline",
        },
      },
      {
        authRepository,
        commentRepository,
        resolveRoute: async () => okResolve(),
      },
    );

    expect(result.comment).toMatchObject({
      id: "comment_1",
      body: "Check this heading",
      path: "/docs",
      target: {
        rect: { height: 20.44, width: 100.13, x: 10.56, y: 40.99 },
        selector: "main > h1",
        tag: "h1",
        text: "Important headline",
      },
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      artifactId: "art_1",
      artifactVersionId: "ver_1",
      createdByUserId: "user_1",
      organizationId: "org_1",
      path: "/docs",
      projectId: "proj_1",
      releaseId: "release_1",
      releaseRouteId: "binding_1",
      routeId: "route_1",
      siteId: "site_1",
    });
    expect(audits).toHaveLength(2);
    expect(audits.at(-1)).toMatchObject({
      action: "page_comment.created",
      actorId: "user_1",
      organizationId: "org_1",
      projectId: "proj_1",
      requestId: "req_1",
      targetId: "comment_1",
      targetType: "page_comment",
    });
  });

  test("lists open comments for the authorized site and requested path", async () => {
    const listed: unknown[] = [];
    const result = await listPagesOperatorComments(
      {
        host: "demo.ravi.page",
        pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456",
        path: "/docs",
        requestId: "req_2",
      },
      {
        authRepository: fakeAuthRepository(),
        commentRepository: {
          async createComment() {
            throw new Error("unexpected_create");
          },
          async listOpenComments(input) {
            listed.push(input);
            return [
              {
                id: "comment_1",
                body: "Looks good",
                path: "/docs",
                status: "open" as const,
                targetJson: { selector: "main" } satisfies PagesOperatorCommentTarget,
                metadataJson: {},
                createdAt: new Date("2026-07-08T15:00:00.000Z"),
                createdByUserId: "user_1",
                createdByDisplayName: "Luis",
                releaseId: "release_1",
              },
            ];
          },
          async findOpenComment() {
            return null;
          },
          async deleteComment() {
            return null;
          },
        },
        resolveRoute: async () => okResolve(),
      },
    );

    expect(listed).toEqual([{ limit: 100, path: "/docs", siteId: "site_1" }]);
    expect(result.comments).toEqual([
      {
        id: "comment_1",
        author: { displayName: "Luis", id: "user_1" },
        body: "Looks good",
        createdAt: "2026-07-08T15:00:00.000Z",
        parentId: null,
        path: "/docs",
        release: { id: "release_1" },
        status: "open",
        target: { selector: "main" },
      },
    ]);
  });

  test("creates replies linked to an existing comment on the same path", async () => {
    const audits: unknown[] = [];
    const created: unknown[] = [];
    const parent = {
      id: "11111111-1111-4111-8111-111111111111",
      body: "Parent",
      path: "/docs",
      status: "open" as const,
      targetJson: { selector: "main > h2" } satisfies PagesOperatorCommentTarget,
      metadataJson: {},
      createdAt: new Date("2026-07-08T15:00:00.000Z"),
      createdByUserId: "user_2",
      createdByDisplayName: "Thiago",
      releaseId: "release_1",
    };

    const result = await createPagesOperatorComment(
      {
        body: "  resposta  ",
        host: "demo.ravi.page",
        pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456",
        parentId: parent.id,
        path: "/docs",
        requestId: "req_reply",
      },
      {
        authRepository: fakeAuthRepository({ audits }),
        commentRepository: {
          async createComment(input) {
            created.push(input);
            return {
              id: "22222222-2222-4222-8222-222222222222",
              body: input.body,
              path: input.path,
              status: "open" as const,
              targetJson: input.targetJson,
              metadataJson: input.metadataJson,
              createdAt: new Date("2026-07-08T15:01:00.000Z"),
              createdByUserId: input.createdByUserId,
              createdByDisplayName: "Luis",
              releaseId: input.releaseId,
            };
          },
          async listOpenComments() {
            return [];
          },
          async findOpenComment(input) {
            expect(input).toEqual({ commentId: parent.id, path: "/docs", siteId: "site_1" });
            return parent;
          },
          async deleteComment() {
            return null;
          },
        },
        resolveRoute: async () => okResolve(),
      },
    );

    expect(result.comment).toMatchObject({
      body: "resposta",
      parentId: parent.id,
      target: { selector: "main > h2" },
    });
    expect(created[0]).toMatchObject({
      metadataJson: { parentId: parent.id, requestId: "req_reply", source: "pages_operator_overlay" },
      targetJson: { selector: "main > h2" },
    });
    expect(audits.at(-1)).toMatchObject({
      action: "page_comment.replied",
      targetId: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("soft deletes comments after Pages session authorization and project write access", async () => {
    const audits: unknown[] = [];
    const deleted: unknown[] = [];
    const commentId = "018f6f4a-6f85-7cc2-9cbe-59f849e3a111";
    const existing = {
      id: commentId,
      body: "Remove me",
      path: "/docs",
      status: "open" as const,
      targetJson: { selector: "main > p" } satisfies PagesOperatorCommentTarget,
      metadataJson: { parentId: "11111111-1111-4111-8111-111111111111" },
      createdAt: new Date("2026-07-08T15:02:00.000Z"),
      createdByUserId: "user_2",
      createdByDisplayName: "Thiago",
      releaseId: "release_1",
    };

    const result = await deletePagesOperatorComment(
      {
        commentId,
        host: "demo.ravi.page",
        pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456",
        path: "/docs",
        requestId: "req_delete",
      },
      {
        authRepository: fakeAuthRepository({ audits }),
        commentRepository: {
          async createComment() {
            throw new Error("unexpected_create");
          },
          async listOpenComments() {
            return [];
          },
          async findOpenComment(input) {
            expect(input).toEqual({ commentId, path: "/docs", siteId: "site_1" });
            return existing;
          },
          async deleteComment(input) {
            deleted.push(input);
            return { ...existing, status: "deleted" as const, metadataJson: input.metadataJson };
          },
        },
        resolveRoute: async () => okResolve(),
      },
    );

    expect(result.comment).toMatchObject({ id: commentId, status: "deleted", parentId: existing.metadataJson.parentId });
    expect(deleted[0]).toMatchObject({
      commentId,
      deletedByUserId: "user_1",
      path: "/docs",
      siteId: "site_1",
    });
    expect(audits.at(-1)).toMatchObject({
      action: "page_comment.deleted",
      targetId: commentId,
      targetType: "page_comment",
    });
  });
});

describe("Pages operator releases", () => {
  const base = {
    host: "demo.ravi.page",
    pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456",
    path: "/docs",
    requestId: "req_rel",
  };
  const releaseId = "11111111-1111-4111-8111-111111111111";
  const activeId = "22222222-2222-4222-8222-222222222222";

  test("lists the site's releases with the live one and the current route", async () => {
    const result = await pagesOperatorReleases(
      { ...base, action: "list" },
      {
        authRepository: fakeAuthRepository(),
        resolveRoute: async () => okResolve(),
        listReleases: async (siteId, limit) => {
          expect(siteId).toBe("site_1");
          expect(limit).toBe(30);
          return [];
        },
      },
    );
    expect(result).toEqual({ activeReleaseId: "release_1", currentRoute: { path: "/docs" }, releases: [] });
  });

  test("compares, diffs and restores as the session's user on the session's site", async () => {
    const calls: unknown[] = [];
    const deps = {
      authRepository: fakeAuthRepository(),
      resolveRoute: async () => okResolve(),
      compare: (async (input: unknown) => {
        calls.push(["compare", input]);
        return { routes: [] };
      }) as never,
      fileDiff: (async (input: unknown) => {
        calls.push(["file_diff", input]);
        return { diff: { kind: "binary" } };
      }) as never,
      activate: (async (input: { input: { releaseId: string } }) => {
        calls.push(["restore", input]);
        return { release: { id: input.input.releaseId, releaseNumber: 7 } };
      }) as never,
    };
    await pagesOperatorReleases({ ...base, action: "compare", releaseId }, deps);
    await pagesOperatorReleases(
      { ...base, action: "file_diff", releaseId, baseReleaseId: activeId, routePath: "/", matchType: "spa", file: "index.html" },
      deps,
    );
    const restored = await pagesOperatorReleases({ ...base, action: "restore", releaseId }, deps);

    const context = { actorId: "user_1", actorType: "user", membershipRole: "developer", organizationId: "org_1" };
    expect(calls).toEqual([
      ["compare", { context, input: { siteRef: "site_1", releaseId, baseReleaseId: undefined } }],
      [
        "file_diff",
        {
          context,
          input: { siteRef: "site_1", releaseId, baseReleaseId: activeId, routePath: "/", matchType: "spa", file: "index.html" },
        },
      ],
      ["restore", { context, input: { siteRef: "site_1", releaseId }, requestId: "req_rel" }],
    ]);
    expect(restored).toEqual({ release: { id: releaseId, number: 7 }, previousReleaseId: "release_1" });
  });

  test("names the release author and where the release came from", () => {
    expect(releaseAuthor("user", "Luís", "luis@example.com")).toEqual({ name: "Luís", via: "console" });
    expect(releaseAuthor("cli", null, "luis@example.com")).toEqual({ name: "luis", via: "cli" });
    expect(releaseAuthor("system", "Someone", null)).toEqual({ name: null, via: "system" });
    expect(releaseAuthor("user", "  ", null)).toEqual({ name: null, via: "console" });
  });

  test("rejects release ids that are not uuids before touching releases", async () => {
    await expect(
      pagesOperatorReleases(
        { ...base, action: "restore", releaseId: "../other" },
        { authRepository: fakeAuthRepository(), resolveRoute: async () => okResolve() },
      ),
    ).rejects.toMatchObject({ payload: { error: "invalid_release" } });
  });
});

function fakeAuthRepository(options: { audits?: unknown[] } = {}): PagesPrivateAuthRepository {
  return {
    async transaction() { throw new Error("unexpected_issuance"); },
    async assertBrowserSource() { throw new Error("unexpected_issuance"); },
    async findClaimCodeByHash() { return null; },
    async consumeClaimCode() {
      return null;
    },
    async findOrganizationMembership() {
      return { role: "developer", status: "active" };
    },
    async findSessionByHash() {
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
      };
    },
    async findSiteByHost() {
      return {
        id: "site_1",
        defaultHostname: "demo.ravi.page",
        defaultVisibility: "public",
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

function okResolve(): PagesRouteResolveOkResponse {
  return {
    status: "ok",
    httpStatus: 200,
    artifact: {
      assetBase: "",
      entrypoint: "index.html",
      id: "art_1",
      sha256: null,
      versionId: "ver_1",
      versionNumber: 1,
    },
    cache: {
      control: "no-store",
      mode: "no-store",
    },
    headers: {},
    object: {
      assetId: "asset_1",
      cache: "no-store",
      contentType: "text/html",
      etag: null,
      path: "index.html",
      r2Key: "key",
      sha256: null,
      sizeBytes: 10,
    },
    release: {
      id: "release_1",
      number: 1,
    },
    route: {
      bindingId: "binding_1",
      id: "route_1",
      matchType: "exact",
      path: "/docs",
      visibility: "public",
    },
    site: {
      id: "site_1",
      organizationId: "org_1",
      projectId: "proj_1",
      visibility: "public",
    },
  };
}
