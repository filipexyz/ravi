// Shared types of the widgets engine: org themes, widget templates, the
// renderer and the page kit that `ravi pages ship` injects. Isomorphic: the
// Console server, the Console UI and the Pages runtime (`src/pages-runtime`)
// import these. See `.ravi/specs/console/widgets/SPEC.md`.

import type { BaseCellValue, BaseOptionColor, BasePropertyConfig, BasePropertyType, BaseSystemColumn, BaseUserRef } from "@/shared/bases/types";

// ---------------------------------------------------------------------------
// Diagnostics

export type DiagnosticSeverity = "error" | "warning";

export type Diagnostic = {
  severity: DiagnosticSeverity;
  /** Stable UPPER_SNAKE code, e.g. `THEME_CONTRAST`, `TEMPLATE_UNKNOWN_FIELD`. */
  code: string;
  /** English, one sentence, says what to change. */
  message: string;
  /** Library file the diagnostic is about (`theme.json`, `widget.html`, ...) or the page path. */
  file?: string;
  line?: number;
  column?: number;
};

export function hasErrors(diagnostics: readonly Diagnostic[]) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export type LibraryFileText = { path: string; content: string };

// ---------------------------------------------------------------------------
// Fields: types, roles and displays

export const WIDGET_FIELD_TYPES = [
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi_select",
  "status",
  "url",
  "email",
  "phone",
  "person",
  "ref",
] as const satisfies readonly BasePropertyType[];
export type WidgetFieldType = (typeof WIDGET_FIELD_TYPES)[number];

export const FIELD_ROLES = ["image", "avatar", "highlight", "progress", "rating"] as const;
export type FieldRole = (typeof FIELD_ROLES)[number];

/** Widget field types each role accepts. */
export const FIELD_ROLE_TYPES: Record<FieldRole, readonly WidgetFieldType[]> = {
  image: ["url"],
  avatar: ["url", "person"],
  highlight: ["number"],
  progress: ["number"],
  rating: ["number"],
};

/** Display keys by value kind. `currency` and `percent` are numbers by column format. First entry is the default. */
export const FIELD_TYPE_DISPLAYS = {
  status: ["pill", "steps", "text"],
  select: ["pill", "text"],
  multi_select: ["pills", "text"],
  number: ["number", "compact"],
  currency: ["currency", "compact"],
  percent: ["percent", "bar"],
  date: ["date", "relative", "datetime"],
  person: ["avatar-name", "initials", "name"],
  url: ["link", "domain"],
  checkbox: ["check", "yes-no"],
} as const;
export type FieldDisplayKey = keyof typeof FIELD_TYPE_DISPLAYS;

export const FIELD_ROLE_DISPLAYS = {
  image: ["cover", "thumb"],
  avatar: ["circle", "square"],
  highlight: ["big"],
  progress: ["bar", "ring", "percent"],
  rating: ["stars", "number"],
} as const satisfies Record<FieldRole, readonly string[]>;

/** Resolved `fields.json`: every key present, values from the closed lists above. */
export type FieldDisplayRules = {
  types: { [K in FieldDisplayKey]: (typeof FIELD_TYPE_DISPLAYS)[K][number] };
  roles: { [R in FieldRole]: (typeof FIELD_ROLE_DISPLAYS)[R][number] };
};

// ---------------------------------------------------------------------------
// Theme

export type ThemeMode = "light" | "dark";
export type ThemeDensity = "comfortable" | "compact";

export type ContrastCheck = {
  mode: ThemeMode;
  /** Token paths, e.g. `["color.light.text.primary", "color.light.background.primary"]`. */
  pair: [string, string];
  ratio: number;
  min: 3 | 4.5;
  ok: boolean;
};

export type ContrastReport = { ok: boolean; checks: ContrastCheck[] };

