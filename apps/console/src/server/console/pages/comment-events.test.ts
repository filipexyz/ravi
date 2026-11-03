import { describe, expect, test } from "bun:test";

import {
  buildPageCommentCreatedInboxItem,
  emitPageCommentCreated,
  PAGE_COMMENT_CREATED_EVENT_TYPE,
  type PageCommentEventComment,
  type PageCommentEventStore,
} from "./comment-events";
import { cliPublishContextFromAuth } from "./publish";

const comment: PageCommentEventComment = {
  id: "11111111-1111-4111-8111-111111111111",
  body: "Troca o título",
  path: "/weekly",
  organizationId: "org_1",
  projectId: "project_1",
  siteId: "site_1",
  routeId: "route_1",
  routePath: "/weekly",
  releaseId: "release_1",
  artifactVersionId: "version_1",
  parentId: null,
  target: { tag: "h1", selector: "main > h1", text: "Weekly", rect: { x: 1, y: 2, width: 3, height: 4 } },
  createdAt: new Date("2026-10-18T21:00:00.000Z"),
  author: { id: "user_2", displayName: "Ana" },
};

function fakeStore(overrides: Partial<PageCommentEventStore> = {}) {
  const recorded: unknown[] = [];
  const lookups: unknown[] = [];
  const store: PageCommentEventStore = {
    async findComment() {
      return comment;
    },
    async findPublishingInstallation(input) {
      lookups.push(input);
      return "install_1";
    },
    async recordInboxItem(item) {
      recorded.push(item);
      return item;
    },
    ...overrides,
  };
  return { store, recorded, lookups };
}

describe("Page comment inbox events", () => {
  test("a new comment is one page.comment.created item for the publishing installation", async () => {
    const { store, recorded, lookups } = fakeStore();

    const outcome = await emitPageCommentCreated(
      { commentId: comment.id, host: "acme-site.ravi.page", requestId: "req_1" },
      store,
    );

    expect(outcome).toEqual({ status: "recorded", installationId: "install_1" });
    expect(lookups).toEqual([{ artifactVersionId: "version_1", organizationId: "org_1", projectId: "project_1" }]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: PAGE_COMMENT_CREATED_EVENT_TYPE,
      category: "pages",
      sensitivity: "customer_data",
      targetType: "local_installation",
      targetId: "install_1",
      sourceType: "page_comment",
      sourceId: comment.id,
      dedupeKey: `page:comment:org_1:${comment.id}:created:install_1`,
      title: "New comment on /weekly",
      payloadJson: {
        pageId: "site_1",
        siteId: "site_1",
        orgId: "org_1",
        projectId: "project_1",
        path: "/weekly",
        routePath: "/weekly",
        commentId: comment.id,
        parentId: null,
        body: "Troca o título",
        url: "https://acme-site.ravi.page/weekly",
        author: { id: "user_2", displayName: "Ana" },
        target: { tag: "h1", selector: "main > h1", text: "Weekly" },
      },
      linksJson: [{ label: "Page", url: "https://acme-site.ravi.page/weekly" }],
    });
  });

  test("a reply carries its parent and a reply title", () => {
    const item = buildPageCommentCreatedInboxItem({
      comment: { ...comment, parentId: "parent_1" },
      host: "acme-site.ravi.page",
      installationId: "install_1",
    });
    expect(item.title).toBe("New reply on /weekly");
    expect(item.payloadJson).toMatchObject({ parentId: "parent_1" });
  });

  test("the route path comes from the comment's route, not the trailing-slash address", () => {
    const item = buildPageCommentCreatedInboxItem({
      comment: { ...comment, path: "/weekly/", routePath: null },
      host: "acme-site.ravi.page",
      installationId: "install_1",
    });
    expect(item.payloadJson).toMatchObject({ path: "/weekly/", routePath: "/weekly" });
  });

  test("nothing is recorded without a publishing installation", async () => {
    const { store, recorded } = fakeStore({ findPublishingInstallation: async () => null });
    const outcome = await emitPageCommentCreated({ commentId: comment.id, host: "h.ravi.page", requestId: "r" }, store);
    expect(outcome).toEqual({ status: "skipped", reason: "no_publishing_installation" });
    expect(recorded).toHaveLength(0);
  });

  test("nothing is recorded for a comment on a route with no artifact version", async () => {
    const { store, recorded } = fakeStore({ findComment: async () => ({ ...comment, artifactVersionId: null }) });
    const outcome = await emitPageCommentCreated({ commentId: comment.id, host: "h.ravi.page", requestId: "r" }, store);
    expect(outcome).toEqual({ status: "skipped", reason: "no_artifact_version" });
    expect(recorded).toHaveLength(0);
  });

  test("a store failure never reaches the person commenting", async () => {
    const { store } = fakeStore({
      recordInboxItem: async () => {
        throw new Error("db down");
      },
    });
    const outcome = await emitPageCommentCreated({ commentId: comment.id, host: "h.ravi.page", requestId: "r" }, store);
    expect(outcome).toBeNull();
  });

  test("CLI publish context keeps the publishing installation", () => {
    const context = cliPublishContextFromAuth({
      user: { id: "user_1" },
      organization: { id: "org_1" },
      membership: { role: "developer" },
      scopes: [],
      localInstallation: { id: "install_1" },
      cliSession: { id: "session_1" },
      accessTokenJti: "synthetic-jti",
    });
    expect(context.localInstallationId).toBe("install_1");
  });
});
