/**
 * Console URLs carry the organization: `/<org>` lists its projects,
 * `/<org>/p/<project>/...` opens a project and `/<org>/<section>` opens an
 * organization screen (members, settings, library...). A link copied from one
 * organization keeps opening that organization, whatever the reader last chose.
 *
 * The org in a URL only picks which of the reader's organizations to show;
 * access is still decided by membership on the server.
 *
 * Code inside the Console still speaks in the paths it always used
 * (`/projects`, `/org/<section>`, `/p/<project>/...`), called "app paths" here,
 * and turns them into URLs with `orgPath`. Those app paths keep answering too:
 * they redirect to the URL of the right organization.
 */

/**
 * First URL segments the Console serves itself. An organization whose slug is
 * one of them is addressed by its id instead, so its URLs never collide.
 */
export const CONSOLE_TOP_LEVEL_SEGMENTS: ReadonlySet<string> = new Set([
  // Vercel Workflow routes, generated at build time.
  ".well-known",
  "_next",
  "access",
  "admin",
  "api",
  "bugs",
  "callback",
  "cli",
  "connect",
  "connectors",
  "favicon.ico",
  "github",
  "invite",
  "k",
  "link",
  "login",
  "logout",
  "manage",
  "mcp",
  "monitoring",
  "org",
  "p",
  "projects",
  "robots.txt",
  "shared",
  "setup",
  "sign-in",
  "sign-up",
  "sitemap.xml",
]);

/** Request header the browser sends with the organization of the page it is on. */
export const CONSOLE_ORGANIZATION_HEADER = "x-ravi-org";

/** Query parameter for requests that can't send a header (images, event streams). */
export const CONSOLE_ORGANIZATION_PARAM = "org";

/** The URL segment for an organization: its slug, or its id when the slug is taken by a Console path. */
export function orgSegment(organization: { id: string; slug?: string | null }) {
  const slug = organization.slug?.trim();
  if (slug && isOrgSegmentCandidate(slug)) return slug;
  return organization.id;
}

/** Whether a first URL segment can name an organization. */
export function isOrgSegmentCandidate(segment: string | undefined): segment is string {
  if (!segment) return false;
  if (CONSOLE_TOP_LEVEL_SEGMENTS.has(segment)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment);
}

/** Paths that belong to an organization, as the Console code writes them. */
export function isOrgScopedAppPath(path: string) {
  const pathname = splitPath(path).pathname;
  const [first, second] = pathname.split("/").filter(Boolean);
  if (first === "projects" || first === "p") return true;
  // `/org` alone is the organization picker, which belongs to no organization.
  return first === "org" && Boolean(second);
}

/**
 * The URL of an app path inside an organization. Paths that belong to no
 * organization (`/bugs`, `/connectors`, `/org`) come back unchanged.
 */
export function orgPath(org: string, path: string) {
  const { pathname, suffix } = splitPath(path);
  const parts = pathname.split("/").filter(Boolean);
  const base = `/${encodeURIComponent(org)}`;
  const [first, ...rest] = parts;

  if (first === "projects") {
    // `/projects` is the organization's home; `/projects/new` keeps its name.
    return `${rest.length ? `${base}/projects/${rest.join("/")}` : base}${suffix}`;
  }
  if (first === "p" && rest.length) return `${base}/p/${rest.join("/")}${suffix}`;
  if (first === "org" && rest.length) return `${base}/${rest.join("/")}${suffix}`;
  return path;
}

/**
 * Reads a Console URL: the organization segment it names, if any, and the app
 * path it shows. `/acme/members` is `{ org: "acme", path: "/org/members" }`.
 */
export function parseOrgPath(url: string): { org: string | null; path: string } {
  const { pathname, suffix } = splitPath(url);
  const parts = pathname.split("/").filter(Boolean);
  const [first, second, ...rest] = parts;
  if (!isOrgSegmentCandidate(first)) return { org: null, path: url };

  const org = safeDecode(first);
  if (!second) return { org, path: `/projects${suffix}` };
  if (second === "projects") return { org, path: `/${["projects", ...rest].join("/")}${suffix}` };
  if (second === "p") return { org, path: `/${["p", ...rest].join("/")}${suffix}` };
  return { org, path: `/${["org", second, ...rest].join("/")}${suffix}` };
}

/** The organization a Console URL names, if any. */
export function orgFromPath(url: string) {
  return parseOrgPath(url).org;
}

function splitPath(path: string) {
  const index = path.search(/[?#]/);
  return index === -1
    ? { pathname: path, suffix: "" }
    : { pathname: path.slice(0, index), suffix: path.slice(index) };
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
