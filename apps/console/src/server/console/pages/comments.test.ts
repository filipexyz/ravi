import { describe, expect, test } from "bun:test";

import {
  routeCommentKey,
  summarizeCommentRows,
} from "./comments";

describe("Pages comments read state", () => {
  test("summarizes unread route comments after the reader watermark", () => {
    const summaries = summarizeCommentRows({
      routes: [{ siteId: "site_1", path: "/docs" }],
      userId: "user_1",
      limitPerRoute: 20,
      receipts: [
        {
          siteId: "site_1",
          path: "/docs",
          lastReadAt: new Date("2026-07-09T10:00:00.000Z"),
          lastReadCommentCreatedAt: new Date("2026-07-09T10:00:00.000Z"),
        },
      ],
      comments: [
        {
          id: "comment_old",
          body: "Already handled",
          path: "/docs",
          siteId: "site_1",
          routeId: null,
          targetJson: { selector: "main" },
          metadataJson: {},
          createdAt: new Date("2026-07-09T09:00:00.000Z"),
          createdByUserId: "user_2",
          createdByDisplayName: "Thiago",
        },
        {
          id: "comment_own",
          body: "My note",
          path: "/docs",
          siteId: "site_1",
          routeId: null,
          targetJson: { selector: "h1" },
          metadataJson: {},
          createdAt: new Date("2026-07-09T10:30:00.000Z"),
          createdByUserId: "user_1",
          createdByDisplayName: "Luis",
        },
        {
          id: "comment_new",
          body: "Review before publish",
          path: "/docs",
          siteId: "site_1",
          routeId: null,
          targetJson: { selector: "section" },
          metadataJson: { parentId: "comment_old" },
          createdAt: new Date("2026-07-09T11:00:00.000Z"),
          createdByUserId: "user_2",
          createdByDisplayName: "Thiago",
        },
      ],
    });

    const summary = summaries.get(routeCommentKey("site_1", "/docs"));
    expect(summary).toMatchObject({
      openCount: 3,
      unreadCount: 1,
      blockingUnreadCount: 1,
      hasUnread: true,
      lastReadAt: Date.parse("2026-07-09T10:00:00.000Z"),
    });
    expect(summary?.items.map((item) => ({ id: item.id, unread: item.unread, parentId: item.parentId }))).toEqual([
      { id: "comment_old", unread: false, parentId: null },
      { id: "comment_own", unread: false, parentId: null },
      { id: "comment_new", unread: true, parentId: "comment_old" },
    ]);
  });

  test("gathers comments left on the URLs a mounted route serves", () => {
    // The Worker redirects /weekly to /weekly/, so the top bar stores comments there.
    const comment = (id: string, path: string, routeId: string | null, at: string) => ({
      id,
      body: id,
      path,
      siteId: "site_1",
      routeId,
      targetJson: {},
      metadataJson: {},
      createdAt: new Date(at),
      createdByUserId: "user_2",
      createdByDisplayName: "Thiago",
    });
    const summaries = summarizeCommentRows({
      routes: [
        { siteId: "site_1", path: "/", routeId: "route_home" },
        { siteId: "site_1", path: "/weekly", routeId: "route_weekly" },
      ],
      userId: "user_1",
      limitPerRoute: 20,
      receipts: [
        {
          siteId: "site_1",
          path: "/weekly/",
          lastReadAt: new Date("2026-10-18T10:00:00.000Z"),
          lastReadCommentCreatedAt: new Date("2026-10-18T10:00:00.000Z"),
        },
      ],
      comments: [
        comment("on_slash", "/weekly/", "route_weekly", "2026-10-18T09:00:00.000Z"),
        comment("inside", "/weekly/june", "route_weekly", "2026-10-18T11:00:00.000Z"),
        comment("exact_old_route", "/weekly", null, "2026-10-18T12:00:00.000Z"),
        comment("home", "/", "route_home", "2026-10-18T12:30:00.000Z"),
        comment("gone_route", "/old/", "route_gone", "2026-10-18T13:00:00.000Z"),
      ],
    });

    const weekly = summaries.get(routeCommentKey("site_1", "/weekly"));
    expect(weekly?.items.map((item) => ({ id: item.id, unread: item.unread }))).toEqual([
      { id: "on_slash", unread: false },
      { id: "inside", unread: true },
      { id: "exact_old_route", unread: true },
    ]);
    expect(weekly).toMatchObject({ openCount: 3, unreadCount: 2, blockingUnreadCount: 1, hasUnread: true });
    expect(summaries.get(routeCommentKey("site_1", "/"))?.items.map((item) => item.id)).toEqual(["home"]);
  });

  test("a read receipt on the route path covers comments on its other URLs", () => {
    const summaries = summarizeCommentRows({
      routes: [{ siteId: "site_1", path: "/weekly", routeId: "route_weekly" }],
      userId: "user_1",
      limitPerRoute: 20,
      receipts: [
        {
          siteId: "site_1",
          path: "/weekly",
          lastReadAt: new Date("2026-10-18T10:00:00.000Z"),
          lastReadCommentCreatedAt: new Date("2026-10-18T10:00:00.000Z"),
        },
      ],
      comments: [
        {
          id: "on_slash",
          body: "Read already",
          path: "/weekly/",
          siteId: "site_1",
          routeId: "route_weekly",
          targetJson: {},
          metadataJson: {},
          createdAt: new Date("2026-10-18T09:00:00.000Z"),
          createdByUserId: "user_2",
          createdByDisplayName: "Thiago",
        },
      ],
    });

    expect(summaries.get(routeCommentKey("site_1", "/weekly"))).toMatchObject({
      openCount: 1,
      unreadCount: 0,
      hasUnread: false,
      lastReadAt: Date.parse("2026-10-18T10:00:00.000Z"),
    });
  });
});