export type CompiledTheme = {
  v: 1;
  name: string | null;
  description: string | null;
  /** BCP 47, default `pt-BR`. */
  locale: string;
  density: ThemeDensity;
  /** The `@layer ravi.theme` stylesheet. */
  css: string;
  /** sha256 hex of `css`. */
  hash: string;
  /** CSS custom properties without the layer wrapper: `--name` → value. */
  vars: { base: Record<string, string>; light: Record<string, string>; dark: Record<string, string> };
  fields: FieldDisplayRules;
  /** Sanitized `logo.svg` as a `data:image/svg+xml;base64,` URL, or null. */
  logo: string | null;
  contrast: ContrastReport;
};

// ---------------------------------------------------------------------------
// Widget manifest and compiled template

export const WIDGET_VARIANTS = ["compact", "default", "detail"] as const;
export type WidgetVariant = (typeof WIDGET_VARIANTS)[number];

export type WidgetFieldSpec = {
  type: WidgetFieldType;
  role?: FieldRole;
  required?: boolean;
  label?: string;
  description?: string;
};

export type WidgetManifest = {
  name: string;
  description: string;
  fields: Record<string, WidgetFieldSpec>;
  variants: WidgetVariant[];
};

export const TEMPLATE_FILTERS = ["date", "relative", "currency", "number", "compact", "initials"] as const;
export type TemplateFilter = (typeof TEMPLATE_FILTERS)[number];

export type TemplateAttrValue = { lit: string } | { ref: string[] };

export type TemplateNode =
  | { k: "text"; v: string }
  | { k: "expr"; path: string[]; filters: TemplateFilter[] }
  | { k: "el"; piece: string; attrs: Record<string, TemplateAttrValue>; children: TemplateNode[]; line: number }
  | { k: "if"; path: string[]; not: boolean; then: TemplateNode[]; else: TemplateNode[] }
  | { k: "each"; path: string[]; as: string; children: TemplateNode[] };

export type SetValue =
  | { kind: "status_group"; group: "todo" | "in_progress" | "done" }
  | { kind: "now" }
  | { kind: "today" }
  | { kind: "me" }
  | { kind: "bool"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "literal"; value: string };

export const WIDGET_ACTION_VERBS = ["update", "create", "archive", "open"] as const;
export type WidgetActionVerb = (typeof WIDGET_ACTION_VERBS)[number];

export type WidgetAction = {
  verb: WidgetActionVerb;
  /** Widget field key → value (update, create). */
  set: Record<string, SetValue>;
  /** Field key of the url for `open` with href. */
  href: string | null;
  confirm: boolean;
  /** Visible label text as written (literal part only), for the accessible name. */
  label: string;
};

export type LibraryItemRef = {
  itemId: string;
  /** `org/<slug>` or `<project-slug>/<slug>`. */
  ref: string;
  version: number;
};

export type CompiledWidget = {
  v: 1;
  ref: LibraryItemRef | null;
  name: string;
  description: string;
  fields: Record<string, WidgetFieldSpec>;
  /** Always has `default`. */
  variants: Partial<Record<WidgetVariant, TemplateNode[]>> & { default: TemplateNode[] };
  /** Actions referenced by `ravi-button` `data-ravi-action` indexes. */
  actions: WidgetAction[];
  /**
   * The widget's `widget.js`, when it has one: its sha256 (of the UTF-8 text)
   * and size. The code itself never travels in a compiled widget; the page kit
   * inlines it once per file next to the runtime. Absent in kits shipped
   * before widgets had code.
   */
  script?: WidgetScriptRef | null;
  /** sha256 hex of the canonical JSON of fields + variants + actions (+ the script's sha256 when there is one). */
  hash: string;
};

export type WidgetScriptRef = { sha256: string; bytes: number };

export const WIDGET_SCRIPT_AUDIT_STATUSES = ["pass", "fail"] as const;
export type WidgetScriptAuditStatus = (typeof WIDGET_SCRIPT_AUDIT_STATUSES)[number];

/** One axe-core violation as the audit stores it. */
export type WidgetScriptViolation = { id: string; impact: string | null; help: string; nodes: number };

/**
 * The accessibility audit of a widget version with `widget.js` (JS-CONTRACT J3):
 * axe-core over the card rendered from `example.json` with its script
 * running. `pass` means no `serious` or `critical` violation.
 */
