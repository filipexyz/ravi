import { describe, expect, test } from "bun:test";

import {
  findPageRouteConflicts,
  matchPageRoute,
  publicPagesSlugError,
  validateArtifactPackageManifest,
  validateHostedPagesSiteSlug,
  validateManifestFilePath,
  validatePageRouteDefinition,
  validateRoutePath,
  type NormalizedPageRouteDefinition,
} from "./policy";

describe("Ravi Pages hosted slug policy", () => {
  test("accepts DNS-safe hosted site slugs", () => {
    expect(validateHostedPagesSiteSlug("demo-site")).toEqual({
      ok: true,
      slug: "demo-site",
    });
  });

  test("rejects invalid, protected, and conflicting slugs with internal reasons", () => {
    expect(validateHostedPagesSiteSlug("Demo").ok).toBe(false);
    expect(validateHostedPagesSiteSlug("ravi-console")).toMatchObject({
      ok: false,
      reason: "reserved_exact",
      publicError: "slug_unavailable",
    });
    expect(validateHostedPagesSiteSlug("ravi-demo")).toMatchObject({
      ok: false,
      reason: "reserved_prefix",
      publicError: "slug_unavailable",
    });
    expect(validateHostedPagesSiteSlug("demo", { existingSlugs: ["demo"] })).toMatchObject({
      ok: false,
      reason: "namespace_conflict",
      publicError: "slug_unavailable",
    });
  });

  test("keeps public slug errors coarse", () => {
    expect(publicPagesSlugError()).toEqual({
      error: "slug_unavailable",
      fieldErrors: {
        slug: "This slug is unavailable.",
      },
    });
  });
});

describe("Ravi Pages route path policy", () => {
  test("normalizes leading slashes and deterministic trailing slashes", () => {
    expect(validateRoutePath("pitch/")).toEqual({
      ok: true,
      path: "/pitch",
    });
    expect(validateRoutePath("/")).toEqual({
      ok: true,
      path: "/",
    });
  });

  test("rejects unsafe route paths with coarse public errors", () => {
    expect(validateRoutePath("/_ravi/assets")).toMatchObject({
      ok: false,
      reason: "reserved_runtime_namespace",
      publicError: "route_invalid",
    });
    expect(validateRoutePath("/pitch/%2e%2e/secrets")).toMatchObject({
      ok: false,
      reason: "dot_segment",
      publicError: "route_invalid",
    });
    expect(validateRoutePath("/.well-known")).toMatchObject({
      ok: false,
      reason: "leading_dot_segment",
      publicError: "route_invalid",
    });
    expect(validateRoutePath("/pitch//assets")).toMatchObject({
      ok: false,
      reason: "empty_segment",
      publicError: "route_invalid",
    });
    expect(validateRoutePath("/pitch?debug=1")).toMatchObject({
      ok: false,
      reason: "query_or_fragment",
      publicError: "route_invalid",
    });
    expect(validateRoutePath("")).toMatchObject({
      ok: false,
      reason: "missing",
      publicError: "route_invalid",
    });
  });

  test("validates route matching definitions", () => {
    expect(validatePageRouteDefinition({ path: "app", matchType: "spa", priority: 10 })).toEqual({
      ok: true,
      route: {
        path: "/app",
        matchType: "spa",
        priority: 10,
      },
    });
    expect(validatePageRouteDefinition({ path: "/app", matchType: "wildcard" })).toMatchObject({
      ok: false,
      reason: "invalid_match_type",
      publicError: "route_invalid",
    });
  });
});

describe("Ravi Pages route conflict helpers", () => {
  test("detects ambiguous exact, prefix, and spa route ties", () => {
    const routes: NormalizedPageRouteDefinition[] = [
      { path: "/app", matchType: "exact", priority: 0 },
      { path: "/app", matchType: "spa", priority: 0 },
      { path: "/docs", matchType: "prefix", priority: 1 },
      { path: "/docs", matchType: "prefix", priority: 1 },
    ];

    expect(findPageRouteConflicts(routes)).toHaveLength(2);
  });

  test("allows deterministic priority and specificity ordering", () => {
    const routes: NormalizedPageRouteDefinition[] = [
      { path: "/", matchType: "spa", priority: 0 },
      { path: "/pitch", matchType: "prefix", priority: 0 },
      { path: "/pitch/special", matchType: "exact", priority: 0 },
      { path: "/pitch", matchType: "exact", priority: 5 },
    ];

    expect(findPageRouteConflicts(routes)).toHaveLength(0);
    expect(matchPageRoute(routes, "/pitch")).toMatchObject({
      path: "/pitch",
      matchType: "exact",
      priority: 5,
    });
    expect(matchPageRoute(routes, "/pitch/assets/app.js")).toMatchObject({
      path: "/pitch",
      matchType: "prefix",
      priority: 0,
    });
  });
});

describe("Ravi Pages artifact package manifest policy", () => {
  test("accepts normalized package file paths", () => {
    expect(validateManifestFilePath("assets/app.js")).toEqual({
      ok: true,
      path: "assets/app.js",
    });
  });

  test("rejects package file path traversal attempts", () => {
    expect(validateManifestFilePath("../secret.txt")).toMatchObject({
      ok: false,
      reason: "dot_segment",
      publicError: "publish_validation_failed",
    });
    expect(validateManifestFilePath("assets/%2e%2e/secret.txt")).toMatchObject({
      ok: false,
      reason: "dot_segment",
    });
    expect(validateManifestFilePath("/index.html")).toMatchObject({
      ok: false,
      reason: "absolute_path",
    });
    expect(validateManifestFilePath("_ravi/assets/app.js")).toMatchObject({
      ok: false,
      reason: "reserved_runtime_namespace",
    });
    expect(validateManifestFilePath(".well-known/security.txt")).toMatchObject({
      ok: false,
      reason: "leading_dot_segment",
    });
  });

  test("validates entrypoint membership in package manifests", () => {
    expect(
      validateArtifactPackageManifest({
        entrypoint: "index.html",
        files: [{ path: "index.html" }, { path: "assets/app.js" }],
      }),
    ).toEqual({
      ok: true,
      entrypoint: "index.html",
      files: ["index.html", "assets/app.js"],
    });

    expect(
      validateArtifactPackageManifest({
        entrypoint: "index.html",
        files: [{ path: "assets/app.js" }],
      }),
    ).toMatchObject({
      ok: false,
      reason: "entrypoint_missing",
      publicError: "publish_validation_failed",
    });
  });
});
