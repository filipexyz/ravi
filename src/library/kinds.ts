/**
 * Library kinds: the URL segment, the files and the copy of each kind this
 * side reads or publishes (spec `console/library`). The Console owns what a
 * kind's files mean; this side only knows which files to send.
 *
 * spec: skills/library
 */

export type LibraryKind = "skill" | "agent" | "theme" | "widget";

/** The kinds published from a folder of fixed files (`ravi themes`, `ravi widgets`). */
export type PresentationKind = "theme" | "widget";

/** URL segment of each kind under `/api/cli/library/`. */
export const LIBRARY_KIND_SEGMENTS: Readonly<Record<LibraryKind, string>> = {
  skill: "skills",
  agent: "agents",
  theme: "themes",
  widget: "widgets",
};

export const LIBRARY_CLI_ROOT = "/api/cli/library";

export function libraryKindPath(kind: LibraryKind): string {
  return `${LIBRARY_CLI_ROOT}/${LIBRARY_KIND_SEGMENTS[kind]}`;
}

export function isPresentationKind(kind: LibraryKind): kind is PresentationKind {
  return kind === "theme" || kind === "widget";
}

/** The kind-specific words of errors and hints; the skill profile keeps the copy `ravi skills` always had. */
export interface LibraryKindProfile {
  kind: LibraryKind;
  /** CLI group: `ravi <group> ...`. */
  group: string;
  /** Singular noun: "skill", "theme", "widget". */
  noun: string;
  notFoundCode: string;
  outOfViewCode: string;
}

export const LIBRARY_KIND_PROFILES: Readonly<Record<"skill" | PresentationKind, LibraryKindProfile>> = {
  skill: {
    kind: "skill",
    group: "skills",
    noun: "skill",
    notFoundCode: "SKILL_NOT_FOUND",
    outOfViewCode: "LIBRARY_SKILL_OUT_OF_VIEW",
  },
  theme: {
    kind: "theme",
    group: "themes",
    noun: "theme",
    notFoundCode: "THEME_NOT_FOUND",
    outOfViewCode: "LIBRARY_OUT_OF_VIEW",
  },
  widget: {
    kind: "widget",
    group: "widgets",
    noun: "widget",
    notFoundCode: "WIDGET_NOT_FOUND",
    outOfViewCode: "LIBRARY_OUT_OF_VIEW",
  },
};

export function libraryKindProfile(kind: LibraryKind | undefined): LibraryKindProfile {
  return kind === "theme" || kind === "widget" ? LIBRARY_KIND_PROFILES[kind] : LIBRARY_KIND_PROFILES.skill;
}

/** The files a theme or widget version holds: the entry, the other required files and the optional ones. */
export interface PresentationFiles {
  entry: string;
  required: readonly string[];
  allowed: readonly string[];
  /** The file that names and describes the item. */
  manifest: string;
}

export const PRESENTATION_FILES: Readonly<Record<PresentationKind, PresentationFiles>> = {
  theme: {
    entry: "theme.json",
    required: ["theme.json"],
    allowed: ["theme.json", "fields.json", "logo.svg", "README.md"],
    manifest: "theme.json",
  },
  widget: {
    entry: "widget.html",
    required: ["widget.html", "widget.json"],
    allowed: ["widget.html", "widget.json", "example.json", "README.md"],
    manifest: "widget.json",
  },
};

/** Words the Console's routes use after `themes/` or `widgets/`: no item of that kind may take them. */
export const PRESENTATION_ROUTE_WORDS: Readonly<Record<PresentationKind, ReadonlySet<string>>> = {
  theme: new Set(["active", "default", "check", "proposals"]),
  widget: new Set(["catalog", "check", "preview", "scaffold", "proposals"]),
};

export function isReservedPresentationSlug(kind: PresentationKind, slug: string): boolean {
  return PRESENTATION_ROUTE_WORDS[kind].has(slug.trim().toLowerCase());
}