export type WidgetScriptAudit = {
  status: WidgetScriptAuditStatus;
  violations: WidgetScriptViolation[];
  scriptSha256: string;
  auditedBy: string | null;
  auditedAt: string;
};

// ---------------------------------------------------------------------------
// Rendering

export type VNode = string | VElement;
export type VElement = { tag: string; attrs: Record<string, string | true>; children: VNode[] };

export type RenderColumnType = BasePropertyType | BaseSystemColumn | "body";

export type RenderColumn = {
  /** Column key in the view, or the widget field key for static data. */
  key: string;
  name: string;
  type: RenderColumnType;
  config: BasePropertyConfig;
};

/** One record keyed by widget field key (after mapping) or column key (default card). */
export type RenderRecord = {
  id: string | null;
  version: number | null;
  values: Record<string, BaseCellValue | unknown>;
  body?: string | null;
};

export type RenderCapabilities = {
  /** Widget field keys (or column keys for the default card) the viewer may change. */
  write: ReadonlySet<string>;
  create: boolean;
  archive: boolean;
  /** Approval keys (as `write`) the viewer may decide (`describe` `capabilities.approve`). */
  approve?: ReadonlySet<string>;
};

export type RenderContext = {
  locale: string;
  /** IANA zone for instants; date-only values ignore it. */
  timeZone: string;
  now: Date;
  fields: FieldDisplayRules;
  users: Record<string, BaseUserRef>;
  /** By widget field key (or column key for the default card). */
  columns: Record<string, RenderColumn>;
  can: RenderCapabilities;
  variant: WidgetVariant;
  /** Heading level for card titles (2..6). */
  headingLevel: number;
  /** Unique per rendered record, for aria ids. */
  idPrefix: string;
  /** False for previews and ship prerenders: buttons and editors render disabled. */
  interactive: boolean;
  /**
   * Every writable type except person and ref gets an editor (the runtime's
   * table cells). Otherwise only select, status and checkbox do.
   */
  editAll?: boolean;
};

// ---------------------------------------------------------------------------
// Page kit

export const PAGE_KIT_TAGS = ["ravi-view", "ravi-widget", "ravi-form", "ravi-chart"] as const;
export type PageKitTag = (typeof PAGE_KIT_TAGS)[number];

export type KitTheme = {
  ref: LibraryItemRef | null;
  hash: string;
  locale: string;
  density: ThemeDensity;
  /**
   * Display rules for view fields. Only files with tags carry them: the
   * theme-live script of a tagless file never reads them.
   */
  fields?: FieldDisplayRules;
  /** Private route: refresh through `ravi.pages.theme.get`. */
  live: boolean;
};

export type KitInstance = {
  tag: PageKitTag;
  view: string | null;
  /** Key into `PageKit.widgets`, or null for the default card / form. */
  widget: string | null;
  /** Widget field key → view column key. */
  fields: Record<string, string>;
  variant: WidgetVariant;
  /** `ravi-chart`: the chart id. */
  chart?: string | null;
};

/** A Bases id the kit declares for one view (`viewId`) or one chart (`chartId`, `ravi.bases.charts.data`). */
export type KitAction = { id: string; viewId: string; chartId?: undefined } | { id: string; chartId: string; viewId?: undefined };

export type PageKit = {
  v: 1;
  runtime: string;
  locale: string;
  theme: KitTheme | null;
  widgets: Record<string, CompiledWidget>;
  instances: Record<string, KitInstance>;
  actions: KitAction[];
  uses: string[];
};

/** How a ship chose its theme: the effective pointer, an explicit ref, or `none`. */
export type PageThemeSource = "effective" | "explicit" | "none";

export type PagePresentation = {
  v: 1;
  runtime: { version: string; sha256: string } | null;
  theme: (LibraryItemRef & { hash: string }) | null;
  /** Absent on presentations stored before it existed; read those as `effective`. */
  themeSource?: PageThemeSource;
  widgets: LibraryItemRef[];
};

export const OPTION_COLORS: readonly BaseOptionColor[] = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];
