import type { PageSiteSummary, PageVisibility, Project, PublishedPageSummary } from "@/features/console/types";

/** The same words the page's top bar uses, in English. */
export const VISIBILITY_LABEL: Record<PageVisibility, string> = {
  password: "Password",
  private: "Private",
  protected_link: "Protected",
  public: "Public",
};

/** The route says Public, but the host default makes it stricter. */
export function cappedByHost(page: Pick<PublishedPageSummary, "visibility" | "effectiveVisibility">) {
  return page.visibility === "public" && page.effectiveVisibility !== "public";
}

/**
 * Who can open a page, in a few words, from what visitors get (the effective
 * visibility). `sharedWith` counts people given this page or all pages by
 * email, when the viewer may see them.
 */
export function whoCanOpen(visibility: PageVisibility, sharedWith = 0) {
  switch (visibility) {
    case "public":
      return "Anyone with the link.";
    case "password":
      return "Anyone with the password. People in this project open it without one.";
    case "private":
    case "protected_link": {
      const people =
        sharedWith === 1 ? " and 1 person you shared it with" : sharedWith > 1 ? ` and ${sharedWith} people you shared it with` : "";
      const protectedNote = visibility === "protected_link" ? " Protected works like Private for now." : "";
      return `People in this project${people}, after signing in.${protectedNote}`;
    }
  }
}

/**
 * Sharing with one person only applies where visitors must sign in. Public
 * pages are already open to everyone, and Password pages keep their password.
 */
export function canShareVisibility(visibility: PageVisibility) {
  return visibility === "private" || visibility === "protected_link";
}

/** What the host default means for the pages set to Public on it. */
export function hostDefaultSentence(hostDefault: PageVisibility) {
  switch (hostDefault) {
    case "public":
      return "Pages set to Public open for anyone with the link.";
    case "password":
      return "Pages set to Public ask for a password.";
    default:
      return "Pages set to Public open only for people in this project. Pages with their own Private, Protected or Password setting keep it.";
  }
}

/** Visibility values the CLI accepts for the host default. */
export type CliVisibility = "public" | "private" | "protected_link";

export function hostDefaultCommand(input: { hostSlug: string; projectSlug: string; visibility: CliVisibility }) {
  return `ravi pages visibility ${input.hostSlug} ${input.visibility} --project ${input.projectSlug} --execute`;
}

/** Opens a page through the Console sign-in, so private pages open and show their top bar. */
export function pageOpenHref(url: string) {
  return `/api/pages/auth/start?returnTo=${encodeURIComponent(url)}`;
}

/** The plain address people send: the first URL the server lists. */
export function pageUrl(page: Pick<PublishedPageSummary, "urls" | "defaultHostname" | "path">) {
  return page.urls[0] ?? `https://${page.defaultHostname}${page.path}`;
}

export function hostUrl(hostname: string) {
  return `https://${hostname}/`;
}

export function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The project's own host first (isDefault), then the rest as the server sorts them. */
export function orderSites(sites: PageSiteSummary[]) {
  return sites
    .filter((site) => site.status !== "deleted")
    .slice()
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** Newest published first; pages published together keep their path order. */
export function orderPages(pages: PublishedPageSummary[]) {
  return pages.slice().sort((a, b) => b.published.at - a.published.at || a.path.localeCompare(b.path));
}

/** A request to give an agent, for a project with nothing published yet. */
export function agentPrompt(project: Pick<Project, "name" | "slug">) {
  return `Publish a page in my Ravi project "${project.name}" (${project.slug}) and send me the link.`;
}

/** Lowercase, without accents, so "relatorio" finds "Relatório". */
export function foldText(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** A pasted link as host and path, without scheme, query, hash or trailing slash. */
function linkKey(value: string) {
  const text = value.trim();
  if (!/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Pages whose title, path or any address matches the search, or that a pasted link opens. */
export function searchPages(pages: PublishedPageSummary[], query: string) {
  const folded = foldText(query);
  if (!folded) return pages;
  const link = linkKey(query);
  if (link) {
    const exact = pages.filter((page) => page.urls.some((url) => linkKey(url) === link));
    if (exact.length) return exact;
  }
  return pages.filter((page) =>
    [page.title, page.path, ...page.urls.map(displayUrl)].some((value) => foldText(value).includes(folded)),
  );
}

export type ShowFilter = "all" | "new-comments" | PageVisibility | `host:${string}`;

export type ShowOption = { value: ShowFilter; label: string; count: number };

/** Whether a page belongs in the list under one "Show" choice. */
export function matchesShow(page: PublishedPageSummary, show: ShowFilter) {
  if (show === "all") return true;
  if (show === "new-comments") return page.comments.hasUnread;
  if (show.startsWith("host:")) return page.siteId === show.slice(5);
  return page.effectiveVisibility === show;
}

/** The "Show" choices with their counts. Choices that match nothing are left out, except All pages. */
export function showOptions(pages: PublishedPageSummary[], sites: PageSiteSummary[]): ShowOption[] {
  const candidates: Array<{ value: ShowFilter; label: string }> = [
    { label: "All pages", value: "all" },
    { label: "New comments", value: "new-comments" },
    { label: "Public", value: "public" },
    { label: "Password", value: "password" },
    { label: "Protected", value: "protected_link" },
    { label: "Private", value: "private" },
  ];
  if (sites.length > 1) {
    for (const site of sites) candidates.push({ label: `On ${site.defaultHostname}`, value: `host:${site.id}` });
  }
  return candidates
    .map((option) => ({ ...option, count: pages.filter((page) => matchesShow(page, option.value)).length }))
    .filter((option) => option.value === "all" || option.count > 0);
}

export function parseShow(value: string | null, options: ShowOption[]): ShowFilter {
  if (!value) return "all";
  return options.some((option) => option.value === value) ? (value as ShowFilter) : "all";
}
