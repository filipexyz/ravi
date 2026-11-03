import { describe, expect, test } from "bun:test";

import { diffReleaseFiles, diffReleaseRoutes, diffTextLines, isTextDiffable, type ReleaseDiffRouteInput } from "./release-diff";

function route(path: string, artifactVersionId: string, overrides: Partial<ReleaseDiffRouteInput> = {}): ReleaseDiffRouteInput {
  return {
    path,
    matchType: "spa",
    priority: 0,
    artifactId: "art_1",
    artifactVersionId,
    artifactVersionNumber: 1,
    entrypoint: "index.html",
    visibility: "public",
    ...overrides,
  };
}

function file(path: string, sha256: string, mimeType: string | null = "text/html", sizeBytes = 10) {
  return { path, sha256, sizeBytes, mimeType };
}

describe("release diff", () => {
  test("classifies routes and files, and drops a version swap with identical bytes", () => {
    const files: Record<string, ReturnType<typeof file>[]> = {
      v1: [file("index.html", "a"), file("logo.png", "p", "image/png")],
      v2: [file("index.html", "b"), file("new.css", "c", "text/css")],
      v3: [file("index.html", "a"), file("logo.png", "p", "image/png")],
      docs: [file("index.html", "d")],
    };
    const { routes, summary } = diffReleaseRoutes({
      baseRoutes: [route("/", "v1"), route("/same", "v1"), route("/old", "docs"), route("/vis", "docs")],
      targetRoutes: [route("/", "v2"), route("/same", "v3"), route("/new", "docs"), route("/vis", "docs", { visibility: "private" })],
      filesForVersion: (id) => files[id] ?? [],
    });

    expect(routes.map((item) => [item.path, item.status, item.changes])).toEqual([
      ["/", "changed", ["content"]],
      ["/vis", "changed", ["visibility"]],
      ["/new", "added", []],
      ["/old", "removed", []],
      ["/same", "unchanged", []],
    ]);
    expect(routes[0]?.files.map((item) => [item.path, item.status, item.textDiffAvailable])).toEqual([
      ["index.html", "changed", true],
      ["logo.png", "removed", false],
      ["new.css", "added", true],
    ]);
    expect(summary).toEqual({
      routesAdded: 1,
      routesRemoved: 1,
      routesChanged: 2,
      routesUnchanged: 1,
      filesAdded: 2,
      filesRemoved: 2,
      filesChanged: 1,
    });
  });

  test("treats files without a hash as changed", () => {
    const result = diffReleaseFiles([file("a.txt", "")], [file("a.txt", "")]);
    expect(result.files.map((item) => item.status)).toEqual(["changed"]);
  });

  test("only offers text diffs for text-like files under the size limit", () => {
    expect(isTextDiffable(file("index.html", "a", null))).toBe(true);
    expect(isTextDiffable(file("data", "a", "application/json"))).toBe(true);
    expect(isTextDiffable(file("photo.jpg", "a", "image/jpeg"))).toBe(false);
    expect(isTextDiffable(file("big.html", "a", "text/html", 2 * 1024 * 1024))).toBe(false);
    expect(isTextDiffable(file("logo.svg", "a", "image/svg+xml"))).toBe(true);
    expect(isTextDiffable(file("site.webmanifest", "a", "application/manifest+json"))).toBe(true);
    expect(isTextDiffable(file("deck.pptx", "a", "application/vnd.openxmlformats-officedocument.presentationml.presentation"))).toBe(false);
    expect(isTextDiffable(file("clip.ts", "a", "video/mp2t"))).toBe(false);
    expect(isTextDiffable(file("notes.md", "a", "application/octet-stream"))).toBe(true);
  });

  test("builds hunks with context and line numbers", () => {
    const base = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const target = [...base];
    target[1] = "line 2 edited";
    target.splice(15, 1);
    const diff = diffTextLines(`${base.join("\n")}\n`, `${target.join("\r\n")}\r\n`);
    if (diff.kind !== "text") throw new Error("expected text diff");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(2);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]?.lines).toEqual([
      { type: "context", text: "line 1", baseLine: 1, targetLine: 1 },
      { type: "removed", text: "line 2", baseLine: 2, targetLine: null },
      { type: "added", text: "line 2 edited", baseLine: null, targetLine: 2 },
      { type: "context", text: "line 3", baseLine: 3, targetLine: 3 },
      { type: "context", text: "line 4", baseLine: 4, targetLine: 4 },
      { type: "context", text: "line 5", baseLine: 5, targetLine: 5 },
    ]);
    expect(diff.hunks[1]?.lines.map((line) => [line.type, line.baseLine, line.targetLine])).toEqual([
      ["context", 13, 13],
      ["context", 14, 14],
      ["context", 15, 15],
      ["removed", 16, null],
      ["context", 17, 16],
      ["context", 18, 17],
      ["context", 19, 18],
    ]);
  });

  test("reports identical text as no hunks and a new file as all additions", () => {
    expect(diffTextLines("a\nb", "a\nb")).toEqual({ kind: "text", hunks: [], added: 0, removed: 0, truncated: false });
    const created = diffTextLines("", "a\nb\n");
    expect(created).toMatchObject({ kind: "text", added: 2, removed: 0 });
  });

  test("refuses rewrites too large to diff", () => {
    const base = Array.from({ length: 2100 }, (_, index) => `a${index}`).join("\n");
    const target = Array.from({ length: 2100 }, (_, index) => `b${index}`).join("\n");
    expect(diffTextLines(base, target)).toEqual({ kind: "too_large" });
  });
});
