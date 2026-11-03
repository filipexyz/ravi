// Names of the skills that ship with Ravi (the OSS `ravi-system` and
// `ravi-dev` catalogs). A Library item may not take one, so an agent never
// loads an organization's skill where it expects Ravi's own. Keep in sync with
// `src/plugins/internal/*/skills/` in the OSS.
export const RESERVED_LIBRARY_SKILL_SLUGS: ReadonlySet<string> = new Set([
  "agents",
  "apps",
  "architect",
  "artifacts",
  "audio",
  "automation-recipes",
  "bases",
  "channels",
  "commands",
  "connectors",
  "contacts",
  "crm",
  "cron",
  "cross",
  "daemon",
  "events",
  "heartbeat",
  "image",
  "instances",
  "matrix",
  "meetings",
  "observers",
  "pages",
  "permissions",
  "projects",
  "prox-calls",
  "routes",
  "sessions",
  "settings",
  "skill-gates",
  "skills",
  "slack",
  "solucoes",
  "specs",
  "stickers",
  "tag-rules",
  "tasks",
  "tasks-eval",
  "tasks-manager",
  "triggers",
  "video",
  "whatsapp",
  "app-creator",
  "architecture",
  "cli-creator",
  "context-cli",
  "prompt-builder",
  "ravi-rules",
]);

/** Words the Library's routes use after `skills/`, so a bare-slug show never shadows them. */
export const RESERVED_LIBRARY_ROUTE_SLUGS: ReadonlySet<string> = new Set(["proposals"]);

/**
 * Slugs neither kind may take: the words the theme and widget routes use after
 * `themes/` and `widgets/`, and `none` and `default`, which a bare ref reads
 * as "no theme" or the built-in one (`ravi themes use none`, ship `--theme
 * none`, preview `default`) and, for widgets, `none` as "no widget" (`ravi
 * bases views bind <view> none`).
 */
export const RESERVED_KIND_ROUTE_SLUGS: Readonly<Record<"theme" | "widget", ReadonlySet<string>>> = {
  theme: new Set(["active", "default", "none", "check", "proposals"]),
  widget: new Set(["catalog", "check", "preview", "scaffold", "proposals", "none"]),
};

export function isReservedLibrarySlug(slug: string) {
  return RESERVED_LIBRARY_SKILL_SLUGS.has(slug) || RESERVED_LIBRARY_ROUTE_SLUGS.has(slug) || slug.startsWith("ravi-");
}
