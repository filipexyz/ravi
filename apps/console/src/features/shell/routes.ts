/** Project sections that exist in every project, so switching projects can keep them. */
const PRESERVED_PROJECT_SECTIONS = new Set(["pages", "bases", "library", "meetings", "cloud", "settings"]);

export function projectRefFromPath(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "p" ? parts[1] : undefined;
}

export function projectSectionFromPath(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "p") return undefined;
  return parts[2] ?? "overview";
}

export function projectSwitchHref(pathname: string, nextProjectId: string) {
  const section = projectSectionFromPath(pathname);
  if (section && PRESERVED_PROJECT_SECTIONS.has(section)) return `/p/${nextProjectId}/${section}`;
  return `/p/${nextProjectId}`;
}

/** Organization settings tabs, all under the org's Settings. */
const ORG_SETTINGS_SECTIONS = new Set(["settings", "onboarding", "sso", "credentials", "installations", "permissions", "domains", "github", "connectors", "billing", "audit"]);

export type OrgSection = "projects" | "members" | "library" | "settings";

/** Which organization-level tab a path belongs to, if any. */
export function orgSectionFromPath(pathname: string): OrgSection | undefined {
  const [first, second] = pathname.split("/").filter(Boolean);
  if (first === "projects") return "projects";
  if (first !== "org" || !second) return undefined;
  if (second === "members") return "members";
  if (second === "library") return "library";
  return ORG_SETTINGS_SECTIONS.has(second) ? "settings" : undefined;
}

/** Screens hidden from navigation that still render their legacy view. */
const LEGACY_PROJECT_SECTIONS = new Set(["artifacts", "bridges", "knowledge", "mail", "ravis", "runs"]);
const LEGACY_ORG_SECTIONS = new Set(["channels", "control", "mail", "runs"]);

/**
 * Whether a path under the Console layout renders on the new UI. Only the
 * hidden legacy screens return false, so unknown paths get the new not-found.
 */
export function isRedesignedPath(pathname: string) {
  const [first, second, third] = pathname.split("/").filter(Boolean);
  if (first === "p" && second && third) return !LEGACY_PROJECT_SECTIONS.has(third);
  if (first === "org" && second) return !LEGACY_ORG_SECTIONS.has(second);
  return true;
}

export function isActivePath(pathname: string, href: string, exact = false) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
