import { expect, test } from "bun:test";

import { releaseChanges, type PageHistoryRoute } from "./history";

function route(id: string, input: Partial<PageHistoryRoute> = {}): PageHistoryRoute {
  return {
    artifactVersionId: `version-${id}`,
    path: `/${id}`,
    routeId: `route-${id}`,
    title: id,
    visibility: "private",
    ...input,
  };
}

test("the host's first release publishes every page", () => {
  expect(releaseChanges([route("b"), route("a")], null)).toEqual([
    { kind: "added", path: "/a", routeId: "route-a", title: "a" },
    { kind: "added", path: "/b", routeId: "route-b", title: "b" },
  ]);
});

test("a release lists only the pages it changed", () => {
  const before = [route("home"), route("agenda"), route("old")];
  const after = [
    route("home"),
    route("agenda", { artifactVersionId: "version-agenda-2" }),
    route("prices"),
  ];
  expect(releaseChanges(after, before)).toEqual([
    { kind: "updated", path: "/agenda", routeId: "route-agenda", title: "agenda" },
    { kind: "removed", path: "/old", routeId: "route-old", title: "old" },
    { kind: "added", path: "/prices", routeId: "route-prices", title: "prices" },
  ]);
});

test("a visibility change is its own change, next to new content", () => {
  const before = [route("prices")];
  const after = [route("prices", { artifactVersionId: "version-prices-2", visibility: "password" })];
  expect(releaseChanges(after, before)).toEqual([
    { kind: "updated", path: "/prices", routeId: "route-prices", title: "prices" },
    { from: "private", kind: "visibility", path: "/prices", routeId: "route-prices", title: "prices", to: "password" },
  ]);
});

test("a release that changed nothing has no changes", () => {
  expect(releaseChanges([route("home")], [route("home")])).toEqual([]);
});
