import { expect, test } from "bun:test";
import { connectorUsesForOrigin } from "./origin-policy";
import { curatedPlatformUsesSnapshot } from "./catalog";

const metadata = (uses: string[]) => ({ packageManifest: { uses } });
const isolated = { isolated: true };

test("one origin accepts identical effective grants regardless of ordering or duplicate ids", () => {
  const result = connectorUsesForOrigin([
    metadata(["ravi.projects.list", "ravi.pages.theme.get"]),
    metadata(["ravi.projects.list", "ravi.projects.list"]),
  ], isolated);
  expect(result?.uses.map(({ id }) => id).sort()).toEqual(["ravi.pages.theme.get", "ravi.projects.list"]);
});

test("incompatible same-origin actions/revisions fail closed, never union", () => {
  expect(() => connectorUsesForOrigin([metadata([]), metadata(["ravi.bases.views.query"])], isolated))
    .toThrow("connector_origin_grants_conflict");
  expect(() => connectorUsesForOrigin([
    { connectors: { uses: [{ id: "ravi.projects.list", revision: 1 }] } },
    { connectors: { uses: [{ id: "ravi.projects.list", revision: 2 }] } },
  ], isolated)).toThrow("connector_origin_grants_conflict");
});

test("absent has curated effective authority, explicit empty only theme; never conflate", () => {
  expect(connectorUsesForOrigin([{}, {}], isolated)?.uses).toEqual(curatedPlatformUsesSnapshot().uses);
  expect(connectorUsesForOrigin([metadata([]), metadata([])], isolated)?.uses).toEqual([{ id: "ravi.pages.theme.get", revision: 1 }]);
  expect(() => connectorUsesForOrigin([{}, metadata([])], isolated)).toThrow("connector_origin_grants_conflict");
  expect(connectorUsesForOrigin([{}, { connectors: curatedPlatformUsesSnapshot() }], isolated)?.uses)
    .toEqual(curatedPlatformUsesSnapshot().uses);
});

test("missing join, malformed explicit grants and empty active release do not become fallback", () => {
  for (const bad of [[], [null], [{ connectors: {} }], [{ packageManifest: { uses: ["unknown.action"] } }]]) {
    expect(() => connectorUsesForOrigin(bad, isolated)).toThrow("connector_origin_grants_conflict");
  }
});

test("unmodified hosted contract still unions; installation refuses with publish-specific code", () => {
  expect(connectorUsesForOrigin([metadata([]), metadata(["ravi.projects.list"])], { isolated: false })?.uses)
    .toEqual([{ id: "ravi.projects.list", revision: 1 }]);
  expect(() => connectorUsesForOrigin([metadata([]), metadata(["ravi.projects.list"])], {
    isolated: true, status: 409, error: "publish_origin_grants_conflict",
  })).toThrow("publish_origin_grants_conflict");
});
