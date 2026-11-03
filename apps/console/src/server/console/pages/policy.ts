import {
  validateSlugPolicy,
  type SlugRejectionReason,
  type SlugValidationResult,
} from "@/server/console/slug-policy";

export type PageRouteMatchType = "exact" | "prefix" | "spa";
export type RoutePathRejectionReason =
  | "missing"
  | "invalid_type"
  | "invalid_encoding"
  | "query_or_fragment"
  | "empty_segment"
  | "dot_segment"
  | "leading_dot_segment"
  | "reserved_runtime_namespace";
export type ManifestPathRejectionReason =
  | "missing"
  | "invalid_type"
  | "invalid_encoding"
  | "absolute_path"
  | "query_or_fragment"
  | "empty_segment"
  | "dot_segment"
  | "leading_dot_segment"
  | "reserved_runtime_namespace"
  | "path_separator"
  | "control_character";
export type RouteDefinitionRejectionReason =
  | RoutePathRejectionReason
  | "invalid_match_type"
  | "invalid_priority";

export type PublicRouteErrorCode = "route_invalid";
export type PublicManifestErrorCode = "publish_validation_failed";

export type RoutePathValidationResult =
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      reason: RoutePathRejectionReason;
      publicError: PublicRouteErrorCode;
    };

export type ManifestPathValidationResult =
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      reason: ManifestPathRejectionReason;
      publicError: PublicManifestErrorCode;
    };

export type PageRouteDefinitionInput = {
  id?: string;
  path: unknown;
  matchType: unknown;
  priority?: unknown;
};

export type NormalizedPageRouteDefinition = {
  id?: string;
  path: string;
  matchType: PageRouteMatchType;
  priority: number;
};

export type RouteDefinitionValidationResult =
  | {
      ok: true;
      route: NormalizedPageRouteDefinition;
    }
  | {
      ok: false;
      reason: RouteDefinitionRejectionReason;
      publicError: PublicRouteErrorCode;
    };

export type PageRouteConflict = {
  reason: "ambiguous_route_tie";
  routes: [NormalizedPageRouteDefinition, NormalizedPageRouteDefinition];
};

export type ArtifactPackageManifestFile = {
  path: unknown;
};

export type ArtifactPackageManifestInput = {
  entrypoint?: unknown;
  files?: unknown;
};

export type ArtifactPackageManifestValidationResult =
  | {
      ok: true;
      entrypoint: string;
      files: string[];
    }
  | {
      ok: false;
      reason: ManifestPathRejectionReason | "invalid_files" | "entrypoint_missing";
      publicError: PublicManifestErrorCode;
      path?: unknown;
    };

export function validateHostedPagesSiteSlug(
  slug: string | undefined,
  options: { existingSlugs?: Iterable<string> } = {},
): SlugValidationResult {
  return validateSlugPolicy(slug, {
    dnsLabel: true,
    existingSlugs: options.existingSlugs,
  });
}

export function publicPagesSlugError() {
  return {
    error: "slug_unavailable",
    fieldErrors: {
      slug: "This slug is unavailable.",
    },
  } as const;
}

export function validateRoutePath(path: unknown): RoutePathValidationResult {
  if (typeof path !== "string") {
    return routePathFailure(path === undefined || path === null ? "missing" : "invalid_type");
  }

  const trimmedPath = path.trim();
  if (!trimmedPath) return routePathFailure("missing");

  const normalized = normalizeLeadingSlash(trimmedPath);
  if (normalized.includes("?") || normalized.includes("#")) return routePathFailure("query_or_fragment");

  const decoded = decodePath(normalized);
  if (!decoded.ok) return routePathFailure("invalid_encoding");

  const withoutTrailingSlash = decoded.path === "/" ? "/" : decoded.path.replace(/\/+$/g, "");
  const segments = withoutTrailingSlash.split("/");
  if (
    withoutTrailingSlash !== "/" &&
    segments.length > 1 &&
    segments.some((segment, index) => index > 0 && segment.length === 0)
  ) {
    return routePathFailure("empty_segment");
  }
  const contentSegments = segments.slice(1);
  if (contentSegments.some((segment) => segment === "." || segment === "..")) return routePathFailure("dot_segment");
  if (contentSegments.some((segment) => segment.startsWith("."))) return routePathFailure("leading_dot_segment");
  if (withoutTrailingSlash === "/_ravi" || withoutTrailingSlash.startsWith("/_ravi/")) {
    return routePathFailure("reserved_runtime_namespace");
  }

  return {
    ok: true,
    path: withoutTrailingSlash,
  };
}

export function validatePageRouteDefinition(input: PageRouteDefinitionInput): RouteDefinitionValidationResult {
  const path = validateRoutePath(input.path);
  if (!path.ok) return routeDefinitionFailure(path.reason);

  if (!isPageRouteMatchType(input.matchType)) return routeDefinitionFailure("invalid_match_type");

  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || typeof priority !== "number") return routeDefinitionFailure("invalid_priority");

  return {
    ok: true,
    route: {
      id: input.id,
      path: path.path,
      matchType: input.matchType,
      priority,
    },
  };
}

export function normalizePageRouteDefinitions(
  inputs: PageRouteDefinitionInput[],
): RouteDefinitionValidationResult[] {
  return inputs.map((input) => validatePageRouteDefinition(input));
}

