/**
 * Library refs and authorization ids.
 *
 * spec: skills/library
 *
 *   ref (shown to people)          id (grants and `use:skill:<id>`)
 *   org/<slug>                     org:<slug>
 *   <projectSlug>/<slug>           project:<projectSlug>:<slug>
 *
 * `org` is a reserved project slug in the Console, so the two ref forms never
 * collide. Ids keep their `:` separators and are never slugified, so `org:x`
 * stays distinct from a local skill named `org-x`.
 */

import { basename } from "node:path";
import { listCatalogSkills, slugifySkillName } from "../skills/manager.js";

export const LIBRARY_ORG_SCOPE = "org";
export const LIBRARY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const LIBRARY_ID_PREFIXES = ["org:", "project:"] as const;

export type LibraryScope = "org" | "project";

export interface LibraryRef {
  scope: LibraryScope;
  /** Project slug (or Console id) for project items; null for org items. */
  project: string | null;
  slug: string;
  /** `org/<slug>` or `<project>/<slug>`. */
  ref: string;
  /** `org:<slug>` or `project:<project>:<slug>`. */
  id: string;
}

export function isLibrarySlug(value: string): boolean {
  return LIBRARY_SLUG_PATTERN.test(value);
}

export function libraryRef(scope: LibraryScope, project: string | null, slug: string): LibraryRef {
  if (scope === "org") {
    return { scope, project: null, slug, ref: `${LIBRARY_ORG_SCOPE}/${slug}`, id: `org:${slug}` };
  }
  const projectSlug = project ?? "";
  return { scope, project: projectSlug, slug, ref: `${projectSlug}/${slug}`, id: `project:${projectSlug}:${slug}` };
}

/**
 * Parse a ref (`org/x`, `clinica/x`) or an id (`org:x`, `project:clinica:x`).
 * Returns null for anything else, bare slugs included.
 */
export function parseLibraryRef(input: string | null | undefined): LibraryRef | null {
  const value = input?.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("/")) {
    const parts = value.split("/");
    if (parts.length !== 2) return null;
    const [scope, slug] = parts as [string, string];
    if (!isLibrarySlug(scope) || !isLibrarySlug(slug)) return null;
    return scope === LIBRARY_ORG_SCOPE ? libraryRef("org", null, slug) : libraryRef("project", scope, slug);
  }
  if (value.startsWith("org:")) {
    const slug = value.slice("org:".length);
    return isLibrarySlug(slug) ? libraryRef("org", null, slug) : null;
  }
  if (value.startsWith("project:")) {
    const parts = value.slice("project:".length).split(":");
    if (parts.length !== 2) return null;
    const [project, slug] = parts as [string, string];
    if (project === LIBRARY_ORG_SCOPE || !isLibrarySlug(project) || !isLibrarySlug(slug)) return null;
    return libraryRef("project", project, slug);
  }
  return null;
}

/** Whether the input has the shape of a ref or id, valid or not (it must not be resolved locally). */
export function looksLikeLibraryRef(input: string | null | undefined): boolean {
  const value = input?.trim().toLowerCase() ?? "";
  return value.includes("/") || LIBRARY_ID_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Whether a stored skill name or a `use:skill:<id>` object id is a Library id
 * (wildcards allowed: `org:*`, `project:*`, `project:clinica:*`). Such ids
 * never name a local skill.
 */
export function isLibrarySkillId(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return LIBRARY_ID_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Normalize a Library id or `use:skill:` pattern: lowercase, trimmed, separators kept. */
export function normalizeLibrarySkillId(value: string): string {
  return value.trim().toLowerCase();
}

/** Words the Console's Library routes use after `skills/` (a bare-slug show would never reach such an item). */
const LIBRARY_ROUTE_SLUGS: ReadonlySet<string> = new Set(["proposals"]);

/**
 * Slugs Ravi reserves for its own skills: every catalog skill name and folder
 * name (`ravi-system`, `ravi-dev`), plus the `ravi-` prefix, and the words the
 * Library routes use (`proposals`). Matches the Console's reserved list, which
 * is kept in sync with the catalog.
 */
export function isReservedLibrarySlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  if (normalized.startsWith("ravi-") || LIBRARY_ROUTE_SLUGS.has(normalized)) return true;
  return reservedSlugs().has(normalized);
}

let reservedCache: Set<string> | null = null;

function reservedSlugs(): Set<string> {
  if (reservedCache) return reservedCache;
  const slugs = new Set<string>();
  for (const skill of listCatalogSkills()) {
    slugs.add(slugifySkillName(skill.name));
    const match = /^catalog:[^/]+\/(.+)$/.exec(skill.source);
    slugs.add(slugifySkillName(match?.[1] ?? basename(skill.path)));
  }
  reservedCache = slugs;
  return slugs;
}