export function findPageRouteConflicts(routes: NormalizedPageRouteDefinition[]): PageRouteConflict[] {
  const conflicts: PageRouteConflict[] = [];

  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const left = routes[leftIndex];
      const right = routes[rightIndex];
      if (!left || !right) continue;
      if (left.priority !== right.priority) continue;
      if (left.path.length !== right.path.length) continue;
      if (!routesCanBothMatchSameRequest(left, right)) continue;

      conflicts.push({
        reason: "ambiguous_route_tie",
        routes: [left, right],
      });
    }
  }

  return conflicts;
}

export function matchPageRoute(
  routes: NormalizedPageRouteDefinition[],
  requestPath: unknown,
): NormalizedPageRouteDefinition | null {
  const normalizedRequest = validateRoutePath(requestPath);
  if (!normalizedRequest.ok) return null;

  const matches = routes.filter((route) => routeMatchesPath(route, normalizedRequest.path));
  matches.sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    return right.path.length - left.path.length;
  });

  return matches[0] ?? null;
}

export function validateManifestFilePath(path: unknown): ManifestPathValidationResult {
  if (typeof path !== "string" || path.length === 0) {
    return manifestPathFailure(path === undefined || path === null || path === "" ? "missing" : "invalid_type");
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return manifestPathFailure("control_character");
  if (path.includes("\\")) return manifestPathFailure("path_separator");
  if (path.startsWith("/")) return manifestPathFailure("absolute_path");
  if (path.includes("?") || path.includes("#")) return manifestPathFailure("query_or_fragment");

  const decoded = decodePath(path);
  if (!decoded.ok) return manifestPathFailure("invalid_encoding");
  if (decoded.path.startsWith("/")) return manifestPathFailure("absolute_path");

  const segments = decoded.path.split("/");
  if (segments.some((segment) => segment.length === 0)) return manifestPathFailure("empty_segment");
  if (segments.some((segment) => segment === "." || segment === "..")) return manifestPathFailure("dot_segment");
  if (segments.some((segment) => segment.startsWith("."))) return manifestPathFailure("leading_dot_segment");
  if (segments[0] === "_ravi") return manifestPathFailure("reserved_runtime_namespace");

  return {
    ok: true,
    path: decoded.path,
  };
}

export function validateArtifactPackageManifest(
  manifest: ArtifactPackageManifestInput,
): ArtifactPackageManifestValidationResult {
  const entrypoint = validateManifestFilePath(manifest.entrypoint);
  if (!entrypoint.ok) {
    return {
      ok: false,
      reason: entrypoint.reason,
      publicError: "publish_validation_failed",
      path: manifest.entrypoint,
    };
  }

  if (!Array.isArray(manifest.files)) {
    return {
      ok: false,
      reason: "invalid_files",
      publicError: "publish_validation_failed",
    };
  }

  const files: string[] = [];
  for (const file of manifest.files) {
    const rawPath = readManifestFilePath(file);
    const result = validateManifestFilePath(rawPath);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        publicError: "publish_validation_failed",
        path: rawPath,
      };
    }
    files.push(result.path);
  }

  if (!files.includes(entrypoint.path)) {
    return {
      ok: false,
      reason: "entrypoint_missing",
      publicError: "publish_validation_failed",
      path: entrypoint.path,
    };
  }

  return {
    ok: true,
    entrypoint: entrypoint.path,
    files,
  };
}

function routePathFailure(reason: RoutePathRejectionReason): RoutePathValidationResult {
  return {
    ok: false,
    reason,
    publicError: "route_invalid",
  };
}

function routeDefinitionFailure(reason: RouteDefinitionRejectionReason): RouteDefinitionValidationResult {
  return {
    ok: false,
    reason,
    publicError: "route_invalid",
  };
}

function manifestPathFailure(reason: ManifestPathRejectionReason): ManifestPathValidationResult {
  return {
    ok: false,
    reason,
    publicError: "publish_validation_failed",
  };
}

function normalizeLeadingSlash(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

function decodePath(path: string): { ok: true; path: string } | { ok: false } {
  try {
    return {
      ok: true,
      path: decodeURIComponent(path),
    };
  } catch {
    return { ok: false };
  }
}

// The root route owns the whole host, so an SPA fallback there would turn every
// unknown path (typos, `/report;`, removed pages) into the home page. Unknown
// paths on the root route are 404; non-root SPA mounts keep their fallback.
export function pageRouteSpaFallbackApplies(route: { path: string; matchType: PageRouteMatchType }) {
  return route.matchType === "spa" && route.path !== "/";
}

function isPageRouteMatchType(value: unknown): value is PageRouteMatchType {
  return value === "exact" || value === "prefix" || value === "spa";
}

function routeMatchesPath(route: NormalizedPageRouteDefinition, requestPath: string) {
  if (route.matchType === "exact") return requestPath === route.path;
  if (route.path === "/") return true;
  return requestPath === route.path || requestPath.startsWith(`${route.path}/`);
}

function routesCanBothMatchSameRequest(
  left: NormalizedPageRouteDefinition,
  right: NormalizedPageRouteDefinition,
) {
  if (left.path === right.path) return true;
  return routeCanMatchPath(left, right.path) || routeCanMatchPath(right, left.path);
}

function routeCanMatchPath(route: NormalizedPageRouteDefinition, path: string) {
  if (route.matchType === "exact") return route.path === path;
  if (route.path === "/") return true;
  return path === route.path || path.startsWith(`${route.path}/`);
}

function readManifestFilePath(file: unknown) {
  if (!file || typeof file !== "object") return undefined;
  return (file as ArtifactPackageManifestFile).path;
}

export type { SlugRejectionReason };
